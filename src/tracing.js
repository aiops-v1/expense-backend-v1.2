// Must be required before any other module in the entry point — instrumentation
// patches libraries (http, express, mysql2) at import time, so it has to run
// before those libraries are themselves required anywhere in the app.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'expense-backend',
  traceExporter: new OTLPTraceExporter({
    // OTLP/HTTP to the Collector, never straight to Tempo — the Collector is
    // the single ingestion point for every signal in this stack.
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318'}/v1/traces`,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
