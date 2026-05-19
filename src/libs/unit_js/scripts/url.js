(function () {
  "use strict";
  var _parseUrl = __parse_url;

  // ---- URLSearchParams ----

  function _percentEncode(c) {
    var code = c.charCodeAt(0);
    if (code <= 0x7F) return "%" + ("0" + code.toString(16).toUpperCase()).slice(-2);
    var encoded = encodeURIComponent(c);
    return encoded;
  }

  function _encodeComponent(str) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      var code = c.charCodeAt(0);
      if (
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5A) || // A-Z
        (code >= 0x61 && code <= 0x7A) || // a-z
        c === "*" || c === "-" || c === "." || c === "_"
      ) {
        out += c;
      } else if (c === " ") {
        out += "+";
      } else {
        out += encodeURIComponent(c);
      }
    }
    return out;
  }

  function _decodeComponent(str) {
    try {
      return decodeURIComponent(str.replace(/\+/g, " "));
    } catch (e) {
      return str;
    }
  }

  function URLSearchParams(init) {
    this._pairs = [];
    if (!init) return;

    if (typeof init === "string") {
      var s = init;
      if (s[0] === "?") s = s.slice(1);
      if (!s) return;
      var parts = s.split("&");
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        var eq = p.indexOf("=");
        if (eq < 0) {
          this._pairs.push([_decodeComponent(p), ""]);
        } else {
          this._pairs.push([_decodeComponent(p.slice(0, eq)), _decodeComponent(p.slice(eq + 1))]);
        }
      }
    } else if (Array.isArray(init)) {
      for (var i = 0; i < init.length; i++) {
        this._pairs.push([String(init[i][0]), String(init[i][1])]);
      }
    } else if (init instanceof URLSearchParams) {
      for (var i = 0; i < init._pairs.length; i++) {
        this._pairs.push([init._pairs[i][0], init._pairs[i][1]]);
      }
    } else if (typeof init === "object") {
      var keys = Object.keys(init);
      for (var i = 0; i < keys.length; i++) {
        this._pairs.push([keys[i], String(init[keys[i]])]);
      }
    }
  }

  URLSearchParams.prototype.get = function (name) {
    for (var i = 0; i < this._pairs.length; i++) {
      if (this._pairs[i][0] === name) return this._pairs[i][1];
    }
    return null;
  };

  URLSearchParams.prototype.getAll = function (name) {
    var result = [];
    for (var i = 0; i < this._pairs.length; i++) {
      if (this._pairs[i][0] === name) result.push(this._pairs[i][1]);
    }
    return result;
  };

  URLSearchParams.prototype.set = function (name, value) {
    var found = false;
    var newPairs = [];
    for (var i = 0; i < this._pairs.length; i++) {
      if (this._pairs[i][0] === name) {
        if (!found) {
          newPairs.push([name, String(value)]);
          found = true;
        }
      } else {
        newPairs.push(this._pairs[i]);
      }
    }
    if (!found) newPairs.push([name, String(value)]);
    this._pairs = newPairs;
  };

  URLSearchParams.prototype.append = function (name, value) {
    this._pairs.push([String(name), String(value)]);
  };

  URLSearchParams.prototype.has = function (name) {
    for (var i = 0; i < this._pairs.length; i++) {
      if (this._pairs[i][0] === name) return true;
    }
    return false;
  };

  URLSearchParams.prototype["delete"] = function (name) {
    this._pairs = this._pairs.filter(function (p) { return p[0] !== name; });
  };

  URLSearchParams.prototype.sort = function () {
    this._pairs.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
  };

  URLSearchParams.prototype.toString = function () {
    return this._pairs
      .map(function (p) { return _encodeComponent(p[0]) + "=" + _encodeComponent(p[1]); })
      .join("&");
  };

  URLSearchParams.prototype.entries = function () {
    var pairs = this._pairs;
    var i = 0;
    return {
      next: function () {
        if (i >= pairs.length) return { done: true, value: undefined };
        var p = pairs[i++];
        return { done: false, value: [p[0], p[1]] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };

  URLSearchParams.prototype.keys = function () {
    var pairs = this._pairs;
    var i = 0;
    return {
      next: function () {
        if (i >= pairs.length) return { done: true, value: undefined };
        return { done: false, value: pairs[i++][0] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };

  URLSearchParams.prototype.values = function () {
    var pairs = this._pairs;
    var i = 0;
    return {
      next: function () {
        if (i >= pairs.length) return { done: true, value: undefined };
        return { done: false, value: pairs[i++][1] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };

  URLSearchParams.prototype.forEach = function (callback, thisArg) {
    for (var i = 0; i < this._pairs.length; i++) {
      callback.call(thisArg, this._pairs[i][1], this._pairs[i][0], this);
    }
  };

  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;

  URLSearchParams.prototype.size = undefined;
  Object.defineProperty(URLSearchParams.prototype, "size", {
    get: function () { return this._pairs.length; },
    enumerable: false,
  });

  globalThis.URLSearchParams = URLSearchParams;

  // ---- URL ----

  function URL(input, base) {
    if (!(this instanceof URL))
      throw new TypeError("Constructor URL requires 'new'");
    this._p = _parseUrl(input, base !== undefined ? String(base) : "");
    this._sp = null;
  }

  Object.defineProperties(URL.prototype, {
    href: {
      get: function () { return this._p.href; },
      enumerable: true,
    },
    protocol: {
      get: function () { return this._p.protocol; },
      enumerable: true,
    },
    hostname: {
      get: function () { return this._p.hostname; },
      enumerable: true,
    },
    port: {
      get: function () { return this._p.port; },
      enumerable: true,
    },
    host: {
      get: function () { return this._p.host; },
      enumerable: true,
    },
    origin: {
      get: function () { return this._p.origin; },
      enumerable: true,
    },
    username: {
      get: function () { return this._p.username; },
      enumerable: true,
    },
    password: {
      get: function () { return this._p.password; },
      enumerable: true,
    },
    pathname: {
      get: function () { return this._p.pathname; },
      set: function (val) {
        this._p = _parseUrl(
          this._p.protocol + "//" + this._p.host + val + this._p.search + this._p.hash
        );
      },
      enumerable: true,
    },
    search: {
      get: function () { return this._p.search; },
      set: function (val) {
        var s = val ? (val[0] === "?" ? val : "?" + val) : "";
        var base = this._p.href.split("?")[0].split("#")[0];
        this._p = _parseUrl(base + s + this._p.hash);
        this._sp = null;
      },
      enumerable: true,
    },
    hash: {
      get: function () { return this._p.hash; },
      set: function (val) {
        var h = val ? (val[0] === "#" ? val : "#" + val) : "";
        var base = this._p.href.split("#")[0];
        this._p = _parseUrl(base + h);
      },
      enumerable: true,
    },
    searchParams: {
      get: function () {
        if (!this._sp) {
          var url = this;
          var qs = this._p.search ? this._p.search.slice(1) : "";
          var sp = new URLSearchParams(qs);

          var origSet = sp.set.bind(sp);
          var origAppend = sp.append.bind(sp);
          var origDelete = sp["delete"].bind(sp);
          var origSort = sp.sort ? sp.sort.bind(sp) : null;

          function sync() {
            var s = sp.toString();
            var base = url._p.href.split("?")[0].split("#")[0];
            url._p = _parseUrl(base + (s ? "?" + s : "") + url._p.hash);
          }

          sp.set = function (k, v) { origSet(k, v); sync(); };
          sp.append = function (k, v) { origAppend(k, v); sync(); };
          sp["delete"] = function (k) { origDelete(k); sync(); };
          if (origSort) sp.sort = function () { origSort(); sync(); };

          this._sp = sp;
        }
        return this._sp;
      },
      enumerable: true,
    },
  });

  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };

  globalThis.URL = URL;
})();
