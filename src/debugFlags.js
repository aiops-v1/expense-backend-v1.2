// In-memory only, never persisted. Every flag resets to its safe default on
// process start regardless of how a previous session left it, since this is
// a plain module-level object re-initialized on every `require` of a fresh
// process — there's deliberately no file/DB backing it.
const flags = {
  nPlusOne: false,
  busyLoop: false,
  // See routes/debug.js and middleware/debugInjections.js for why this is
  // a debug-flag toggle rather than an iptables-based approach — the
  // backend container has no iptables installed and no NET_ADMIN capability.
  timeout: false,
  badCardinality: false,
};

module.exports = flags;
