const mysql = require('mysql2/promise');

function buildPool(size) {
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: size,
    queueLimit: 0,
    decimalNumbers: true,
  });
}

let currentSize = Number(process.env.DB_POOL_SIZE || 10);
let currentPool = buildPool(currentSize);

// Pool resize, no restart needed. Every route
// in this app did (and still does) `const pool = require('../db')` once at
// module load and calls `pool.query(...)` — swapping what `currentPool`
// points to wouldn't reach any of them, since they'd keep holding whatever
// was exported at require() time. So the exported object's identity never
// changes; only what its `query()` delegates to does, underneath it.
const pool = {
  query: (...args) => currentPool.query(...args),

  // Creates a new pool at the requested size, swaps it in for all future
  // queries, then ends the *old* pool gracefully — mysql2's pool.end() lets
  // any already-checked-out connections finish their in-flight query before
  // actually closing, rather than dropping them mid-query.
  async resizePool(newSize) {
    const oldPool = currentPool;
    currentPool = buildPool(newSize);
    currentSize = newSize;
    await oldPool.end();
  },

  getPoolSize() {
    return currentSize;
  },
};

module.exports = pool;
