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

globalThis.TerminalError = TerminalError;

var __actorDef = null;

function actor(config) {
  var def = {
    __actor_def: true,
    __initial_state: config.state !== undefined ? config.state : {},
    __handlers: config.handlers || {},
    __on_alarm: config.onAlarm || null,
    __on_dead_letter: config.onDeadLetter || null,
    __metadata: config.metadata || {},
  };
  __actorDef = def;
  return def;
}

globalThis.actor = actor;

var __actorCode = __stripImports(__userSource)
  .replace(/^export\s+default\s+/m, "var __actorExport = ");

(0, eval)(__actorCode);

if (typeof __actorExport !== "undefined" && __actorExport && __actorExport.__actor_def) {
  __actorDef = __actorExport;
}

if (!__actorDef) {
  throw new Error("Actor unit must export a default actor() definition");
}

var __actorCtx = globalThis.__baal_actor_ctx;
var __kind = globalThis.__baal_actor_kind || "handler";
var __stateLimitBytes = globalThis.__baal_actor_state_limit_bytes || (1024 * 1024);

var __loadedState = __actorCtx.state;
if (__loadedState === null || __loadedState === undefined) {
  var __defState = __actorDef.__initial_state;
  __loadedState = typeof __defState === "object" && __defState !== null
    ? JSON.parse(JSON.stringify(__defState))
    : __defState;
}

var __isFirstActivation = __actorCtx.state === null || __actorCtx.state === undefined;
var __stateBefore = JSON.stringify(__loadedState);
var __currentState = JSON.parse(JSON.stringify(__loadedState !== undefined ? __loadedState : {}));

var __pendingAlarms = [];
var __cancelledAlarms = [];

var ctx = {
  id: __actorCtx.id,
  attempt: __actorCtx.attempt,
  get state() { return __currentState; },
  setAlarm: function (name, at) {
    var ts = typeof at === "number" ? at : Date.parse(at);
    __pendingAlarms.push({ name: String(name), at: ts });
  },
  cancelAlarm: function (name) {
    __cancelledAlarms.push(String(name));
  },
  TerminalError: TerminalError,
};

globalThis.__baal_actor_result = (async function () {
  try {
    var handlerName = __actorCtx.handler;
    var payload = __actorCtx.payload;
    try {
      if (typeof payload === "string") {
        payload = JSON.parse(payload);
      }
    } catch (_) {}

    var returnValue = undefined;

    if (__kind === "alarm") {
      var alarmName = __actorCtx.alarmName || handlerName;
      if (typeof __actorDef.__on_alarm === "function") {
        returnValue = await __actorDef.__on_alarm(ctx, alarmName);
      }
    } else if (__kind === "dead_letter") {
      if (typeof __actorDef.__on_dead_letter === "function") {
        try {
          returnValue = await __actorDef.__on_dead_letter(ctx, handlerName, payload, __actorCtx.error);
        } catch (_dlErr) {}
      }
    } else {
      var handlerFn = __actorDef.__handlers[handlerName];
      if (!handlerFn) {
        return JSON.stringify({
          ok: false,
          terminal: false,
          error: "UnknownHandler: '" + handlerName + "' is not defined in this actor",
        });
      }
      returnValue = await handlerFn(ctx, payload);
    }

    var stateAfter = JSON.stringify(__currentState);
    var stateTouched = stateAfter !== __stateBefore || __isFirstActivation;
    var stateJson = stateAfter;

    var stateBytes = (new TextEncoder()).encode(stateJson).length;
    if (stateBytes > __stateLimitBytes) {
      return JSON.stringify({
        ok: false,
        terminal: true,
        error: "StateLimitExceeded: state size " + stateBytes + " bytes exceeds limit of " + __stateLimitBytes + " bytes",
        state: __stateBefore,
        state_touched: false,
      });
    }

    return JSON.stringify({
      ok: true,
      state: stateJson,
      value: returnValue !== undefined ? returnValue : null,
      state_touched: stateTouched,
      pending_alarms: __pendingAlarms,
      cancelled_alarms: __cancelledAlarms,
    });
  } catch (err) {
    var isTerminal = err && err.__isTerminal === true;
    return JSON.stringify({
      ok: false,
      terminal: isTerminal,
      error: (err && err.message) ? err.message : String(err),
      state: JSON.stringify(__currentState),
      state_touched: false,
    });
  }
})();
