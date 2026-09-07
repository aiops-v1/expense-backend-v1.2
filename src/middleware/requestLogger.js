const crypto = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../logger');
const { routeLabel } = require('../routeLabel');

// pino-http's own autoLogging bakes its completion-log bindings in at
// request start (before routing/auth run), so it can never pick up route or
// user_id — see requestCompletionLogger below, which reads req.log lazily
// at response-finish time instead. We only use pino-http here to generate
// req.id and attach an initial req.log (quietReqLogger keeps that initial
// logger to just `req_id`, not the full raw request object).
const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  customAttributeKeys: { reqId: 'req_id' },
  quietReqLogger: true,
  autoLogging: false,
});

// Every log line gets `user_id`, even ones emitted before auth runs —
// requireAuth overrides it per-request once the real user is known.
// Deliberately NOT binding a placeholder `route` here: pino's child-logger
// bindings are pre-serialized ("chindings"), so a later bindRouteLogger
// child() call doesn't replace this key in the output — it appends a SECOND
// "route" key to the same JSON line. Downstream consumers disagree on which
// one wins: JSON.parse/jq take the last, but Loki's `| json` parser keeps
// the FIRST — so a duplicate key here silently broke `route` filtering in
// Loki (every line resolved to this placeholder, never the real route).
// Instead, route is set exactly once per request: bindRouteLogger for
// matched routes, or the 'unmatched' fallback in requestCompletionLogger
// below for the (rare) request that never matches a route at all.
// trace_id/span_id are NOT bound here — @opentelemetry/instrumentation-pino
// (bundled via getNodeAutoInstrumentations() in tracing.js) already injects
// them into every log line automatically, via a pino mixin that re-reads the
// active span fresh on each call. An earlier version of this function also
// bound them manually via .child() — but that froze whatever span was active
// at baseLogContext's own (very short) middleware span, not the span active
// when each line is actually written, and being a separate .child() call, it
// didn't override the mixin's fields — chindings are pre-serialized, so both
// ended up in the output as genuine duplicate trace_id/span_id keys, same
// class of bug as the route one below. req_id stays — it's a simpler,
// OTel-independent identifier that still groups a request's log lines even
// if tracing is ever turned off.
function baseLogContext(req, res, next) {
  req.log = req.log.child({ user_id: null });
  next();
}

// Mount as the first handler on every route so req.log (and therefore every
// log line from that handler onward) carries the real route pattern.
function bindRouteLogger(req, res, next) {
  req.log = req.log.child({ route: routeLabel(req) });
  next();
}

// Logs one line per request on completion, reading req.log at finish time
// (not request start) so it always reflects whatever route/user_id bindings
// accumulated during handling — same res.on('finish') pattern as metrics.js.
function requestCompletionLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const fields = { method: req.method, status_code: res.statusCode, duration_ms: durationMs };
    // bindRouteLogger never ran (no route matched, e.g. a 404) — this is the
    // only place 'unmatched' gets set, and only when nothing set route already.
    if (!req.route) fields.route = 'unmatched';
    req.log[level](fields, `${req.method} ${req.originalUrl} ${res.statusCode}`);
  });
  next();
}

module.exports = { httpLogger, baseLogContext, bindRouteLogger, requestCompletionLogger };
