(function () {
  "use strict";
  var _digest = __crypto_digest;
  var _hmacDigest = __crypto_hmac_digest;
  var _cipherProcess = __crypto_cipher_process;
  var _randomUUID = __crypto_random_uuid;
  var _randomBytes = __crypto_random_bytes;
  var _randomInt = __crypto_random_int;
  var _randomFillSync = __crypto_random_fill_sync;
  var _getRandomValues = __crypto_get_random_values;
  var _pbkdf2Sync = __crypto_pbkdf2_sync;
  var _scryptSync = __crypto_scrypt_sync;
  var _timingSafeEqual = __crypto_timing_safe_equal;

  function toByteArray(input) {
    if (typeof input === "string") {
      var buf = Buffer.from(input, "utf-8");
      var arr = [];
      for (var i = 0; i < buf.length; i++) arr.push(buf[i]);
      return arr;
    }
    if (input && typeof input.length === "number") {
      var arr = [];
      for (var i = 0; i < input.length; i++) arr.push(input[i] & 0xFF);
      return arr;
    }
    return [];
  }

  var crypto = {};

  crypto.randomUUID = function () { return _randomUUID(); };
  crypto.randomBytes = function (size) { return _randomBytes(size); };
  crypto.randomInt = function (min, max) {
    if (max === undefined) return _randomInt(min);
    return _randomInt(min, max);
  };
  crypto.randomFillSync = function (buf) { return _randomFillSync(buf); };

  crypto.getRandomValues = function (typedArray) {
    return _getRandomValues(typedArray);
  };

  crypto.createHash = function (algorithm) {
    var alg = algorithm.toLowerCase().replace(/-/g, "");
    var chunks = [];
    return {
      update: function (input) {
        var bytes = toByteArray(input);
        for (var i = 0; i < bytes.length; i++) chunks.push(bytes[i]);
        return this;
      },
      digest: function (encoding) {
        var buf = _digest(alg, chunks);
        if (!encoding) return buf;
        return buf.toString(encoding);
      }
    };
  };

  crypto.createHmac = function (algorithm, key) {
    var alg = algorithm.toLowerCase().replace(/-/g, "");
    var keyBytes = toByteArray(key);
    var chunks = [];
    return {
      update: function (input) {
        var bytes = toByteArray(input);
        for (var i = 0; i < bytes.length; i++) chunks.push(bytes[i]);
        return this;
      },
      digest: function (encoding) {
        var buf = _hmacDigest(alg, keyBytes, chunks);
        if (!encoding) return buf;
        return buf.toString(encoding);
      }
    };
  };

  crypto.createCipheriv = function (algorithm, key, iv) {
    var keyArr = toByteArray(key);
    var ivArr = toByteArray(iv);
    var inputData = [];
    var outputAuthTag = null;

    return {
      update: function (data, inputEnc, _outputEnc) {
        var bytes;
        if (typeof data === "string") {
          var buf = Buffer.from(data, inputEnc || "utf-8");
          bytes = toByteArray(buf);
        } else {
          bytes = toByteArray(data);
        }
        for (var i = 0; i < bytes.length; i++) inputData.push(bytes[i]);
        return "";
      },
      "final": function (outputEnc) {
        var result = _cipherProcess(algorithm, keyArr, ivArr, inputData, true, []);
        if (result.authTag) outputAuthTag = result.authTag;
        var outBuf = result.data;
        if (outputEnc === "hex") return outBuf.toString("hex");
        if (outputEnc === "base64") return outBuf.toString("base64");
        return outBuf.toString("utf-8");
      },
      getAuthTag: function () { return outputAuthTag; },
      setAuthTag: function () {}
    };
  };

  crypto.createDecipheriv = function (algorithm, key, iv) {
    var keyArr = toByteArray(key);
    var ivArr = toByteArray(iv);
    var inputData = [];
    var authTag = [];

    return {
      update: function (data, inputEnc, _outputEnc) {
        var bytes;
        if (typeof data === "string") {
          var buf = Buffer.from(data, inputEnc || "utf-8");
          bytes = toByteArray(buf);
        } else {
          bytes = toByteArray(data);
        }
        for (var i = 0; i < bytes.length; i++) inputData.push(bytes[i]);
        return "";
      },
      "final": function (outputEnc) {
        var result = _cipherProcess(algorithm, keyArr, ivArr, inputData, false, authTag);
        var outBuf = result.data;
        if (outputEnc === "hex") return outBuf.toString("hex");
        if (outputEnc === "base64") return outBuf.toString("base64");
        return outBuf.toString("utf-8");
      },
      setAuthTag: function (tag) {
        authTag = toByteArray(tag);
      },
      getAuthTag: function () { return null; }
    };
  };

  crypto.pbkdf2Sync = function (password, salt, iterations, keylen, digest) {
    return _pbkdf2Sync(password, salt, iterations, keylen, digest);
  };

  crypto.scryptSync = function (password, salt, keylen) {
    return _scryptSync(password, salt, keylen);
  };

  crypto.timingSafeEqual = function (a, b) {
    return _timingSafeEqual(a, b);
  };

  crypto.getHashes = function () {
    return ["md5", "sha1", "sha256", "sha384", "sha512"];
  };

  crypto.getCiphers = function () {
    return ["aes-128-cbc", "aes-256-cbc", "aes-128-gcm", "aes-256-gcm"];
  };

  // Web Crypto subtle API (minimal for tests)
  crypto.subtle = {
    digest: function (algorithm, data) {
      var alg = algorithm.replace(/-/g, "").toLowerCase();
      var bytes = toByteArray(data);
      var buf = _digest(alg, bytes);
      var ab = new ArrayBuffer(buf.length);
      var view = new Uint8Array(ab);
      for (var i = 0; i < buf.length; i++) view[i] = buf[i];
      return Promise.resolve(ab);
    },

    generateKey: function (algorithm, extractable, usages) {
      var name = algorithm.name || algorithm;
      if (name === "HMAC") {
        var hashName = (algorithm.hash || "SHA-256").replace(/-/g, "").toLowerCase();
        var keyLen = hashName === "sha512" || hashName === "sha384" ? 64 : 32;
        var keyBuf = _randomBytes(keyLen);
        return Promise.resolve({
          type: "secret", algorithm: algorithm, extractable: extractable,
          usages: usages, _raw: keyBuf, _hashAlg: hashName
        });
      }
      if (name === "AES-GCM" || name === "AES-CBC") {
        var len = (algorithm.length || 256) / 8;
        var keyBuf = _randomBytes(len);
        return Promise.resolve({
          type: "secret", algorithm: algorithm, extractable: extractable,
          usages: usages, _raw: keyBuf
        });
      }
      return Promise.reject(new Error("Unsupported algorithm: " + name));
    },

    importKey: function (format, keyData, algorithm, extractable, usages) {
      var hashName = ((algorithm.hash || "SHA-256") + "").replace(/-/g, "").toLowerCase();
      var raw;
      if (keyData instanceof ArrayBuffer) {
        raw = Buffer.from(new Uint8Array(keyData));
      } else if (ArrayBuffer.isView(keyData)) {
        raw = Buffer.from(keyData);
      } else {
        raw = keyData;
      }
      return Promise.resolve({
        type: "secret", algorithm: algorithm, extractable: extractable,
        usages: usages, _raw: raw, _hashAlg: hashName
      });
    },

    exportKey: function (format, key) {
      if (format === "raw" && key._raw) {
        var buf = key._raw;
        var ab = new ArrayBuffer(buf.length);
        var view = new Uint8Array(ab);
        for (var i = 0; i < buf.length; i++) view[i] = buf[i];
        return Promise.resolve(ab);
      }
      return Promise.reject(new Error("exportKey: unsupported format"));
    },

    sign: function (algorithm, key, data) {
      var alg = key._hashAlg || "sha256";
      var keyBytes = toByteArray(key._raw);
      var dataBytes = toByteArray(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      var result = _hmacDigest(alg, keyBytes, dataBytes);
      var ab = new ArrayBuffer(result.length);
      var view = new Uint8Array(ab);
      for (var i = 0; i < result.length; i++) view[i] = result[i];
      return Promise.resolve(ab);
    },

    verify: function (algorithm, key, signature, data) {
      var alg = key._hashAlg || "sha256";
      var keyBytes = toByteArray(key._raw);
      var dataBytes = toByteArray(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      var result = _hmacDigest(alg, keyBytes, dataBytes);
      var sigView = new Uint8Array(signature instanceof ArrayBuffer ? signature : signature.buffer);
      if (result.length !== sigView.length) return Promise.resolve(false);
      for (var i = 0; i < result.length; i++) {
        if (result[i] !== sigView[i]) return Promise.resolve(false);
      }
      return Promise.resolve(true);
    },

    encrypt: function (algorithm, key, data) {
      var name = algorithm.name || algorithm;
      var ivBytes = toByteArray(algorithm.iv);
      var keyBytes = toByteArray(key._raw);
      var plainBytes = toByteArray(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      var algStr = name.toLowerCase().replace(/-/g, "-");
      var keyLen = keyBytes.length === 16 ? 128 : 256;
      var cipherAlg = "aes-" + keyLen + "-" + algStr.split("-").pop();
      var result = _cipherProcess(cipherAlg, keyBytes, ivBytes, plainBytes, true, []);
      var ct = result.data;
      var tag = result.authTag;
      var totalLen = ct.length + (tag ? tag.length : 0);
      var ab = new ArrayBuffer(totalLen);
      var view = new Uint8Array(ab);
      for (var i = 0; i < ct.length; i++) view[i] = ct[i];
      if (tag) for (var j = 0; j < tag.length; j++) view[ct.length + j] = tag[j];
      return Promise.resolve(ab);
    },

    decrypt: function (algorithm, key, data) {
      var name = algorithm.name || algorithm;
      var ivBytes = toByteArray(algorithm.iv);
      var keyBytes = toByteArray(key._raw);
      var cipherBytes = toByteArray(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      var keyLen = keyBytes.length === 16 ? 128 : 256;
      var mode = (name.toLowerCase().split("-").pop() || "gcm");
      var cipherAlg = "aes-" + keyLen + "-" + mode;
      var authTag = [];
      if (mode === "gcm" && cipherBytes.length >= 16) {
        authTag = cipherBytes.slice(cipherBytes.length - 16);
        cipherBytes = cipherBytes.slice(0, cipherBytes.length - 16);
      }
      var result = _cipherProcess(cipherAlg, keyBytes, ivBytes, cipherBytes, false, authTag);
      var pt = result.data;
      var ab = new ArrayBuffer(pt.length);
      var view = new Uint8Array(ab);
      for (var i = 0; i < pt.length; i++) view[i] = pt[i];
      return Promise.resolve(ab);
    }
  };

  globalThis.crypto = crypto;
})();
