const flags = require('../debugFlags');

// A fixed slice of requests (not every request; that would just make the
// whole app synchronously unusable rather than demonstrate a
// partial-degradation pattern) block the event loop for a fixed duration
// before continuing. Constants, not part of the debug API's request body
// (only `enabled` is exposed there).
const BUSY_LOOP_FRACTION = 0.2;
const BUSY_LOOP_MS = 200;

function busyLoopMiddleware(req, res, next) {
  if (flags.busyLoop && Math.random() < BUSY_LOOP_FRACTION) {
    const until = Date.now() + BUSY_LOOP_MS;
    // Deliberately synchronous — the whole point is to starve the event
    // loop, which is what should move the Node event-loop-lag metric,
    // not just add latency to this one request.
    while (Date.now() < until) {
      /* busy-wait */
    }
  }
  next();
}

// See routes/debug.js for why this is a debug-flag toggle rather than an
// iptables-based approach — the backend container has no iptables
// installed and no NET_ADMIN capability. While the flag is on, a matching
// request is simply never answered: no res.end(), no next(), the
// connection just sits open. From the client's (and nginx's) point of view
// this is a genuine timeout, not a fast failure — nginx's own
// proxy_read_timeout eventually returns 504, a "fails slow" signature
// worth contrasting against a fast "connection refused."
function timeoutMiddleware(req, res, next) {
  if (flags.timeout) {
    return;
  }
  next();
}

module.exports = { busyLoopMiddleware, timeoutMiddleware };
