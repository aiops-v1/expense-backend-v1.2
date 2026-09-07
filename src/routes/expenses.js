const express = require('express');
const { trace } = require('@opentelemetry/api');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { bindRouteLogger } = require('../middleware/requestLogger');
const { expensesCreatedTotal, expenseAmountRupeesTotal } = require('../metrics');
const flags = require('../debugFlags');

const router = express.Router();
const tracer = trace.getTracer('expense-backend');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

async function categoryIsUsable(categoryId, userId) {
  const category = await getUsableCategory(categoryId, userId);
  return Boolean(category);
}

async function getUsableCategory(categoryId, userId) {
  const [rows] = await pool.query(
    'SELECT id, name FROM categories WHERE id = ? AND (user_id IS NULL OR user_id = ?)',
    [categoryId, userId]
  );
  return rows[0] || null;
}

function validateExpensePayload(body) {
  const { amount, categoryId, description, expenseDate } = body || {};

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return 'amount must be a positive number';
  }
  if (!Number.isInteger(categoryId)) {
    return 'categoryId must be an integer';
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 255) {
      return 'description must be a string of at most 255 characters';
    }
  }
  if (!isValidDateString(expenseDate)) {
    return 'expenseDate must be a valid date in YYYY-MM-DD format';
  }
  return null;
}

router.get('/summary', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const [[totals]] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS totalSpent, COUNT(*) AS count FROM expenses WHERE user_id = ?',
      [req.user.id]
    );

    const [breakdown] = await pool.query(
      `SELECT c.id AS categoryId, c.name, c.icon_key AS iconKey, c.color_hex AS colorHex,
              COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
       WHERE e.user_id = ?
       GROUP BY c.id, c.name, c.icon_key, c.color_hex
       ORDER BY total DESC`,
      [req.user.id]
    );

    const totalSpent = Number(totals.totalSpent);
    res.json({
      balance: -totalSpent,
      totalSpent,
      expenseCount: totals.count,
      categoryBreakdown: breakdown.map((row) => ({ ...row, total: Number(row.total) })),
    });
  } catch (err) {
    next(err);
  }
});

// The normal, efficient path: one
// query, a JOIN does the category lookup server-side.
async function listExpensesEfficient(userId, sort, pageSize, offset) {
  const [rows] = await pool.query(
    `SELECT e.id, e.amount, e.description, e.expense_date AS expenseDate, e.created_at AS createdAt,
            c.id AS categoryId, c.name AS categoryName, c.icon_key AS categoryIconKey, c.color_hex AS categoryColorHex
     FROM expenses e
     JOIN categories c ON c.id = e.category_id
     WHERE e.user_id = ?
     ORDER BY e.expense_date ${sort}, e.id ${sort}
     LIMIT ? OFFSET ?`,
    [userId, pageSize, offset]
  );
  return rows;
}

// The deliberately inefficient path, only ever reached with
// flags.nPlusOne === true (toggled via POST /debug/inject/n-plus-one) — one
// query to list expenses, then one *more* query per expense to fetch its
// category, instead of the single JOIN above. Exists permanently in the
// codebase; inert unless the flag is on.
async function listExpensesNPlusOne(userId, sort, pageSize, offset) {
  const [expenseRows] = await pool.query(
    `SELECT id, amount, description, expense_date AS expenseDate, created_at AS createdAt,
            category_id AS categoryId
     FROM expenses
     WHERE user_id = ?
     ORDER BY expense_date ${sort}, id ${sort}
     LIMIT ? OFFSET ?`,
    [userId, pageSize, offset]
  );

  const rows = [];
  for (const expense of expenseRows) {
    const [[category]] = await pool.query(
      'SELECT id AS categoryId, name AS categoryName, icon_key AS categoryIconKey, color_hex AS categoryColorHex FROM categories WHERE id = ?',
      [expense.categoryId]
    );
    rows.push({ ...expense, ...category });
  }
  return rows;
}

router.get('/', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));
    const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * pageSize;

    const rows = flags.nPlusOne
      ? await listExpensesNPlusOne(req.user.id, sort, pageSize, offset)
      : await listExpensesEfficient(req.user.id, sort, pageSize, offset);

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM expenses WHERE user_id = ?',
      [req.user.id]
    );

    res.json({
      items: rows.map((r) => ({ ...r, amount: Number(r.amount) })),
      page,
      pageSize,
      total,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const validationError = validateExpensePayload(req.body);
    if (validationError) {
      req.log.warn({ reason: validationError }, 'expense create rejected');
      return res.status(400).json({ error: validationError });
    }

    const { amount, categoryId, description, expenseDate } = req.body;

    const category = await getUsableCategory(categoryId, req.user.id);
    if (!category) {
      req.log.warn({ reason: 'invalid_category', categoryId }, 'expense create rejected');
      return res.status(400).json({ error: 'categoryId does not belong to you or a system default' });
    }

    // A manual span around just the business logic — gives the trace a
    // "create expense" node to read, distinct from the generic HTTP/DB spans
    // auto-instrumentation already provides around it.
    const result = await tracer.startActiveSpan('create-expense', async (span) => {
      span.setAttribute('category_name', category.name);
      span.setAttribute('amount', amount);
      try {
        const [insertResult] = await pool.query(
          'INSERT INTO expenses (user_id, category_id, amount, description, expense_date) VALUES (?, ?, ?, ?, ?)',
          [req.user.id, categoryId, amount, description || null, expenseDate]
        );
        return insertResult;
      } finally {
        span.end();
      }
    });

    expensesCreatedTotal.inc({ category_name: category.name });
    expenseAmountRupeesTotal.inc({ category_name: category.name }, amount);
    req.log.info({ expense_id: result.insertId, category: category.name, amount }, 'expense created');

    res.status(201).json({
      id: result.insertId,
      userId: req.user.id,
      categoryId,
      amount,
      description: description || null,
      expenseDate,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense id' });

    const validationError = validateExpensePayload(req.body);
    if (validationError) {
      req.log.warn({ reason: validationError }, 'expense update rejected');
      return res.status(400).json({ error: validationError });
    }

    const { amount, categoryId, description, expenseDate } = req.body;

    if (!(await categoryIsUsable(categoryId, req.user.id))) {
      req.log.warn({ reason: 'invalid_category', categoryId }, 'expense update rejected');
      return res.status(400).json({ error: 'categoryId does not belong to you or a system default' });
    }

    const [result] = await pool.query(
      'UPDATE expenses SET amount = ?, category_id = ?, description = ?, expense_date = ? WHERE id = ? AND user_id = ?',
      [amount, categoryId, description || null, expenseDate, id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    req.log.info({ expense_id: id }, 'expense updated');
    res.json({ id, userId: req.user.id, categoryId, amount, description: description || null, expenseDate });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense id' });

    const [result] = await pool.query('DELETE FROM expenses WHERE id = ? AND user_id = ?', [id, req.user.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    req.log.info({ expense_id: id }, 'expense deleted');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
