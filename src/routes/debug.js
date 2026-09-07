const express = require('express');
const pool = require('../db');
const flags = require('../debugFlags');
const { bindRouteLogger } = require('../middleware/requestLogger');

const router = express.Router();

// This endpoint is what inject.sh's `stop`
// commands poll to confirm a toggle actually took effect, not just that the
// HTTP call succeeded.
router.get('/status', bindRouteLogger, (req, res) => {
  res.json({
    nPlusOne: flags.nPlusOne,
    busyLoop: flags.busyLoop,
    timeout: flags.timeout,
    badCardinality: flags.badCardinality,
    poolSize: pool.getPoolSize(),
  });
});

router.post('/inject/n-plus-one', bindRouteLogger, (req, res) => {
  flags.nPlusOne = Boolean(req.body?.enabled);
  req.log.warn({ enabled: flags.nPlusOne }, 'debug: n-plus-one toggled');
  res.json({ nPlusOne: flags.nPlusOne });
});

router.post('/inject/busy-loop', bindRouteLogger, (req, res) => {
  flags.busyLoop = Boolean(req.body?.enabled);
  req.log.warn({ enabled: flags.busyLoop }, 'debug: busy-loop toggled');
  res.json({ busyLoop: flags.busyLoop });
});

// Hangs requests without ever answering them, reimplemented without
// iptables (see middleware/debugInjections.js for why).
router.post('/inject/timeout', bindRouteLogger, (req, res) => {
  flags.timeout = Boolean(req.body?.enabled);
  req.log.warn({ enabled: flags.timeout }, 'debug: timeout toggled');
  res.json({ timeout: flags.timeout });
});

router.post('/inject/bad-cardinality', bindRouteLogger, (req, res) => {
  flags.badCardinality = Boolean(req.body?.enabled);
  req.log.warn({ enabled: flags.badCardinality }, 'debug: bad-cardinality toggled');
  res.json({ badCardinality: flags.badCardinality });
});

router.post('/pool/resize', bindRouteLogger, async (req, res, next) => {
  const size = Number(req.body?.size);
  if (!Number.isInteger(size) || size < 1) {
    return res.status(400).json({ error: 'size must be a positive integer' });
  }
  try {
    await pool.resizePool(size);
    req.log.warn({ size }, 'debug: pool resized');
    res.json({ poolSize: pool.getPoolSize() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
