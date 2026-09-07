const client = require('prom-client');
const { trace } = require('@opentelemetry/api');
const { routeLabel } = require('./routeLabel');
const flags = require('./debugFlags');

const register = new client.Registry();
// Exemplars are an OpenMetrics-only feature — the classic Prometheus text
// format has no way to carry them. app.js's /metrics route already reads
// Content-Type from register.contentType, so this one flag is all it takes.
register.setContentType(client.Registry.OPENMETRICS_CONTENT_TYPE);
client.collectDefaultMetrics({ register });

// RED metrics — `route` is always the Express route pattern (e.g. /expenses/:id),
// never req.path (e.g. /expenses/4821). Raw IDs on a label = cardinality explosion.
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  enableExemplars: true,
  registers: [register],
});

// Business metrics. No user_id label on any of these, ever — per-user
// breakdowns belong in logs, not as an unbounded Prometheus label value.
const usersRegisteredTotal = new client.Counter({
  name: 'users_registered_total',
  help: 'Total number of successful user signups',
  registers: [register],
});

const userLoginsTotal = new client.Counter({
  name: 'user_logins_total',
  help: 'Total number of successful user logins',
  registers: [register],
});

const expensesCreatedTotal = new client.Counter({
  name: 'expenses_created_total',
  help: 'Total number of expenses created, by category',
  labelNames: ['category_name'],
  registers: [register],
});

const expenseAmountRupeesTotal = new client.Counter({
  name: 'expense_amount_rupees_total',
  help: 'Total expense amount recorded (rupees), by category',
  labelNames: ['category_name'],
  registers: [register],
});

// Cardinality-bomb demo — deliberately NOT a new label on
// http_requests_total itself: that counter is what Backend5xxRateHigh and
// the RED-metrics dashboard panel already depend on, and prom-client
// requires every declared labelName to be present on every
// .inc() call or the series silently comes out with an empty-string value
// for whatever's missing — either way, permanently reshaping an
// already-relied-on metric's label set just for a togglable demo isn't worth
// the risk. A separate, obviously-debug-only counter gets the same teaching
// effect (hundreds of new series while the flag is on, real TSDB load) with
// zero blast radius on anything else.
const httpRequestsByUserDebugTotal = new client.Counter({
  name: 'http_requests_total_by_user_debug',
  help: 'DEBUG ONLY — same shape as http_requests_total plus a user_id label, deliberately reintroducing the cardinality mistake of putting an unbounded value on a label. Only populated while the bad-cardinality debug flag is on; never referenced by any alert or the main dashboard.',
  labelNames: ['method', 'route', 'status_code', 'user_id'],
  registers: [register],
});

function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const labels = { method: req.method, route: routeLabel(req), status_code: res.statusCode };
    httpRequestsTotal.inc(labels);
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    // Bridge #2: one real trace_id per observation, so a latency spike on
    // this histogram in Grafana can jump straight to an example trace in
    // Tempo instead of staying a standalone number.
    const span = trace.getActiveSpan();
    const exemplarLabels = span ? { trace_id: span.spanContext().traceId } : {};
    httpRequestDurationSeconds.observe({ labels, value: durationSeconds, exemplarLabels });

    if (flags.badCardinality) {
      const userId = req.user ? String(req.user.id) : 'anonymous';
      httpRequestsByUserDebugTotal.inc({ ...labels, user_id: userId });
    }
  });
  next();
}

module.exports = {
  register,
  httpMetricsMiddleware,
  usersRegisteredTotal,
  userLoginsTotal,
  expensesCreatedTotal,
  expenseAmountRupeesTotal,
};
