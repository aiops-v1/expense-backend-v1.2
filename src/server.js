// On by default everywhere this app has run so far. The only opt-out is the
// staged teaching build in ../../expense-app-stages/v1-metrics, which has no
// otel-collector for this to export to — ENABLE_TRACING=false there avoids
// periodic export-failure noise in the backend's own logs.
if (process.env.ENABLE_TRACING !== 'false') {
  require('./tracing');
}
require('dotenv').config();

const app = require('./app');

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`expense-backend-v1 listening on port ${port}`);
});
