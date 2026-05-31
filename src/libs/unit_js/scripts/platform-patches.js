// Platform patches: Node.js-compatible APIs missing or broken in this LLRT build.
// All patches guard against future LLRT additions and are skipped when LLRT provides
// a working native version.


// ── Intl extensions ───────────────────────────────────────────────────────────
// LLRT replaces Intl with only DateTimeFormat + supportedValuesOf.
// These lightweight stubs cover the dominant en-US server-side use cases.
(function patchIntl() {
  var intl = globalThis.Intl || (globalThis.Intl = {});

  if (!intl.NumberFormat) {
    var CURRENCY_SYMBOLS = { USD:'$',EUR:'€',GBP:'£',JPY:'¥',CAD:'CA$',AUD:'A$',CHF:'CHF\u00a0' };
    intl.NumberFormat = function NumberFormat(locale, opts) {
      if (!(this instanceof NumberFormat)) return new NumberFormat(locale, opts);
      this._opts = opts || {};
    };
    intl.NumberFormat.prototype.format = function(value) {
      var n = Number(value), o = this._opts;
      var isCurrency = o.style === 'currency';
      var isPercent  = o.style === 'percent';
      var minF = o.minimumFractionDigits != null ? o.minimumFractionDigits : (isCurrency ? 2 : 0);
      var maxF = o.maximumFractionDigits != null ? o.maximumFractionDigits : (isCurrency ? 2 : 3);
      var fixed = (isPercent ? n * 100 : n).toFixed(Math.max(minF, Math.min(maxF, 20)));
      var parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      var result = (minF > 0 || parts[1]) ? parts.join('.') : parts[0];
      if (isCurrency) return (CURRENCY_SYMBOLS[o.currency] || (o.currency + '\u00a0')) + result;
      if (isPercent)  return result + '%';
      return result;
    };
    intl.NumberFormat.prototype.formatToParts = function(value) {
      return [{ type: 'literal', value: this.format(value) }];
    };
    intl.NumberFormat.supportedLocalesOf = function() { return []; };
  }

  if (!intl.Collator) {
    intl.Collator = function Collator(locale, opts) {
      if (!(this instanceof Collator)) return new Collator(locale, opts);
      this._sensitivity = (opts && opts.sensitivity) || 'variant';
    };
    intl.Collator.prototype.compare = function(a, b) {
      var s = this._sensitivity;
      var fold = s === 'base' || s === 'accent';
      var na = fold ? String(a).toLowerCase() : String(a);
      var nb = fold ? String(b).toLowerCase() : String(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    };
    intl.Collator.supportedLocalesOf = function() { return []; };
  }

  if (!intl.PluralRules) {
    intl.PluralRules = function PluralRules(locale, opts) {
      if (!(this instanceof PluralRules)) return new PluralRules(locale, opts);
    };
    intl.PluralRules.prototype.select = function(n) {
      return Math.abs(n) === 1 ? 'one' : 'other';
    };
    intl.PluralRules.supportedLocalesOf = function() { return []; };
  }
}());

// ── structuredClone ───────────────────────────────────────────────────────────
if (typeof structuredClone === 'undefined') {
  globalThis.structuredClone = function structuredClone(val, options) {
    void options;
    function clone(v, seen) {
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
      if (typeof v === 'function') throw new TypeError('structuredClone: functions are not cloneable');
      if (seen.has(v)) return seen.get(v);
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof RegExp) return new RegExp(v.source, v.flags);
      if (v instanceof Map) {
        var m = new Map();
        seen.set(v, m);
        v.forEach(function(val, key) { m.set(clone(key, seen), clone(val, seen)); });
        return m;
      }
      if (v instanceof Set) {
        var s = new Set();
        seen.set(v, s);
        v.forEach(function(val) { s.add(clone(val, seen)); });
        return s;
      }
      if (ArrayBuffer.isView(v)) {
        var buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        return new v.constructor(buf);
      }
      if (v instanceof ArrayBuffer) return v.slice(0);
      var out = Array.isArray(v) ? [] : Object.create(Object.getPrototypeOf(v));
      seen.set(v, out);
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = clone(v[keys[i]], seen);
      return out;
    }
    return clone(val, new Map());
  };
}

// ── AbortSignal event object ──────────────────────────────────────────────────
// LLRT fires "abort" with no args (vec![] in Rust). We maintain our own
// WeakMap listener registry and override AbortController.abort() to dispatch
// a proper { type, target } event object to those listeners ourselves.
// Non-"abort" events and LLRT-internal abort listeners (e.g. AbortSignal.any)
// continue to use the native EventEmitter path unchanged.
(function patchAbortSignalEvent() {
  if (typeof AbortController === 'undefined' || typeof AbortSignal === 'undefined') return;

  var origAbort = AbortController.prototype.abort;
  var origAEL   = AbortSignal.prototype.addEventListener;
  var origREL   = AbortSignal.prototype.removeEventListener;
  if (!origAbort || !origAEL) return;

  // WeakMap<AbortSignal, Array<{ listener, once }>>
  var registry = new WeakMap();

  AbortSignal.prototype.addEventListener = function addEventListener(type, listener, options) {
    if (type === 'abort' && typeof listener === 'function') {
      var list = registry.get(this);
      if (!list) { list = []; registry.set(this, list); }
      var once = !!(options && options.once);
      list.push({ listener: listener, once: once });
      return;
    }
    return origAEL.call(this, type, listener, options);
  };

  AbortSignal.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    if (type === 'abort') {
      var list = registry.get(this);
      if (list) {
        var idx = list.findIndex(function(item) { return item.listener === listener; });
        if (idx !== -1) list.splice(idx, 1);
      }
      return;
    }
    return origREL.call(this, type, listener, options);
  };

  AbortController.prototype.abort = function abort(reason) {
    var signal = this.signal;
    if (signal.aborted) return;
    // Let LLRT set aborted=true and reason; no native listeners registered so
    // emit_str fires harmlessly.
    origAbort.call(this, reason);
    // Dispatch our listeners with a proper Event-like object.
    var event = { type: 'abort', target: signal };
    var list = registry.get(signal);
    if (!list || list.length === 0) return;
    var snapshot = list.slice();
    registry.set(signal, list.filter(function(item) { return !item.once; }));
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i].listener.call(signal, event); } catch (_) {}
    }
  };
}());

// ── Buffer ────────────────────────────────────────────────────────────────────
(function patchBuffer() {
  if (typeof Buffer === 'undefined') return;
  var proto = Buffer.prototype;

  if (!Buffer.compare) {
    Buffer.compare = function compare(a, b) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    };
  }

  if (!proto.equals) {
    proto.equals = function equals(other) {
      if (this.length !== other.length) return false;
      for (var i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) return false;
      }
      return true;
    };
  }

  // Uint8Array.prototype.indexOf only handles numbers; replace with string-aware version.
  if (!proto.indexOf || proto.indexOf === Uint8Array.prototype.indexOf) {
    proto.indexOf = function indexOf(val, byteOffset) {
      var start = (byteOffset | 0) < 0
        ? Math.max(0, this.length + (byteOffset | 0))
        : (byteOffset | 0);
      var needle;
      if (typeof val === 'number') {
        needle = [val & 0xFF];
      } else if (typeof val === 'string') {
        needle = Array.from(Buffer.from(val));
      } else {
        needle = Array.from(val);
      }
      if (needle.length === 0) return start;
      outer: for (var i = start; i <= this.length - needle.length; i++) {
        for (var j = 0; j < needle.length; j++) {
          if (this[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    };
  }

  if (!proto.includes || proto.includes === Uint8Array.prototype.includes) {
    proto.includes = function includes(val, byteOffset) {
      return this.indexOf(val, byteOffset) !== -1;
    };
  }

  if (!proto.toJSON) {
    proto.toJSON = function toJSON() {
      return { type: 'Buffer', data: Array.from(this) };
    };
  }
}());

// ── TransformStream ───────────────────────────────────────────────────────────
// LLRT v0.8.1-beta has TransformStream implemented in Rust (pub(crate)) but
// Class::define silently fails to register it as a global due to visibility.
// ReadableStream + WritableStream work correctly, so we build on top of them.
(function patchTransformStream() {
  if (typeof TransformStream !== 'undefined') return;
  if (typeof ReadableStream === 'undefined' || typeof WritableStream === 'undefined') return;

  globalThis.TransformStream = function TransformStream(transformer, writableStrategy, readableStrategy) {
    transformer = transformer || {};

    var readCtrl;
    var startResolve, startReject;
    var started = new Promise(function(res, rej) {
      startResolve = res;
      startReject = rej;
    });

    var transformFn = transformer.transform || function(chunk, ctrl) { ctrl.enqueue(chunk); };
    var flushFn = transformer.flush || function() {};

    this.readable = new ReadableStream({
      start: function(controller) {
        readCtrl = controller;
        var p = transformer.start
          ? Promise.resolve(transformer.start(controller))
          : Promise.resolve();
        p.then(startResolve, startReject);
      }
    }, readableStrategy);

    this.writable = new WritableStream({
      start: function() { return started; },
      write: function(chunk) {
        return Promise.resolve(transformFn(chunk, readCtrl));
      },
      close: function() {
        return Promise.resolve(flushFn(readCtrl)).then(function() {
          readCtrl.close();
        });
      },
      abort: function(reason) {
        readCtrl.error(reason);
      }
    }, writableStrategy);
  };
}());

// ── TextEncoderStream ─────────────────────────────────────────────────────────
if (typeof TextEncoderStream === "undefined") {
  globalThis.TextEncoderStream = function TextEncoderStream() {
    var encoder = new TextEncoder();
    var ts = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue(encoder.encode(String(chunk)));
      }
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  };
  Object.defineProperty(TextEncoderStream.prototype, "encoding", {
    get: function() { return "utf-8"; }
  });
}

// ── TextDecoderStream ─────────────────────────────────────────────────────────
if (typeof TextDecoderStream === "undefined") {
  globalThis.TextDecoderStream = function TextDecoderStream(encoding, options) {
    var decoder = new TextDecoder(encoding, options);
    var ts = new TransformStream({
      transform: function(chunk, controller) {
        var result = decoder.decode(chunk);
        if (result) controller.enqueue(result);
      }
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
    Object.defineProperty(this, "encoding", { value: decoder.encoding });
    Object.defineProperty(this, "fatal", { value: decoder.fatal });
    Object.defineProperty(this, "ignoreBOM", { value: decoder.ignoreBOM });
  };
}

// ── FormData (Node / undici parity) ───────────────────────────────────────────
// LLRT FormData: get() returns undefined (not null); append rejects Buffer and
// coercions; no 3-arg filename; Blob entries stay Blob on get; forEach omits
// thisArg; fetch() does not serialize FormData bodies (only Blob).
(function patchFormData() {
  if (typeof FormData === "undefined") return;

  var proto = FormData.prototype;
  var origAppend = proto.append;
  var origSet = proto.set;
  var origGet = proto.get;
  var origGetAll = proto.getAll;
  var origForEach = proto.forEach;
  if (!origAppend || !origGet) return;

  function bytesToLatin1String(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function coerceFormValue(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return value.toString("latin1");
    }
    if (ArrayBuffer.isView(value)) {
      return bytesToLatin1String(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
    }
    if (value instanceof Blob) return value;
    if (typeof File === "function" && value instanceof File) return value;
    return String(value);
  }

  function blobAsFile(blob, filename) {
    if (typeof File !== "function") return blob;
    var name = filename === undefined || filename === null ? "blob" : String(filename);
    return new File([blob], name, { type: blob.type || "" });
  }

  function normalizeOutgoingValue(value, filename) {
    var coerced = coerceFormValue(value);
    if (typeof coerced === "string") return coerced;
    if (coerced instanceof File) return coerced;
    if (coerced instanceof Blob) return blobAsFile(coerced, filename);
    return String(coerced);
  }

  function normalizeIncomingValue(value) {
    if (value === undefined) return null;
    if (value instanceof Blob && !(value instanceof File) && typeof File === "function") {
      return blobAsFile(value, "blob");
    }
    return value;
  }

  proto.append = function append(name, value, filename) {
    return origAppend.call(this, name, normalizeOutgoingValue(value, filename));
  };

  if (origSet) {
    proto.set = function set(name, value, filename) {
      return origSet.call(this, name, normalizeOutgoingValue(value, filename));
    };
  }

  proto.get = function get(name) {
    return normalizeIncomingValue(origGet.call(this, name));
  };

  if (origGetAll) {
    proto.getAll = function getAll(name) {
      var list = origGetAll.call(this, name);
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(normalizeIncomingValue(list[i]));
      return out;
    };
  }

  if (origForEach) {
    proto.forEach = function forEach(callback, thisArg) {
      var self = this;
      var cb = typeof thisArg === "undefined" ? callback : callback.bind(thisArg);
      origForEach.call(this, function(value, key) {
        cb(normalizeIncomingValue(value), key, self);
      });
    };
  }
}());

