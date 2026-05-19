// RULES: thin proxy to Rust host functions. Never fetch() internal routes
// to reach platform primitives; use __baal_* host functions instead.
// See src/libs/unit_js/README.md.

function __buildReq(snap) {
  var headers = Object.create(null);
  var rawHeaders = [];
  for (var p = 0; p < snap.headerPairs.length; p++) {
    var pair = snap.headerPairs[p];
    var k = pair[0];
    var v = pair[1];
    var lk = k.toLowerCase();
    if (headers[lk] === undefined) headers[lk] = v;
    rawHeaders.push(k, v);
  }
  return {
    method: snap.method,
    url: snap.url,
    headers: headers,
    rawHeaders: rawHeaders,
    httpVersion: "1.1",
    __bodyText: snap.bodyText,
  };
}

function __createRes() {
  var _headers = {};
  var _body = "";
  var _statusCode = 200;
  var _statusMessage = "OK";

  return {
    get statusCode() { return _statusCode; },
    set statusCode(v) { _statusCode = v; },
    get statusMessage() { return _statusMessage; },
    set statusMessage(v) { _statusMessage = v; },

    setHeader: function (name, value) {
      var n = String(name).toLowerCase();
      if (Array.isArray(value)) {
        _headers[n] = value.map(String);
      } else {
        _headers[n] = String(value);
      }
    },

    getHeader: function (name) {
      return _headers[String(name).toLowerCase()];
    },

    hasHeader: function (name) {
      return String(name).toLowerCase() in _headers;
    },

    removeHeader: function (name) {
      delete _headers[String(name).toLowerCase()];
    },

    appendHeader: function (name, value) {
      var n = String(name).toLowerCase();
      var existing = _headers[n];
      if (existing === undefined) {
        _headers[n] = String(value);
      } else if (Array.isArray(existing)) {
        existing.push(String(value));
      } else {
        _headers[n] = [existing, String(value)];
      }
    },

    getHeaders: function () {
      var out = Object.create(null);
      var keys = Object.keys(_headers);
      for (var i = 0; i < keys.length; i++) {
        out[keys[i]] = _headers[keys[i]];
      }
      return out;
    },

    getHeaderNames: function () {
      return Object.keys(_headers);
    },

    writeHead: function (statusCode, statusMessage, headers) {
      _statusCode = statusCode;
      if (typeof statusMessage === "string") {
        _statusMessage = statusMessage;
      } else if (typeof statusMessage === "object" && statusMessage !== null) {
        headers = statusMessage;
      }
      if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i].toLowerCase();
          _headers[k] = String(headers[keys[i]]);
        }
      }
    },

    write: function (chunk) {
      if (chunk !== undefined && chunk !== null) {
        _body += String(chunk);
      }
    },

    end: function (chunk) {
      if (chunk !== undefined && chunk !== null) {
        _body += String(chunk);
      }
    },

    __snapshot: function () {
      var headerPairs = [];
      var keys = Object.keys(_headers);
      for (var i = 0; i < keys.length; i++) {
        var val = _headers[keys[i]];
        if (Array.isArray(val)) {
          for (var j = 0; j < val.length; j++) {
            headerPairs.push({ name: keys[i], value: val[j] });
          }
        } else {
          headerPairs.push({ name: keys[i], value: String(val) });
        }
      }
      return { status: _statusCode, headers: headerPairs, body: _body };
    },
  };
}

globalThis.__baal_p = (async function () {
  var mod = await import("baal-unit-entry");
  if (typeof mod.handleRequest !== "function") {
    throw new Error("Unit must export a handleRequest(req, res) function");
  }
  var __req = __buildReq(__snap);
  var __res = __createRes();
  globalThis.__baal_res = __res;
  await mod.handleRequest(__req, __res);
})();
