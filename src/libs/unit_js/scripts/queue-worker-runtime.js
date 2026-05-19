// RULES: thin proxy to Rust host functions. Never fetch() internal routes;
// never re-implement sdk.* helpers that belong in runtime-shared.js.
// See src/libs/unit_js/README.md.

var TerminalError = (function () {
  function TerminalError(message, options) {
    Error.call(this, message);
    this.message = message;
    this.name = "TerminalError";
    this.__isTerminal = true;
    if (options && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
  TerminalError.prototype = Object.create(Error.prototype);
  TerminalError.prototype.constructor = TerminalError;
  return TerminalError;
})();

function __qwDurationToMs(d) {
  if (!d) return null;
  if (typeof d === "number") return Math.max(0, d);
  var ms = 0;
  if (d.milliseconds) ms += d.milliseconds;
  if (d.seconds) ms += d.seconds * 1000;
  if (d.minutes) ms += d.minutes * 60000;
  if (d.hours) ms += d.hours * 3600000;
  if (d.days) ms += d.days * 86400000;
  return Math.max(0, ms);
}

function __normalizeQueueWorkerMetadata(m) {
  if (!m) return {};
  var ret = {};
  if (m.retry) {
    ret.retry = {
      maxAttempts: m.retry.maxAttempts != null ? m.retry.maxAttempts : 3,
      initialIntervalMs: __qwDurationToMs(m.retry.initialInterval) != null
        ? __qwDurationToMs(m.retry.initialInterval)
        : 1000,
      backoffFactor: m.retry.backoffFactor != null ? m.retry.backoffFactor : 2,
      maxIntervalMs: __qwDurationToMs(m.retry.maxInterval) != null
        ? __qwDurationToMs(m.retry.maxInterval)
        : 300000,
    };
  }
  if (m.timeout != null) {
    ret.timeout = typeof m.timeout === "number" ? m.timeout : null;
  }
  if (m.batch && typeof m.batch === "object") {
    ret.batch = {
      size: m.batch.size || 1,
      timeoutMs: __qwDurationToMs(m.batch.timeout) || 5000,
    };
  }
  return ret;
}

function queueWorker(configOrHandler) {
  if (typeof configOrHandler === "function") {
    return {
      __qw_process: configOrHandler,
      __qw_onDeadLetter: null,
      __qw_metadata: {},
    };
  }
  return {
    __qw_process: configOrHandler.process || null,
    __qw_onDeadLetter: configOrHandler.onDeadLetter || null,
    __qw_metadata: configOrHandler.metadata || {},
  };
}

globalThis.queueWorker = queueWorker;
globalThis.TerminalError = TerminalError;

var __qwCtx = __baal_qw_ctx;

var ctx = {
  id: __qwCtx.runId,
  attempt: __qwCtx.attempt,
  enqueuedAt: __qwCtx.enqueuedAt,
  TerminalError: TerminalError,
};

var data;
try {
  data = JSON.parse(__qwCtx.data);
} catch (_) {
  data = null;
}

globalThis.__baal_qw_result = (async function () {
  var __entry = await import("baal-unit-entry");
  var __qwDef = __entry.default;
  if (typeof __qwDef === "undefined" || !__qwDef || !__qwDef.__qw_process) {
    throw new Error("Queue worker unit must export a default queueWorker() definition with a process handler");
  }
  var __qwNormalizedMeta = __normalizeQueueWorkerMetadata(__qwDef.__qw_metadata);

  try {
    var result = await __qwDef.__qw_process(ctx, data);
    return JSON.stringify({
      __type: "completed",
      value: result === undefined ? null : result,
      metadata: __qwNormalizedMeta,
    });
  } catch (err) {
    if (err && err.__isTerminal) {
      if (__qwDef.__qw_onDeadLetter) {
        try {
          await __qwDef.__qw_onDeadLetter(ctx, data, err);
        } catch (_) {}
      }
      return JSON.stringify({
        __type: "terminal_error",
        error: err.message || String(err),
        metadata: __qwNormalizedMeta,
      });
    }
    return JSON.stringify({
      __type: "error",
      error: err.message || String(err),
      metadata: __qwNormalizedMeta,
    });
  }
})();
