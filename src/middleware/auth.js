const jwt = require('jsonwebtoken');
const { trace } = require('@opentelemetry/api');

const AUTH_MODE = process.env.AUTH_MODE || 'cookie';
const COOKIE_NAME = 'expense_token';

function extractToken(req) {
  if (AUTH_MODE === 'cookie') {
    return req.cookies ? req.cookies[COOKIE_NAME] : undefined;
  }
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return undefined;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    req.log = req.log.child({ user_id: req.user.id });
    // High-cardinality-safe on a span attribute, unlike a Prometheus label —
    // this is the whole reason user_id lives here instead of on a metric.
    const span = trace.getActiveSpan();
    if (span) span.setAttribute('user_id', req.user.id);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireAuth, extractToken, COOKIE_NAME, AUTH_MODE };
