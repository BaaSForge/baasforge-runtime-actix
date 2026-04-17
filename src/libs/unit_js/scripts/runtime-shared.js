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

// Default sdk.callWorkflow — overridden by workflow-runtime.js with durable suspension.
// For non-workflow contexts this throws immediately (sdk.callWorkflow is workflow-only).
var sdk = {
  callWorkflow: function (_unitPath, _data) {
    throw new Error('sdk.callWorkflow is only available inside workflow units');
  },

  callActor: async function (unitPath, actorId, handler, payload, opts) {
    var projectId = globalThis.__baal_actor_project_id
      || globalThis.__baal_qw_project_id
      || globalThis.__baal_wf_project_id
      || "";
    var baseUrl = globalThis.__baal_actor_base_url
      || globalThis.__baal_qw_base_url
      || globalThis.__baal_wf_base_url
      || "";
    var parts = unitPath.split(".");
    if (parts.length < 4) throw new Error("sdk.callActor: invalid unitPath '" + unitPath + "'");
    var context = parts[0];
    var module = parts[1];
    var unitName = parts[3];
    var awaitResult = (opts && opts.awaitResult === false) ? "false" : "true";
    var url = baseUrl + "/api/v1/trigger/actor/" + projectId + "/" + context + "/" + module + "/" + unitName + "/" + actorId + "/" + handler + "?await=" + awaitResult;
    var resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload !== undefined ? payload : {}),
    });
    if (!resp.ok) {
      var errText = await resp.text();
      throw new Error("sdk.callActor: HTTP " + resp.status + ": " + errText);
    }
    var body = await resp.json();
    return body.result !== undefined ? body.result : body;
  },
};

globalThis.sdk = sdk;
