const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const pool = require('../db');
const { requireAuth, COOKIE_NAME, AUTH_MODE } = require('../middleware/auth');
const { bindRouteLogger } = require('../middleware/requestLogger');
const { usersRegisteredTotal, userLoginsTotal } = require('../metrics');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

// The one manual span in this codebase — everywhere else,
// getNodeAutoInstrumentations() (tracing.js) covers http/express/mysql2
// without a line of app code. bcrypt isn't a library OTel knows how to
// instrument, so its cost (the reason /auth/signup and /auth/signin are
// this app's slowest routes) would otherwise show up as unexplained silence
// inside the route handler's own span — confirmed live: a real signup trace
// showed ~356ms of its 365ms handler span with no child span accounting for
// it at all. This closes that gap instead of just documenting it.
const tracer = trace.getTracer('expense-backend');
async function withBcryptSpan(name, fn) {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('bcrypt.rounds', BCRYPT_ROUNDS);
    try {
      return await fn();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function sendSession(req, res, user, status) {
  const token = signToken(user);
  if (AUTH_MODE === 'cookie') {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.status(status).json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
    });
  }
  return res.status(status).json({
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name },
  });
}

router.post('/signup', bindRouteLogger, async (req, res, next) => {
  try {
    const { email, password, displayName } = req.body || {};

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      req.log.warn({ reason: 'invalid_email' }, 'signup failed');
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      req.log.warn({ reason: 'weak_password' }, 'signup failed');
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      req.log.warn({ reason: 'missing_display_name' }, 'signup failed');
      return res.status(400).json({ error: 'Display name is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing.length > 0) {
      req.log.warn({ reason: 'email_exists' }, 'signup failed');
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await withBcryptSpan('bcrypt.hash', () =>
      bcrypt.hash(password, BCRYPT_ROUNDS)
    );
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      [normalizedEmail, passwordHash, displayName.trim()]
    );

    const user = { id: result.insertId, email: normalizedEmail, display_name: displayName.trim() };
    usersRegisteredTotal.inc();
    req.log = req.log.child({ user_id: user.id });
    req.log.info('signup succeeded');
    return sendSession(req, res, user, 201);
  } catch (err) {
    next(err);
  }
});

router.post('/signin', bindRouteLogger, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      req.log.warn({ reason: 'missing_credentials' }, 'signin failed');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    const user = rows[0];
    if (!user) {
      req.log.warn({ reason: 'invalid_credentials', email: normalizedEmail }, 'signin failed');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await withBcryptSpan('bcrypt.compare', () =>
      bcrypt.compare(password, user.password_hash)
    );
    if (!match) {
      req.log.warn({ reason: 'invalid_credentials', email: normalizedEmail }, 'signin failed');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    userLoginsTotal.inc();
    req.log = req.log.child({ user_id: user.id });
    req.log.info('signin succeeded');
    return sendSession(req, res, user, 200);
  } catch (err) {
    next(err);
  }
});

router.post('/signout', bindRouteLogger, (req, res) => {
  if (AUTH_MODE === 'cookie') {
    res.clearCookie(COOKIE_NAME);
  }
  res.status(204).end();
});

router.get('/me', bindRouteLogger, requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, display_name FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    res.json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
