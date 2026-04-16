// Sentinel thrown to unwind the JS call stack when a workflow must suspend
// (sleep timer not yet elapsed, promise not yet resolved).
var __SuspendExecution = (function () {
  function SuspendExecution(type, name, config) {
    this.type = type;
    this.name = name;
    this.config = config;
  }
  SuspendExecution.prototype = Object.create(Error.prototype);
  SuspendExecution.prototype.constructor = SuspendExecution;
  SuspendExecution.prototype.__isSuspend = true;
  return SuspendExecution;
})();

// Tracks the most recent suspension request. If workflow code catches a
// __SuspendExecution instead of letting it propagate, this variable lets the
// outer executor detect the swallowed suspension and honour it anyway.
var __pendingSuspend = null;

// TerminalError: non-retriable failure
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

function __durationToMs(d) {
  if (typeof d === "number") return Math.max(0, d);
  var ms = 0;
  if (d.milliseconds) ms += d.milliseconds;
  if (d.seconds) ms += d.seconds * 1000;
  if (d.minutes) ms += d.minutes * 60000;
  if (d.hours) ms += d.hours * 3600000;
  if (d.days) ms += d.days * 86400000;
  return Math.max(0, ms);
}

// Simple seeded PRNG (xorshift128+) for deterministic rand
function __createSeededRng(seedStr) {
  var h = 0;
  for (var i = 0; i < seedStr.length; i++) {
    h = ((h << 5) - h + seedStr.charCodeAt(i)) | 0;
  }
  var s0 = (h >>> 0) | 1;
  var s1 = ((h * 2654435761) >>> 0) | 1;

  function next() {
    var a = s0;
    var b = s1;
    s0 = b;
    a ^= (a << 23) | 0;
    a ^= (a >>> 17) | 0;
    a ^= (b ^ (b >>> 26)) | 0;
    s1 = a;
    return ((a + b) >>> 0);
  }

  return {
    random: function () {
      return next() / 4294967296;
    },
    uuidv4: function () {
      var r = [];
      for (var i = 0; i < 16; i++) {
        r.push(next() & 0xff);
      }
      r[6] = (r[6] & 0x0f) | 0x40;
      r[8] = (r[8] & 0x3f) | 0x80;
      var hex = "";
      for (var j = 0; j < 16; j++) {
        var b = r[j].toString(16);
        if (b.length === 1) b = "0" + b;
        hex += b;
        if (j === 3 || j === 5 || j === 7 || j === 9) hex += "-";
      }
      return hex;
    },
  };
}

function __createDurablePromise(promiseName, wfCtx) {
  return {
    get: function (opts) {
      var cached = wfCtx.__promises[promiseName];
      if (cached && cached.status === "resolved") {
        return Promise.resolve(
          cached.value !== undefined ? JSON.parse(cached.value) : null
        );
      }
      if (cached && cached.status === "rejected") {
        return Promise.reject(new Error(cached.error || "promise rejected"));
      }
      var timeoutMs = null;
      if (opts && opts.timeout) {
        timeoutMs = __durationToMs(opts.timeout);
      }
      if (cached && cached.status === "timed_out") {
        return Promise.resolve(null);
      }
      var __promiseSuspend = new __SuspendExecution("promise", promiseName, {
        timeout: timeoutMs,
      });
      __pendingSuspend = __promiseSuspend;
      throw __promiseSuspend;
    },
    resolve: function (value) {
      var valueJson = JSON.stringify(value === undefined ? null : value);
      wfCtx.__promises[promiseName] = { status: "resolved", value: valueJson };
      return Promise.resolve(__baal_resolve_promise(promiseName, valueJson));
    },
    reject: function (error) {
      wfCtx.__promises[promiseName] = { status: "rejected", error: error };
      return Promise.resolve(__baal_reject_promise(promiseName, error));
    },
  };
}

function __createDurablePromiseHandle(promiseName) {
  return {
    resolve: function (value) {
      var valueJson = JSON.stringify(value === undefined ? null : value);
      return Promise.resolve(__baal_resolve_promise(promiseName, valueJson));
    },
    reject: function (error) {
      return Promise.resolve(__baal_reject_promise(promiseName, error));
    },
  };
}

function __createWorkflowContext(wfCtx) {
  var rng = __createSeededRng(wfCtx.__instanceId + ":" + wfCtx.__stepIndex);
  var stepIndex = wfCtx.__stepIndex || 0;

  var ctx = {
    key: wfCtx.__instanceId,

    run: function (name, fn, opts) {
      var cached = wfCtx.__steps[name];
      if (cached && cached.status === "completed") {
        return Promise.resolve(
          cached.result !== undefined ? JSON.parse(cached.result) : null
        );
      }
      if (cached && cached.status === "failed") {
        var err = new Error(cached.error || "step failed");
        if (cached.terminal) {
          var tErr = new TerminalError(cached.error || "step failed");
          return Promise.reject(tErr);
        }
        return Promise.reject(err);
      }
      var optsJson = opts ? JSON.stringify(opts) : "{}";
      var retryPolicy = opts && opts.retryPolicy;

      return Promise.resolve().then(function () {
        return fn();
      }).then(function (result) {
        var resultJson = JSON.stringify(result === undefined ? null : result);
        __baal_persist_step(name, resultJson, optsJson);
        wfCtx.__steps[name] = { status: "completed", result: resultJson };
        return result;
      }).catch(function (err) {
        if (err && err.__isSuspend) {
          throw err;
        }
        var isTerminal = !!(err && err.__isTerminal);
        if (!isTerminal && retryPolicy) {
          var __retrySuspend = new __SuspendExecution("step_retry", name, {
            error: err.message || String(err),
            retryPolicy: retryPolicy,
            optsJson: optsJson,
          });
          __pendingSuspend = __retrySuspend;
          throw __retrySuspend;
        }
        __baal_persist_step_error(name, err.message || String(err), isTerminal, optsJson);
        wfCtx.__steps[name] = { status: "failed", error: err.message || String(err), terminal: isTerminal };
        throw err;
      });
    },

    sleep: function (name, duration) {
      var cached = wfCtx.__sleeps[name];
      if (cached && cached.elapsed) {
        return Promise.resolve();
      }
      var ms = __durationToMs(duration);
      if (ms === 0) {
        __baal_persist_sleep(name, 0);
        return Promise.resolve();
      }
      var __sleepSuspend = new __SuspendExecution("sleep", name, { durationMs: ms });
      __pendingSuspend = __sleepSuspend;
      throw __sleepSuspend;
    },

    promise: function (name) {
      return __createDurablePromise(name, wfCtx);
    },

    set: function (key, value) {
      __baal_persist_state(key, JSON.stringify(value === undefined ? null : value));
    },

    get: function (key) {
      var raw = __baal_read_state(key);
      if (raw === null || raw === undefined) return Promise.resolve(null);
      return Promise.resolve(JSON.parse(raw));
    },

    rand: rng,

    date: {
      now: function () {
        return wfCtx.__dateNow || Date.now();
      },
    },

    TerminalError: TerminalError,
  };

  return ctx;
}

function __createSharedContext(wfCtx) {
  return {
    key: wfCtx.__instanceId,
    promise: function (name) {
      return __createDurablePromiseHandle(name);
    },
    get: function (key) {
      var raw = __baal_read_state(key);
      if (raw === null || raw === undefined) return Promise.resolve(null);
      return Promise.resolve(JSON.parse(raw));
    },
  };
}

// workflow() constructor — returns opaque WorkflowDefinition
function workflow(configOrHandler) {
  if (typeof configOrHandler === "function") {
    return { run: configOrHandler, handlers: {} };
  }
  return {
    run: configOrHandler.run,
    handlers: configOrHandler.handlers || {},
  };
}

globalThis.workflow = workflow;

// --- Execute workflow ---
// __baal_workflow_ctx is injected by Rust before eval, containing:
//   __instanceId, __steps, __sleeps, __promises, __dateNow, __stepIndex,
//   __handlerName (null for run, string for shared handler), __handlerInput

var __code = __stripImports(__userSource)
  .replace(/^export\s+default\s+/m, "var __wfDef = ");

(0, eval)(__code);

if (typeof __wfDef === "undefined" || !__wfDef || !__wfDef.run) {
  throw new Error(
    "Workflow unit must export a default workflow() definition"
  );
}

var __wfCtx = __baal_workflow_ctx;

globalThis.__baal_wf_result = (function () {
  if (__wfCtx.__handlerName) {
    // Shared handler invocation
    var handlerFn = __wfDef.handlers[__wfCtx.__handlerName];
    if (!handlerFn) {
      throw new Error(
        "Unknown shared handler: " + __wfCtx.__handlerName
      );
    }
    var sharedCtx = __createSharedContext(__wfCtx);
    var handlerInput = __wfCtx.__handlerInput
      ? JSON.parse(__wfCtx.__handlerInput)
      : undefined;
    return (async function () {
      try {
        var result = await handlerFn(sharedCtx, handlerInput);
        return JSON.stringify({
          __type: "handler_result",
          value: result === undefined ? null : result,
        });
      } catch (e) {
        return JSON.stringify({
          __type: "handler_error",
          error: e.message || String(e),
        });
      }
    })();
  } else {
    // Main run handler
    var ctx = __createWorkflowContext(__wfCtx);

    // Override sdk.callWorkflow for workflow context.
    //
    // Instead of blocking a thread while waiting for the callee, sdk.callWorkflow
    // suspends the caller via a durable promise and returns when the callee
    // completes. This mirrors how Temporal handles child workflows:
    //   1. First execution: seed callee meta in Redis, publish .start, suspend.
    //   2. Callee completes → workflow_engine resolves promise → wakes caller.
    //   3. On replay: promise is already in wfCtx.__promises → return cached.
    //
    // Promise names are "sdk_call_0", "sdk_call_1", ... based on call order.
    // This counter resets to 0 each execution (fresh QuickJS runtime), which
    // is safe because execution always replays the same call sequence.
    var __sdkCallIdx = 0;
    sdk.callWorkflow = function (unitPath, data) {
      var callName = "sdk_call_" + __sdkCallIdx++;

      var cached = __wfCtx.__promises[callName];
      if (cached) {
        if (cached.status === "resolved") {
          return Promise.resolve(
            cached.value !== undefined ? JSON.parse(cached.value) : null
          );
        }
        if (cached.status === "rejected") {
          return Promise.reject(
            new Error(cached.error || "sdk.callWorkflow: callee workflow failed")
          );
        }
        if (cached.status === "timed_out") {
          return Promise.reject(
            new Error("sdk.callWorkflow timed out waiting for: " + unitPath)
          );
        }
      }

      if (typeof __baal_start_call !== "function") {
        throw new Error("sdk.callWorkflow is not available: NATS not configured");
      }

      var dataJson = data !== undefined ? JSON.stringify(data) : "null";
      __baal_start_call(unitPath, dataJson, callName);

      // Suspend for 5 minutes (300 000 ms). The promise timeout mechanism
      // already handles this via the JetStream fire_at wake, so the timeout
      // here is a safety net matching the promise infrastructure.
      var suspend = new __SuspendExecution("promise", callName, {
        timeout: 300000,
      });
      __pendingSuspend = suspend;
      throw suspend;
    };

    var input = __wfCtx.__input ? JSON.parse(__wfCtx.__input) : undefined;
    return (async function () {
      try {
        var result = await __wfDef.run(ctx, input);
        // A suspension may have been triggered but swallowed by workflow
        // try-catch. Honour it even though the run() call resolved.
        if (__pendingSuspend !== null) {
          var e = __pendingSuspend;
          __pendingSuspend = null;
          return JSON.stringify({
            __type: "suspended",
            suspensionType: e.type,
            name: e.name,
            config: e.config,
          });
        }
        return JSON.stringify({
          __type: "completed",
          value: result === undefined ? null : result,
        });
      } catch (e) {
        __pendingSuspend = null;
        if (e && e.__isSuspend) {
          return JSON.stringify({
            __type: "suspended",
            suspensionType: e.type,
            name: e.name,
            config: e.config,
          });
        }
        if (e && e.__isTerminal) {
          return JSON.stringify({
            __type: "terminal_error",
            error: e.message || String(e),
          });
        }
        return JSON.stringify({
          __type: "error",
          error: e.message || String(e),
        });
      }
    })();
  }
})();
