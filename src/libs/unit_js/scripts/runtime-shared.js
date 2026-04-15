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

// Default sdk.call — overridden by workflow-runtime.js with durable suspension.
// For non-workflow contexts this throws immediately (sdk.call is workflow-only).
var sdk = {
  call: function (_unitPath, _data) {
    throw new Error('sdk.call is only available inside workflow units');
  },
};

globalThis.sdk = sdk;
