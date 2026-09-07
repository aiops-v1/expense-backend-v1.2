const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/categories');
const expenseRoutes = require('./routes/expenses');
const { register, httpMetricsMiddleware } = require('./metrics');
const { busyLoopMiddleware, timeoutMiddleware } = require('./middleware/debugInjections');
const {
  httpLogger,
  baseLogContext,
  bindRouteLogger,
  requestCompletionLogger,
} = require('./middleware/requestLogger');

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true,
  })
);
// Logging and metrics infrastructure runs BEFORE body/cookie parsing,
// deliberately: express.json() throws on a malformed request body, and
// when it does, Express skips every remaining app.use() in registration
// order and jumps straight to the error handler at the bottom of this
// file — anything not yet registered by then simply never runs for that
// request. That used to include this whole block, which meant a malformed
// body produced a real 500 that was invisible to http_requests_total (the
// finish-listener in httpMetricsMiddleware never got attached) AND crashed
// the error handler itself a second time (req.log was never set, since
// httpLogger/baseLogContext hadn't run either — req.log.error() on
// undefined). Registering these first means their res.on('finish', ...)
// listeners (metrics, completion logging) and req.log are already in place
// no matter what happens downstream, including inside the error handler.
app.use(httpLogger);
app.use(baseLogContext);
app.use(requestCompletionLogger);
app.use(httpMetricsMiddleware);
app.use(express.json());
app.use(cookieParser());

app.get('/health', bindRouteLogger, (req, res) => res.json({ status: 'ok' }));

// Unauthenticated by design — Prometheus scrapes this without a JWT. Not
// safe for the public internet; keep it off any public ingress/network ACL.
app.get('/metrics', bindRouteLogger, async (req, res, next) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    next(err);
  }
});

// Gated behind an explicit env var, unset/false by
// default in any environment. When it's off, /debug/* isn't just
// access-denied, it's genuinely never registered — a request there falls
// through to the catch-all 404 below like any other unmatched path, so
// there's no way to fingerprint "debug routes exist but are locked" from
// outside. The busy-loop/timeout injection middleware is gated the same
// way: with the flag off, flags.busyLoop/flags.timeout can never become
// true in the first place (nothing can reach the toggles).
//
// /debug is mounted BEFORE the injection middleware, deliberately: if it
// came after, a live `timeout` (or busy-loop) flag would also swallow the
// very request trying to turn itself back off, with no way to recover
// short of restarting the container. Only /auth, /categories, /expenses
// (registered below) are meant to be affected by these toggles.
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  app.use('/debug', require('./routes/debug'));
  app.use(busyLoopMiddleware);
  app.use(timeoutMiddleware);
}

// Same "explicit, narrow, off-by-default" pattern
// as ENABLE_DEBUG_ROUTES above, independently gated. The route itself also
// enforces its own allow-list (routes/agentRemediation.js) — this flag only
// controls whether the route exists at all, same as ENABLE_DEBUG_ROUTES does
// for /debug.
if (process.env.ENABLE_AGENT_REMEDIATION === 'true') {
  app.use('/agent-remediation', require('./routes/agentRemediation'));
}

app.use('/auth', authRoutes);
app.use('/categories', categoryRoutes);
app.use('/expenses', expenseRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  req.log.error(err, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
