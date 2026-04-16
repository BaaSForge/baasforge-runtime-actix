function queueWorker(cfg) {
  if (typeof cfg === "function") return { __qw_metadata: {} };
  return { __qw_metadata: (cfg && cfg.metadata) || {} };
}
globalThis.queueWorker = queueWorker;
globalThis.TerminalError = function () {};
var __qwCode = __stripImports(__userSource)
  .replace(/^export\s+default\s+/m, "var __qwDef = ");
try { (0, eval)(__qwCode); } catch (_e) {}
var __m = (typeof __qwDef !== "undefined" && __qwDef && __qwDef.__qw_metadata) ? __qwDef.__qw_metadata : {};
var __tout = null;
if (typeof __m.timeout === "number") __tout = __m.timeout;
var __bat = null;
if (__m.batch && typeof __m.batch.size === "number") {
  var __bt = __m.batch.timeout;
  var __btms = 0;
  if (typeof __bt === "number") { __btms = __bt; }
  else if (__bt && typeof __bt === "object") {
    if (__bt.milliseconds) __btms += __bt.milliseconds;
    if (__bt.seconds) __btms += __bt.seconds * 1000;
    if (__bt.minutes) __btms += __bt.minutes * 60000;
    if (__bt.hours) __btms += __bt.hours * 3600000;
  }
  __bat = JSON.stringify({ size: __m.batch.size, timeoutMs: __btms > 0 ? __btms : 5000 });
}
var __maxAttempts = null;
if (__m.retry && typeof __m.retry.maxAttempts === "number") __maxAttempts = __m.retry.maxAttempts;
JSON.stringify({ timeoutMs: __tout, batchJson: __bat, maxAttempts: __maxAttempts });
