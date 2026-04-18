// RULES: this file is injected into every QuickJS unit runtime.
// It must stay a thin proxy over Rust `__baal_*` host functions.
// No fetch() to internal trigger routes, no Redis/NATS logic, no duplication.
// See src/libs/unit_js/README.md.

// --- node:querystring ---

function parseQuerystring(str, sep, eq) {
  var out = Object.create(null);
  if (!str) return out;
  sep = sep || "&";
  eq = eq || "=";
  var parts = str.split(sep);
  for (var p = 0; p < parts.length; p++) {
    var part = parts[p];
    if (!part) continue;
    var i = part.indexOf(eq);
    var key, val;
    if (i < 0) {
      key = decodeURIComponent(part.replace(/\+/g, " "));
      val = "";
    } else {
      key = decodeURIComponent(part.slice(0, i).replace(/\+/g, " "));
      val = decodeURIComponent(part.slice(i + eq.length).replace(/\+/g, " "));
    }
    if (key in out) {
      if (Array.isArray(out[key])) {
        out[key].push(val);
      } else {
        out[key] = [out[key], val];
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

// --- node:stream/consumers ---

function __streamConsumersText(req) {
  return Promise.resolve(req.__bodyText !== undefined ? req.__bodyText : "");
}

// --- Module registry ---

globalThis.__baalModules = globalThis.__baalModules || {};
globalThis.__baalModules['node:querystring'] = { parse: parseQuerystring };
globalThis.__baalModules['node:stream/consumers'] = { text: __streamConsumersText };

// --- Import rewriting ---

function __stripImports(source) {
  var modules = globalThis.__baalModules || {};
  return source
    .replace(
      /^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
      function (_m, names, mod) {
        if (modules[mod]) {
          var escaped = mod.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return 'var {' + names.replace(/\bas\b/g, ':') + '} = globalThis.__baalModules["' + escaped + '"];';
        }
        return '';
      }
    )
    .replace(/^\s*import\s+.*\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]*['"];?\s*$/gm, '');
}

// --- sdk (inter-unit communication) ---
// Thin proxies to Rust __baal_* host functions. No fetch(), no business logic.
// All methods are synchronous and return plain values — never Promises.

var sdk = {
  callActorAndWaitForResultSync: function (unitPath, actorId, handler, payload, opts) {
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 30000;
    var payloadJson = payload !== undefined ? JSON.stringify(payload) : '{}';
    var resultJson = __baal_call_actor_sync(unitPath, actorId, handler, payloadJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callActorAndWaitForResultSync failed');
    return parsed.result;
  },

  sendActorMessageSync: function (unitPath, actorId, handler, payload) {
    var payloadJson = payload !== undefined ? JSON.stringify(payload) : '{}';
    __baal_call_actor_async(unitPath, actorId, handler, payloadJson);
    return { delivered: true };
  },

  enqueueWorkerSync: function (unitPath, data, opts) {
    void opts;
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var resultJson = __baal_enqueue_worker(unitPath, dataJson);
    return JSON.parse(resultJson);
  },

  startWorkflowSync: function (unitPath, data) {
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var startedJson = __baal_start_workflow_fire_forget(unitPath, dataJson);
    return JSON.parse(startedJson);
  },

  callWorkflowAndWaitForOutputSync: function (unitPath, data, opts) {
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 300000;
    var resultJson = __baal_call_workflow_sync(unitPath, dataJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callWorkflowAndWaitForOutputSync failed');
    return parsed.value;
  },

  callWorkflowHandlerAndWaitForResultSync: function (unitPath, instanceId, handler, input, opts) {
    var inputJson = input !== undefined ? JSON.stringify(input) : 'null';
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 30000;
    var resultJson = __baal_call_workflow_handler_sync(unitPath, instanceId, handler, inputJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callWorkflowHandlerAndWaitForResultSync failed');
    return parsed.value;
  },

  getApiUnitTriggerUrl: function (unitPathOrId) {
    var parts = String(unitPathOrId).split('.');
    if (parts.length === 5) {
      var rev = parseInt(parts[4], 10);
      if (isNaN(rev) || rev < 1) throw new Error('sdk.getApiUnitTriggerUrl: invalid revision in unit id');
      parts = parts.slice(0, 4);
    }
    if (parts.length !== 4) throw new Error('sdk.getApiUnitTriggerUrl: expected 4-segment unit path or 5-segment unit id');
    if (parts[2] !== 'api') throw new Error('sdk.getApiUnitTriggerUrl: unit type "' + parts[2] + '" is not an API unit');
    var projectId = (typeof __baal_project_id !== 'undefined') ? __baal_project_id : '';
    if (!projectId) throw new Error('sdk.getApiUnitTriggerUrl: project id not available');
    var host = (typeof __selfHost !== 'undefined') ? __selfHost : 'localhost';
    var triggerBase = (typeof __triggerBasePath !== 'undefined') ? __triggerBasePath : '';
    var stageSegments = triggerBase.split('/');
    var stageIdx = stageSegments.indexOf('stage');
    var isStage = stageIdx !== -1;
    if (isStage) {
      var runtimeId = stageSegments[stageIdx + 1] || '';
      if (!runtimeId) throw new Error('sdk.getApiUnitTriggerUrl: stage runtime id not found in trigger path');
      return 'http://' + host + '/api/v1/trigger/' + projectId + '/stage/' + runtimeId + '/' + parts[0] + '/' + parts[1] + '/' + parts[3];
    }
    return 'http://' + host + '/api/v1/trigger/' + projectId + '/' + parts[0] + '/' + parts[1] + '/' + parts[3];
  },
};

globalThis.sdk = sdk;
