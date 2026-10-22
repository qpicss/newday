// W3C Trace Context (https://www.w3.org/TR/trace-context/): continue the caller's trace when a valid
// traceparent arrives, otherwise start one. The upstream call is a child span of the gateway span.
const { randomBytes } = require('crypto');

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

const newTraceId = () => randomBytes(16).toString('hex');
const newSpanId = () => randomBytes(8).toString('hex');

const startSpan = (headers) => {
  const match = String(headers.traceparent || '').trim().toLowerCase().match(TRACEPARENT);
  const valid = match && match[1] !== ZERO_TRACE && match[2] !== ZERO_SPAN;
  return {
    traceId: valid ? match[1] : newTraceId(),
    parentSpanId: valid ? match[2] : null,
    spanId: newSpanId(),
    flags: valid ? match[3] : '01',
    traceState: valid && typeof headers.tracestate === 'string' ? headers.tracestate : null,
  };
};

const traceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

module.exports = { startSpan, traceparent, newSpanId };
