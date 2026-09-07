// Shared by metrics and logging so both use the exact same cardinality-safe
// label: the Express route pattern (e.g. /expenses/:id), never the raw URL.
// An unmatched request (404) gets a single fixed value instead of leaking
// the raw, attacker-controlled path.
function routeLabel(req) {
  return req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

module.exports = { routeLabel };
