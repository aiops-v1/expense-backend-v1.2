const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { bindRouteLogger } = require('../middleware/requestLogger');

const router = express.Router();

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

router.get('/', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, user_id AS userId, name, icon_key AS iconKey, color_hex AS colorHex ' +
        'FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY user_id IS NULL DESC, name ASC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const { name, iconKey, colorHex } = req.body || {};

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
      return res.status(400).json({ error: 'Category name is required (max 100 chars)' });
    }
    if (typeof iconKey !== 'string' || iconKey.trim().length === 0) {
      return res.status(400).json({ error: 'iconKey is required' });
    }
    if (typeof colorHex !== 'string' || !HEX_COLOR_RE.test(colorHex)) {
      return res.status(400).json({ error: 'colorHex must be a hex color like #A1B2C3' });
    }

    const [result] = await pool.query(
      'INSERT INTO categories (user_id, name, icon_key, color_hex) VALUES (?, ?, ?, ?)',
      [req.user.id, name.trim(), iconKey.trim(), colorHex]
    );

    res.status(201).json({
      id: result.insertId,
      userId: req.user.id,
      name: name.trim(),
      iconKey: iconKey.trim(),
      colorHex,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
