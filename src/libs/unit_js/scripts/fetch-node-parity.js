// Fetch API parity with Node.js (undici): bodyless Request/Response.body are null;
// string/Uint8Array inits expose ReadableStream on .body; fetch() serializes Request bodies.
(function patchFetchNodeParity() {
  if (typeof Request === "undefined" || typeof ReadableStream === "undefined") return;
  if (typeof globalThis.fetch !== "function") return;

  if (!globalThis.__baalNativeRequest) {
    globalThis.__baalNativeRequest = Request;
    globalThis.__baalNativeResponse = Response;
    globalThis.__baalNativeFetch = globalThis.fetch.bind(globalThis);
  }
  if (globalThis.__baalFetchNodeParityPatched) return;
  globalThis.__baalFetchNodeParityPatched = true;

  var NativeRequest = globalThis.__baalNativeRequest;
  var NativeResponse = globalThis.__baalNativeResponse;
  var nativeFetch = globalThis.__baalNativeFetch;

  function isReadableStream(value) {
    return value != null && typeof value.getReader === "function";
  }

  function bodyToUint8Array(body) {
    if (body == null) return null;
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return body;
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return null;
  }

  function bytesToReadableStream(bytes) {
    return new ReadableStream({
      start: function(controller) {
        if (bytes && bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function bodyInitToReadableStream(body) {
    if (body == null) return null;
    if (isReadableStream(body)) return body;
    var bytes = bodyToUint8Array(body);
    if (bytes != null) return bytesToReadableStream(bytes);
    return null;
  }

  function bodyStreamFromNative(native) {
    var raw = native.body;
    if (raw == null) return null;
    if (raw instanceof ReadableStream) return raw;
    if (isReadableStream(raw)) return raw;
    return bodyInitToReadableStream(raw);
  }

  function nativeWireBody(body) {
    if (body == null) return undefined;
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return body;
    if (ArrayBuffer.isView(body)) return bodyToUint8Array(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (isReadableStream(body)) return body;
    return body;
  }

  function normalizeRequestInput(input) {
    if (typeof input === "string") return new URL(input).href;
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    return input;
  }

  function constructNative(NativeCtor, input, init) {
    if (init === undefined) {
      return Reflect.construct(NativeCtor, [input], NativeCtor);
    }
    return Reflect.construct(NativeCtor, [input, init], NativeCtor);
  }

  async function readStreamToText(stream) {
    var bytes = await readStreamToBytes(stream);
    return new TextDecoder().decode(bytes);
  }

  function patchInstanceStreamConsumers(native, bodyStream) {
    if (!isReadableStream(bodyStream)) return native;
    var consumed = false;
    function takeStream() {
      if (consumed) throw new TypeError("Body already consumed");
      consumed = true;
      return bodyStream;
    }
    function wrapAsyncMethod(name, reader) {
      var orig = native[name];
      if (typeof orig !== "function") return;
      try {
        Object.defineProperty(native, name, {
          value: function() {
            return reader(takeStream());
          },
          writable: true,
          configurable: true,
        });
      } catch (_e) {}
    }
    wrapAsyncMethod("text", function(stream) {
      return readStreamToText(stream);
    });
    wrapAsyncMethod("json", async function(stream) {
      return JSON.parse(await readStreamToText(stream));
    });
    wrapAsyncMethod("arrayBuffer", async function(stream) {
      var bytes = await readStreamToBytes(stream);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    });
    wrapAsyncMethod("bytes", function(stream) {
      return readStreamToBytes(stream);
    });
    wrapAsyncMethod("blob", async function(stream) {
      var bytes = await readStreamToBytes(stream);
      var type = native.headers && native.headers.get
        ? native.headers.get("content-type") || ""
        : "";
      return new Blob([bytes], { type: type });
    });
    return native;
  }

  function normalizeNullBody(native) {
    if (native.body != null) return native;
    try {
      Object.defineProperty(native, "body", {
        get: function() {
          return null;
        },
        configurable: true,
        enumerable: true,
      });
    } catch (_e) {}
    return native;
  }

  function patchInstanceClone(native, bodyStream, userStream) {
    var origClone = native.clone;
    if (typeof origClone !== "function") return native;
    try {
      Object.defineProperty(native, "clone", {
        value: function clone() {
          var stream = bodyStream;
          var expectedMethod = native.method;
          if (userStream && isReadableStream(bodyStream) && typeof bodyStream.tee === "function") {
            var teed = bodyStream.tee();
            stream = teed[0];
            bodyStream = teed[1];
          }
          var cloned = origClone.call(native);
          if (
            cloned.method !== expectedMethod &&
            cloned.method === cloned.url &&
            typeof expectedMethod === "string"
          ) {
            var method = expectedMethod;
            try {
              Object.defineProperty(cloned, "method", {
                get: function() {
                  return method;
                },
                configurable: true,
                enumerable: true,
              });
            } catch (_e) {}
          }
          var patched = patchInstanceBody(cloned, stream, userStream);
          return userStream ? patchInstanceStreamConsumers(patched, stream) : patched;
        },
        writable: true,
        configurable: true,
      });
    } catch (_e) {}
    return native;
  }

  function patchInstanceBody(native, bodyStream, userStream) {
    var stream = bodyStream !== undefined ? bodyStream : bodyStreamFromNative(native);
    if (stream == null) return patchInstanceClone(normalizeNullBody(native), null, false);
    if (isReadableStream(native.body)) return patchInstanceClone(native, stream, userStream);
    try {
      Object.defineProperty(native, "body", {
        get: function() {
          return stream;
        },
        configurable: true,
        enumerable: true,
      });
    } catch (_e) {
      return patchInstanceClone(native, stream, userStream);
    }
    var patched = patchInstanceClone(native, stream, userStream);
    return userStream ? patchInstanceStreamConsumers(patched, stream) : patched;
  }

  function proxyRequestConstructor() {
    return new Proxy(NativeRequest, {
      construct: function(target, args) {
        var input = normalizeRequestInput(args[0]);
        var init = args[1];
        var bodyStream;
        if (init && init.body != null) {
          bodyStream = bodyInitToReadableStream(init.body);
          init = Object.assign({}, init, { body: nativeWireBody(init.body) });
        }
        var native =
          init === undefined
            ? Reflect.construct(target, [input], target)
            : Reflect.construct(target, [input, init], target);
        return patchInstanceBody(native, bodyStream, false);
      },
      apply: function(target, _thisArg, args) {
        return Reflect.construct(target, args, target);
      },
    });
  }

  function proxyResponseConstructor() {
    return new Proxy(NativeResponse, {
      construct: function(target, args) {
        var body = args[0];
        var init = args[1];
        var userStream = body != null && isReadableStream(body) ? body : null;
        var wireBody =
          body == null ? undefined : userStream ? undefined : nativeWireBody(body);
        var bodyStream = body == null ? undefined : bodyInitToReadableStream(body);
        var native =
          init === undefined
            ? Reflect.construct(target, [wireBody], target)
            : Reflect.construct(target, [wireBody, init], target);
        return patchInstanceBody(native, bodyStream, !!userStream);
      },
      apply: function(target, _thisArg, args) {
        return Reflect.construct(target, args, target);
      },
    });
  }

  async function readStreamToBytes(stream) {
    var reader = stream.getReader();
    var chunks = [];
    try {
      while (true) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
      }
    } finally {
      reader.releaseLock();
    }
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  globalThis.Request = proxyRequestConstructor();
  globalThis.Response = proxyResponseConstructor();

  if (typeof NativeRequest.json === "function") {
    globalThis.Request.json = function json(data, init) {
      var native = NativeRequest.json.call(NativeRequest, data, init);
      return patchInstanceBody(native, bodyStreamFromNative(native), false);
    };
  }

  if (typeof NativeResponse.json === "function") {
    globalThis.Response.json = NativeResponse.json.bind(NativeResponse);
  }

  if (typeof NativeResponse.redirect === "function") {
    globalThis.Response.redirect = NativeResponse.redirect.bind(NativeResponse);
  }

  if (typeof NativeResponse.error === "function") {
    globalThis.Response.error = NativeResponse.error.bind(NativeResponse);
  }

  async function serializeRequestForNativeFetch(req) {
    var init = {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
      referrer: req.referrer,
      referrerPolicy: req.referrerPolicy,
      mode: req.mode,
      credentials: req.credentials,
      cache: req.cache,
      redirect: req.redirect,
      integrity: req.integrity,
      keepalive: req.keepalive,
    };
    if (req.duplex) init.duplex = req.duplex;
    if (req.body) {
      var bytes = await readStreamToBytes(req.body);
      if (bytes.length > 0) init.body = bytes;
    }
    return constructNative(NativeRequest, req.url, init);
  }

  globalThis.fetch = async function fetch(input, init) {
    var req = input;
    if (input instanceof NativeRequest) {
      req = await serializeRequestForNativeFetch(input);
    } else if (init && init.body != null) {
      init = Object.assign({}, init);
      var stream = bodyInitToReadableStream(init.body);
      if (stream) {
        var bytes = await readStreamToBytes(stream);
        init.body = bytes.length > 0 ? bytes : undefined;
      } else {
        init.body = nativeWireBody(init.body);
      }
    }
    var nativeResponse = await nativeFetch(req, init);
    return patchInstanceBody(nativeResponse, undefined, false);
  };
}());
