// RULES: this file is injected into every QuickJS unit runtime.
// It must stay a thin proxy over Rust `__baal_*` host functions.
// No fetch() to internal trigger routes, no Redis/NATS logic, no duplication.
// See src/libs/unit_js/README.md.

// --- sdk (inter-unit communication) ---
// Thin proxies to Rust __baal_* host functions. No fetch(), no business logic.
// All methods are synchronous and return plain values — never Promises.

var sdk = {
  callActorAndWaitForResultSync: function (args) {
    var unitPath = args.unitPath;
    var actorId = args.actorId;
    var handler = args.handler;
    var payload = args.payload;
    var opts = args.opts;
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 30000;
    var payloadJson = payload !== undefined ? JSON.stringify(payload) : '{}';
    var resultJson = __baal_call_actor_sync(unitPath, actorId, handler, payloadJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callActorAndWaitForResultSync failed');
    return parsed.result;
  },

  sendActorMessageSync: function (args) {
    var unitPath = args.unitPath;
    var actorId = args.actorId;
    var handler = args.handler;
    var payload = args.payload;
    var payloadJson = payload !== undefined ? JSON.stringify(payload) : '{}';
    __baal_call_actor_async(unitPath, actorId, handler, payloadJson);
    return { delivered: true };
  },

  enqueueWorkerSync: function (args) {
    var unitPath = args.unitPath;
    var data = args.data;
    void args.opts;
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var resultJson = __baal_enqueue_worker(unitPath, dataJson);
    return JSON.parse(resultJson);
  },

  startWorkflowSync: function (args) {
    var unitPath = args.unitPath;
    var data = args.input;
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var startedJson = __baal_start_workflow_fire_forget(unitPath, dataJson);
    return JSON.parse(startedJson);
  },

  callWorkflowAndWaitForOutputSync: function (args) {
    var unitPath = args.unitPath;
    var data = args.input;
    var opts = args.opts;
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 300000;
    var resultJson = __baal_call_workflow_sync(unitPath, dataJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callWorkflowAndWaitForOutputSync failed');
    return parsed.value;
  },

  callWorkflowHandlerAndWaitForResultSync: function (args) {
    var unitPath = args.unitPath;
    var instanceId = args.instanceId;
    var handler = args.handler;
    var input = args.input;
    var opts = args.opts;
    var inputJson = input !== undefined ? JSON.stringify(input) : 'null';
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 30000;
    var resultJson = __baal_call_workflow_handler_sync(unitPath, instanceId, handler, inputJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callWorkflowHandlerAndWaitForResultSync failed');
    return parsed.value;
  },

  getApiUnitTriggerUrl: function (args) {
    var resultJson = __baal_get_api_unit_trigger_url(JSON.stringify({ unitPathOrId: args.unitPathOrId }));
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.getApiUnitTriggerUrl failed');
    return parsed.url;
  },

  getSecureEnv: function (key) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('sdk.getSecureEnv: key must be a non-empty string');
    }
    var resultJson = __baal_get_secure_env(key);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.getSecureEnv failed');
    return parsed.value;
  },
};

globalThis.sdk = sdk;
