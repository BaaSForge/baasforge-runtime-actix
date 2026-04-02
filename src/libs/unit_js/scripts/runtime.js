function parseQuerystring(str, sep, eq) {
  const out = Object.create(null);
  if (!str) return out;
  sep = sep || "&";
  eq = eq || "=";
  for (const part of str.split(sep)) {
    if (!part) continue;
    const i = part.indexOf(eq);
    if (i < 0) { out[part] = ""; continue; }
    out[part.slice(0, i)] = part.slice(i + eq.length);
  }
  return out;
}

async function text(req) {
  return req.__bodyText !== undefined ? req.__bodyText : "";
}

function __buildReq(snap) {
  const headers = Object.create(null);
  const rawHeaders = [];
  for (const pair of snap.headerPairs) {
    const k = pair[0];
    const v = pair[1];
    const lk = k.toLowerCase();
    if (headers[lk] === undefined) headers[lk] = v;
    rawHeaders.push(k, v);
  }
  return {
    method: snap.method,
    url: snap.url,
    headers,
    rawHeaders,
    __bodyText: snap.bodyText,
  };
}

function __createRes() {
  return {
    statusCode: 200,
    __headers: [],
    __body: "",
    setHeader(name, value) {
      const n = String(name).toLowerCase();
      this.__headers = this.__headers.filter(h => h.name !== n);
      if (Array.isArray(value)) {
        for (const item of value) this.__headers.push({ name: n, value: String(item) });
      } else {
        this.__headers.push({ name: n, value: String(value) });
      }
    },
    removeHeader(name) {
      this.__headers = this.__headers.filter(h => h.name !== String(name).toLowerCase());
    },
    appendHeader(name, value) {
      const v = Array.isArray(value) ? value.join(", ") : String(value);
      this.__headers.push({ name: String(name).toLowerCase(), value: v });
    },
    end(chunk) {
      this.__body = chunk === undefined ? "" : String(chunk);
    },
    __snapshot() {
      return { status: this.statusCode, headers: this.__headers, body: this.__body };
    },
  };
}

// Strip ES module syntax so the unit code can be eval'd as a plain script.
// Imports are expected to be provided as runtime globals; `export` is removed
// so `export async function handleRequest(…)` becomes a normal declaration.
var __code = __userSource
  .replace(/^\s*import\s+.*\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
  .replace(/^\s*import\s+['"][^'"]*['"];?\s*$/gm, '')
  .replace(/^export\s+/gm, '');

(0, eval)(__code);

if (typeof handleRequest !== 'function') {
  throw new Error('Unit must export a handleRequest(req, res) function');
}

var __req = __buildReq(__snap);
var __res = __createRes();
globalThis.__baal_res = __res;
globalThis.__baal_p = (async () => { await handleRequest(__req, __res); })();
