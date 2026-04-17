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

var sdk = {
  callActor: function (unitPath, actorId, handler, payload, opts) {
    var awaitResult = !(opts && opts.awaitResult === false);
    var timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 30000;
    var payloadJson = payload !== undefined ? JSON.stringify(payload) : '{}';
    if (!awaitResult) {
      __baal_call_actor_async(unitPath, actorId, handler, payloadJson);
      return Promise.resolve({ delivered: true });
    }
    var resultJson = __baal_call_actor_sync(unitPath, actorId, handler, payloadJson, timeoutMs);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callActor failed');
    return Promise.resolve(parsed.result);
  },

  enqueueWorker: function (unitPath, data) {
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var resultJson = __baal_enqueue_worker(unitPath, dataJson);
    return Promise.resolve(JSON.parse(resultJson));
  },

  callWorkflow: function (unitPath, data) {
    var dataJson = data !== undefined ? JSON.stringify(data) : 'null';
    var resultJson = __baal_call_workflow_sync(unitPath, dataJson, 300000);
    var parsed = JSON.parse(resultJson);
    if (!parsed.ok) throw new Error(parsed.error || 'sdk.callWorkflow failed');
    return Promise.resolve(parsed.value);
  },
};

globalThis.sdk = sdk;
