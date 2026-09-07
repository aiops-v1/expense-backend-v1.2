const express = require('express');
const http = require('http');
const { bindRouteLogger } = require('../middleware/requestLogger');

const router = express.Router();

// The only permitted write action, and the only
// permitted target. Checked here, server-side, independent of the agent's
// system prompt or reasoning — "the allow-list must be enforced in code,
// not only in the prompt."
const ALLOWED_CONTAINERS = ['backend'];

const SOCKET_PATH = '/var/run/docker.sock';

function dockerApiPost(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET_PATH, path: `/v1.45${path}`, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400 && res.statusCode !== 204) {
            reject(new Error(`Docker API ${path} -> ${res.statusCode}: ${body}`));
            return;
          }
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// This is the small, dedicated internal endpoint
// the agent calls instead of ever touching the Docker socket itself. That
// socket access has to live *somewhere* to actually perform a restart, and
// this wrapper — narrow, allow-listed, gated behind ENABLE_AGENT_REMEDIATION
// — is that somewhere, rather than the agent's own container. Restarting
// its own container from inside itself is a normal pattern (the Docker
// daemon executes the restart externally; it doesn't matter that the
// process issuing the API call is the one being killed and restarted).
router.post('/restart', bindRouteLogger, async (req, res, next) => {
  const { container } = req.body || {};
  if (!ALLOWED_CONTAINERS.includes(container)) {
    req.log.warn({ container }, 'agent-remediation: rejected disallowed container');
    return res.status(403).json({ error: `"${container}" is not on the remediation allow-list` });
  }
  try {
    await dockerApiPost(`/containers/${encodeURIComponent(container)}/restart`);
    req.log.warn({ container }, 'agent-remediation: restarted container');
    res.json({ restarted: container });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
