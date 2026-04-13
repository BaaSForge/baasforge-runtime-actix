(function () {
  "use strict";

  // ---- Timers (microtask-based for synchronous QuickJS) ----

  var __tid = 0;
  var __tc = {};

  globalThis.setTimeout = function (fn, _delay) {
    var id = ++__tid;
    var args = [].slice.call(arguments, 2);
    var ms = Number(_delay) || 0;
    if (ms > 0 && typeof __baal_sleep_sync === "function") {
      __baal_sleep_sync(ms);
    }
    queueMicrotask(function () {
      if (!__tc[id]) fn.apply(null, args);
      delete __tc[id];
    });
    return id;
  };

  globalThis.clearTimeout = function (id) { __tc[id] = true; };

  globalThis.setInterval = function (fn, _delay) {
    var id = ++__tid;
    var args = [].slice.call(arguments, 2);
    var count = 0;
    function tick() {
      if (__tc[id] || count >= 1000) return;
      count++;
      fn.apply(null, args);
      queueMicrotask(tick);
    }
    queueMicrotask(tick);
    return id;
  };

  globalThis.clearInterval = function (id) { __tc[id] = true; };

  globalThis.setTimeoutPromise = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };

  // ---- performance ----

  if (typeof globalThis.performance === "undefined") {
    var _t0 = Date.now();
    globalThis.performance = { now: function () { return Date.now() - _t0; } };
  }

  // ---- process (basic stub) ----

  if (typeof globalThis.process === "undefined") {
    globalThis.process = {
      env: {},
      version: "v20.0.0",
      platform: "linux",
      arch: "x64",
      pid: 1,
      cwd: function () { return "/"; },
      hrtime: { bigint: function () { return BigInt(Date.now()) * BigInt(1000000); } },
      nextTick: function (fn) { queueMicrotask(fn); },
    };
  }

  // ---- DOMException ----

  if (typeof globalThis.DOMException === "undefined") {
    function DOMException(message, name) {
      Error.call(this, message);
      this.message = message || "";
      this.name = name || "Error";
    }
    DOMException.prototype = Object.create(Error.prototype);
    DOMException.prototype.constructor = DOMException;
    globalThis.DOMException = DOMException;
  }

  // ---- Event / CustomEvent / EventTarget ----

  if (typeof globalThis.Event === "undefined") {
    function Event(type, options) {
      this.type = type;
      this.bubbles = !!(options && options.bubbles);
      this.cancelable = !!(options && options.cancelable);
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.timeStamp = Date.now();
    }
    Event.prototype.preventDefault = function () {
      if (this.cancelable) this.defaultPrevented = true;
    };
    Event.prototype.stopPropagation = function () {};
    Event.prototype.stopImmediatePropagation = function () {};
    globalThis.Event = Event;
  }

  if (typeof globalThis.CustomEvent === "undefined") {
    function CustomEvent(type, options) {
      Event.call(this, type, options);
      this.detail = options && options.detail !== undefined ? options.detail : null;
    }
    CustomEvent.prototype = Object.create(Event.prototype);
    CustomEvent.prototype.constructor = CustomEvent;
    globalThis.CustomEvent = CustomEvent;
  }

  if (typeof globalThis.EventTarget === "undefined") {
    function EventTarget() {
      this.__listeners = {};
    }
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (!this.__listeners[type]) this.__listeners[type] = [];
      this.__listeners[type].push({ fn: fn, once: !!(opts && opts.once) });
    };
    EventTarget.prototype.removeEventListener = function (type, fn) {
      var arr = this.__listeners[type];
      if (!arr) return;
      this.__listeners[type] = arr.filter(function (l) { return l.fn !== fn; });
    };
    EventTarget.prototype.dispatchEvent = function (event) {
      event.target = this;
      event.currentTarget = this;
      var arr = (this.__listeners[event.type] || []).slice();
      var toRemove = [];
      for (var i = 0; i < arr.length; i++) {
        arr[i].fn.call(this, event);
        if (arr[i].once) toRemove.push(arr[i].fn);
      }
      for (var j = 0; j < toRemove.length; j++) {
        this.removeEventListener(event.type, toRemove[j]);
      }
      return !event.defaultPrevented;
    };
    globalThis.EventTarget = EventTarget;
  }

  // ---- AbortSignal / AbortController ----

  function AbortSignal() {
    EventTarget.call(this);
    this.__listeners = {};
    this.aborted = false;
    this.reason = undefined;
  }
  AbortSignal.prototype = Object.create(EventTarget.prototype);
  AbortSignal.prototype.constructor = AbortSignal;
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason;
  };

  AbortSignal.abort = function (reason) {
    var s = new AbortSignal();
    s.aborted = true;
    s.reason = reason !== undefined ? reason : new DOMException("The operation was aborted.", "AbortError");
    return s;
  };

  AbortSignal.timeout = function (ms) {
    var s = new AbortSignal();
    setTimeout(function () {
      if (!s.aborted) {
        s.aborted = true;
        s.reason = new DOMException("The operation timed out.", "TimeoutError");
        s.dispatchEvent(new Event("abort"));
      }
    }, ms);
    return s;
  };

  AbortSignal.any = function (signals) {
    var combined = new AbortSignal();
    for (var i = 0; i < signals.length; i++) {
      if (signals[i].aborted) {
        combined.aborted = true;
        combined.reason = signals[i].reason;
        return combined;
      }
    }
    for (var i = 0; i < signals.length; i++) {
      (function (sig) {
        sig.addEventListener("abort", function () {
          if (!combined.aborted) {
            combined.aborted = true;
            combined.reason = sig.reason;
            combined.dispatchEvent(new Event("abort"));
          }
        });
      })(signals[i]);
    }
    return combined;
  };

  globalThis.AbortSignal = AbortSignal;

  function AbortController() {
    this.signal = new AbortSignal();
  }
  AbortController.prototype.abort = function (reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason !== undefined ? reason : new DOMException("The operation was aborted.", "AbortError");
    this.signal.dispatchEvent(new Event("abort"));
  };
  globalThis.AbortController = AbortController;

  // ---- Headers ----

  function Headers(init) {
    this._map = {};
    this._order = [];
    if (init) {
      if (init instanceof Headers) {
        var self = this;
        init.forEach(function (val, key) { self.append(key, val); });
      } else if (Array.isArray(init)) {
        for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      } else if (typeof init === "object") {
        var keys = Object.keys(init);
        for (var i = 0; i < keys.length; i++) this.append(keys[i], init[keys[i]]);
      }
    }
  }
  Headers.prototype.get = function (n) {
    var k = n.toLowerCase();
    return this._map[k] ? this._map[k].join(", ") : null;
  };
  Headers.prototype.set = function (n, v) {
    var k = n.toLowerCase();
    if (!this._map[k]) this._order.push(k);
    this._map[k] = [String(v)];
  };
  Headers.prototype.append = function (n, v) {
    var k = n.toLowerCase();
    if (!this._map[k]) { this._map[k] = []; this._order.push(k); }
    this._map[k].push(String(v));
  };
  Headers.prototype.has = function (n) { return n.toLowerCase() in this._map; };
  Headers.prototype["delete"] = function (n) {
    var k = n.toLowerCase();
    delete this._map[k];
    this._order = this._order.filter(function (x) { return x !== k; });
  };
  Headers.prototype.entries = function () {
    var self = this, keys = this._order.slice(), i = 0;
    return {
      next: function () {
        if (i >= keys.length) return { done: true, value: undefined };
        var k = keys[i++];
        return { done: false, value: [k, self._map[k].join(", ")] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  Headers.prototype.keys = function () {
    var keys = this._order.slice(), i = 0;
    return {
      next: function () {
        if (i >= keys.length) return { done: true, value: undefined };
        return { done: false, value: keys[i++] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  Headers.prototype.values = function () {
    var self = this, keys = this._order.slice(), i = 0;
    return {
      next: function () {
        if (i >= keys.length) return { done: true, value: undefined };
        return { done: false, value: self._map[keys[i++]].join(", ") };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  Headers.prototype.forEach = function (cb, thisArg) {
    for (var i = 0; i < this._order.length; i++) {
      var k = this._order[i];
      cb.call(thisArg, this._map[k].join(", "), k, this);
    }
  };
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  globalThis.Headers = Headers;

  // ---- ReadableStream / WritableStream / TransformStream ----

  function ReadableStream(source) {
    this._q = [];
    this._closed = false;
    this._waiters = [];
    this._src = source || {};
    this._locked = false;
    this._cancelFn = this._src.cancel || null;
    var self = this;
    this._ctrl = {
      enqueue: function (c) {
        self._q.push(c);
        while (self._waiters.length > 0 && self._q.length > 0)
          self._waiters.shift()({ done: false, value: self._q.shift() });
      },
      close: function () {
        self._closed = true;
        while (self._waiters.length > 0)
          self._waiters.shift()({ done: true, value: undefined });
      },
      error: function () {
        self._closed = true;
        while (self._waiters.length > 0)
          self._waiters.shift()({ done: true, value: undefined });
      },
      desiredSize: 1
    };
    if (this._src.start) this._src.start(this._ctrl);
  }

  ReadableStream.prototype.getReader = function () {
    this._locked = true;
    var s = this;
    return {
      read: function () {
        if (s._q.length > 0) return Promise.resolve({ done: false, value: s._q.shift() });
        if (s._closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(function (resolve) {
          s._waiters.push(resolve);
          if (s._src.pull && !s._closed) {
            try { s._src.pull(s._ctrl); } catch (_) {}
          }
        });
      },
      releaseLock: function () { s._locked = false; },
      cancel: function (r) { return s.cancel(r); }
    };
  };

  ReadableStream.prototype.cancel = function (reason) {
    this._closed = true;
    while (this._waiters.length) this._waiters.shift()({ done: true, value: undefined });
    if (this._cancelFn) this._cancelFn(reason);
    return Promise.resolve();
  };

  ReadableStream.prototype.tee = function () {
    var reader = this.getReader();
    var q1 = [], q2 = [], w1 = [], w2 = [], done = false;

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          done = true;
          while (w1.length) w1.shift()({ done: true, value: undefined });
          while (w2.length) w2.shift()({ done: true, value: undefined });
          return;
        }
        q1.push(r.value); q2.push(r.value);
        while (w1.length && q1.length) w1.shift()({ done: false, value: q1.shift() });
        while (w2.length && q2.length) w2.shift()({ done: false, value: q2.shift() });
        return pump();
      });
    }
    pump();

    function makeTeeBranch(q, w) {
      return new ReadableStream({
        pull: function (_ctrl) {
          if (q.length > 0) { _ctrl.enqueue(q.shift()); return; }
          if (done) { _ctrl.close(); return; }
          return new Promise(function (resolve) {
            w.push(function (result) {
              if (result.done) _ctrl.close();
              else _ctrl.enqueue(result.value);
              resolve();
            });
          });
        }
      });
    }
    return [makeTeeBranch(q1, w1), makeTeeBranch(q2, w2)];
  };

  ReadableStream.prototype.pipeTo = function (ws) {
    var reader = this.getReader();
    var writer = ws.getWriter();
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return writer.close();
        return writer.write(r.value).then(pump);
      });
    }
    return pump();
  };

  ReadableStream.prototype.pipeThrough = function (ts) {
    var reader = this.getReader();
    var writer = ts.writable.getWriter();
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return writer.close();
        return writer.write(r.value).then(pump);
      });
    }
    pump();
    return ts.readable;
  };

  globalThis.ReadableStream = ReadableStream;

  function WritableStream(sink) {
    this._sink = sink || {};
    this._closed = false;
  }
  WritableStream.prototype.getWriter = function () {
    var s = this;
    return {
      write: function (chunk) {
        if (s._sink.write) {
          var r = s._sink.write(chunk);
          return r instanceof Promise ? r : Promise.resolve();
        }
        return Promise.resolve();
      },
      close: function () {
        s._closed = true;
        if (s._sink.close) { var r = s._sink.close(); return r instanceof Promise ? r : Promise.resolve(); }
        return Promise.resolve();
      },
      abort: function (reason) {
        s._closed = true;
        if (s._sink.abort) s._sink.abort(reason);
        return Promise.resolve();
      },
      releaseLock: function () {}
    };
  };
  globalThis.WritableStream = WritableStream;

  function TransformStream(transformer) {
    var tf = transformer || {};
    var readableCtrl;

    this.readable = new ReadableStream({
      start: function (ctrl) { readableCtrl = ctrl; }
    });

    var self = this;
    this.writable = new WritableStream({
      write: function (chunk) {
        if (tf.transform) {
          return tf.transform(chunk, readableCtrl);
        }
        readableCtrl.enqueue(chunk);
      },
      close: function () {
        if (tf.flush) tf.flush(readableCtrl);
        readableCtrl.close();
      }
    });
  }
  globalThis.TransformStream = TransformStream;

  // TextEncoderStream / TextDecoderStream stubs
  globalThis.TextEncoderStream = function () {
    return new TransformStream({
      transform: function (chunk, ctrl) {
        ctrl.enqueue(new TextEncoder().encode(chunk));
      }
    });
  };
  globalThis.TextDecoderStream = function () {
    return new TransformStream({
      transform: function (chunk, ctrl) {
        ctrl.enqueue(new TextDecoder().decode(chunk));
      }
    });
  };

  // ---- Blob ----

  function Blob(parts, options) {
    this._bytes = [];
    if (parts) {
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (typeof part === "string") {
          var enc = new TextEncoder().encode(part);
          for (var j = 0; j < enc.length; j++) this._bytes.push(enc[j]);
        } else if (part instanceof Blob) {
          for (var j = 0; j < part._bytes.length; j++) this._bytes.push(part._bytes[j]);
        } else if (part instanceof ArrayBuffer) {
          var view = new Uint8Array(part);
          for (var j = 0; j < view.length; j++) this._bytes.push(view[j]);
        } else if (ArrayBuffer.isView(part)) {
          var u8 = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
          for (var j = 0; j < u8.length; j++) this._bytes.push(u8[j]);
        }
      }
    }
    this.type = (options && options.type) ? String(options.type).toLowerCase() : "";
  }
  Object.defineProperty(Blob.prototype, "size", {
    get: function () { return this._bytes.length; },
    enumerable: true
  });
  Blob.prototype.text = function () {
    return Promise.resolve(new TextDecoder().decode(new Uint8Array(this._bytes)));
  };
  Blob.prototype.arrayBuffer = function () {
    var u8 = new Uint8Array(this._bytes);
    return Promise.resolve(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  };
  Blob.prototype.slice = function (start, end, type) {
    var s = start || 0;
    var e = end !== undefined ? end : this._bytes.length;
    var b = new Blob([], { type: type || this.type });
    b._bytes = this._bytes.slice(s, e);
    return b;
  };
  Blob.prototype.stream = function () {
    var bytes = this._bytes;
    return new ReadableStream({
      start: function (ctrl) {
        ctrl.enqueue(new Uint8Array(bytes));
        ctrl.close();
      }
    });
  };
  globalThis.Blob = Blob;

  // ---- FormData ----

  function FormData() { this._entries = []; }
  FormData.prototype.append = function (n, v, fn) {
    this._entries.push({ name: String(n), value: v, filename: fn });
  };
  FormData.prototype.set = function (n, v, fn) {
    var name = String(n);
    this._entries = this._entries.filter(function (e) { return e.name !== name; });
    this._entries.push({ name: name, value: v, filename: fn });
  };
  FormData.prototype.get = function (n) {
    for (var i = 0; i < this._entries.length; i++)
      if (this._entries[i].name === String(n)) return this._entries[i].value;
    return null;
  };
  FormData.prototype.getAll = function (n) {
    var name = String(n);
    return this._entries.filter(function (e) { return e.name === name; })
      .map(function (e) { return e.value; });
  };
  FormData.prototype.has = function (n) {
    var name = String(n);
    return this._entries.some(function (e) { return e.name === name; });
  };
  FormData.prototype["delete"] = function (n) {
    var name = String(n);
    this._entries = this._entries.filter(function (e) { return e.name !== name; });
  };
  FormData.prototype.entries = function () {
    var arr = this._entries, i = 0;
    return {
      next: function () {
        if (i >= arr.length) return { done: true, value: undefined };
        var e = arr[i++]; return { done: false, value: [e.name, e.value] };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  FormData.prototype.keys = function () {
    var arr = this._entries, i = 0;
    return {
      next: function () {
        if (i >= arr.length) return { done: true, value: undefined };
        return { done: false, value: arr[i++].name };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  FormData.prototype.values = function () {
    var arr = this._entries, i = 0;
    return {
      next: function () {
        if (i >= arr.length) return { done: true, value: undefined };
        return { done: false, value: arr[i++].value };
      },
      [Symbol.iterator]: function () { return this; }
    };
  };
  FormData.prototype.forEach = function (cb, thisArg) {
    for (var i = 0; i < this._entries.length; i++) {
      var e = this._entries[i]; cb.call(thisArg, e.value, e.name, this);
    }
  };
  FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
  globalThis.FormData = FormData;

  globalThis.__baalModules = globalThis.__baalModules || {};
  globalThis.__baalModules['node:util'] = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
  globalThis.__baalModules['node:timers/promises'] = { setTimeout: globalThis.setTimeoutPromise };

  // ---- Request ----

  function Request(input, init) {
    init = init || {};
    if (input instanceof Request) {
      this.url = input.url;
      this.method = input.method;
      this.headers = new Headers(input.headers);
      this._body = input._body || null;
    } else {
      this.url = String(input);
      this.method = "GET";
      this.headers = new Headers();
      this._body = null;
    }
    if (init.method) this.method = init.method.toUpperCase();
    if (init.headers) this.headers = new Headers(init.headers);
    if (init.body !== undefined) this._body = init.body;
    if (init.signal) this.signal = init.signal;
  }
  Request.prototype.clone = function () {
    return new Request(this);
  };
  Request.prototype.text = function () {
    return Promise.resolve(this._body ? String(this._body) : "");
  };
  Request.prototype.json = function () {
    return this.text().then(JSON.parse);
  };
  globalThis.Request = Request;

  // ---- Response ----

  function Response(body, init) {
    init = init || {};
    this.status = init.status !== undefined ? init.status : 200;
    this.statusText = init.statusText || "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);

    if (body === null || body === undefined) {
      this._bodyBytes = null;
      this._bodyText = "";
    } else if (typeof body === "string") {
      this._bodyBytes = null;
      this._bodyText = body;
    } else if (body instanceof ReadableStream) {
      this._bodyStream = body;
      this._bodyBytes = null;
      this._bodyText = null;
    } else if (body instanceof ArrayBuffer) {
      this._bodyBytes = new Uint8Array(body);
      this._bodyText = null;
    } else if (ArrayBuffer.isView(body)) {
      this._bodyBytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      this._bodyText = null;
    } else {
      this._bodyBytes = null;
      this._bodyText = String(body);
    }
    this._consumed = false;
  }

  Object.defineProperty(Response.prototype, "body", {
    get: function () {
      if (this._bodyStream) return this._bodyStream;
      var bytes;
      if (this._bodyBytes) {
        bytes = this._bodyBytes;
      } else if (this._bodyText != null) {
        bytes = new TextEncoder().encode(this._bodyText);
      } else {
        bytes = new Uint8Array(0);
      }
      return new ReadableStream({
        start: function (ctrl) { ctrl.enqueue(bytes); ctrl.close(); }
      });
    }
  });

  Response.prototype._getBytes = function () {
    var self = this;
    if (this._bodyStream) {
      var reader = this._bodyStream.getReader();
      var chunks = [];
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var total = 0;
            for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
            var result = new Uint8Array(total);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              var c = chunks[i] instanceof Uint8Array ? chunks[i] : new Uint8Array(chunks[i]);
              result.set(c, off);
              off += c.length;
            }
            self._bodyBytes = result;
            self._bodyStream = null;
            return result;
          }
          chunks.push(r.value);
          return pump();
        });
      }
      return pump();
    }
    if (this._bodyBytes) return Promise.resolve(this._bodyBytes);
    if (this._bodyText != null) {
      var bytes = new TextEncoder().encode(this._bodyText);
      return Promise.resolve(bytes);
    }
    return Promise.resolve(new Uint8Array(0));
  };

  Response.prototype.text = function () {
    return this._getBytes().then(function (bytes) {
      return new TextDecoder().decode(bytes);
    });
  };
  Response.prototype.json = function () {
    return this.text().then(JSON.parse);
  };
  Response.prototype.arrayBuffer = function () {
    return this._getBytes().then(function (bytes) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    });
  };
  Response.prototype.blob = function () {
    return this._getBytes().then(function (bytes) {
      return new Blob([bytes]);
    });
  };
  Response.prototype.clone = function () {
    var r = new Response(null, {
      status: this.status, statusText: this.statusText, headers: new Headers(this.headers)
    });
    r._bodyText = this._bodyText;
    r._bodyBytes = this._bodyBytes;
    r._bodyStream = null;
    return r;
  };

  Response.json = function (data, init) {
    init = init || {};
    var headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), {
      status: init.status || 200, statusText: init.statusText || "", headers: headers
    });
  };
  Response.redirect = function (url, status) {
    var h = new Headers();
    h.set("location", url);
    return new Response(null, { status: status || 302, headers: h });
  };

  globalThis.Response = Response;

  // ---- Intl (minimal stubs) ----

  if (typeof globalThis.Intl === "undefined") {
    var Intl = {};

    Intl.DateTimeFormat = function (locale, options) {
      this._locale = locale || "en";
      this._options = options || {};
    };
    Intl.DateTimeFormat.prototype.format = function (date) {
      var d = date || new Date();
      var opts = this._options;
      var parts = [];
      if (opts.month) {
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        parts.push(months[d.getUTCMonth()]);
      }
      if (opts.day) parts.push(d.getUTCDate());
      if (opts.year) parts.push(d.getUTCFullYear());
      return parts.length > 0 ? parts.join(" ") : d.toISOString();
    };
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { locale: this._locale };
    };

    Intl.NumberFormat = function (locale, options) {
      this._locale = locale || "en";
      this._options = options || {};
    };
    Intl.NumberFormat.prototype.format = function (n) {
      var s = n.toFixed(2);
      var parts = s.split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      var result = parts.join(".");
      if (this._options.style === "currency") {
        result = "$" + result;
      }
      return result;
    };
    Intl.NumberFormat.prototype.resolvedOptions = function () {
      return { locale: this._locale };
    };

    Intl.Collator = function (locale, options) {
      this._locale = locale || "en";
      this._sensitivity = (options && options.sensitivity) || "variant";
    };
    Intl.Collator.prototype.compare = function (a, b) {
      var x = a, y = b;
      if (this._sensitivity === "base") {
        x = a.toLowerCase(); y = b.toLowerCase();
      }
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    };
    Intl.Collator.prototype.resolvedOptions = function () {
      return { locale: this._locale };
    };

    Intl.PluralRules = function (locale) {
      this._locale = locale || "en";
    };
    Intl.PluralRules.prototype.select = function (n) {
      return n === 1 ? "one" : "other";
    };
    Intl.PluralRules.prototype.resolvedOptions = function () {
      return { locale: this._locale };
    };

    globalThis.Intl = Intl;
  }
})();
