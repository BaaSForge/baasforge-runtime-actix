(function () {
  "use strict";
  var _encode = globalThis.__buf_str_to_bytes;
  var _decode = globalThis.__buf_bytes_to_str;
  var _byteLen = globalThis.__buf_byte_length;

  class Buffer extends Uint8Array {
    constructor(arg, byteOffsetOrEncoding, length) {
      if (typeof arg === "number") {
        super(arg);
      } else if (arg instanceof ArrayBuffer || arg instanceof SharedArrayBuffer) {
        super(
          arg,
          typeof byteOffsetOrEncoding === "number" ? byteOffsetOrEncoding : 0,
          length
        );
      } else if (ArrayBuffer.isView(arg)) {
        super(arg.buffer, arg.byteOffset, arg.byteLength);
      } else if (Array.isArray(arg)) {
        super(arg.length);
        for (var i = 0; i < arg.length; i++) this[i] = arg[i] & 0xff;
      } else {
        super(0);
      }
    }

    static from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        var enc = encodingOrOffset || "utf-8";
        var bytes = _encode(value, enc);
        var buf = new Buffer(bytes.length);
        for (var i = 0; i < bytes.length; i++) buf[i] = bytes[i];
        return buf;
      }
      if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        return new Buffer(value, encodingOrOffset, length);
      }
      if (value instanceof Buffer) {
        var copy = new Buffer(value.length);
        for (var i = 0; i < value.length; i++) copy[i] = value[i];
        return copy;
      }
      if (ArrayBuffer.isView(value)) {
        var buf2 = new Buffer(value.length);
        for (var i = 0; i < value.length; i++) buf2[i] = value[i];
        return buf2;
      }
      if (Array.isArray(value)) {
        var buf3 = new Buffer(value.length);
        for (var i = 0; i < value.length; i++) buf3[i] = value[i] & 0xff;
        return buf3;
      }
      throw new TypeError("Invalid argument for Buffer.from");
    }

    static alloc(size, fill) {
      var buf = new Buffer(size);
      if (fill !== undefined && fill !== 0) buf.fill(typeof fill === "number" ? fill : 0);
      return buf;
    }

    static allocUnsafe(size) {
      return new Buffer(size);
    }

    static isBuffer(obj) {
      return obj instanceof Buffer;
    }

    static byteLength(string, encoding) {
      if (typeof string !== "string") {
        if (ArrayBuffer.isView(string)) return string.byteLength;
        if (string instanceof ArrayBuffer) return string.byteLength;
        return 0;
      }
      return _byteLen(string, encoding || "utf-8");
    }

    static concat(list, totalLength) {
      if (!list || list.length === 0) return Buffer.alloc(0);
      var total = totalLength;
      if (total === undefined) {
        total = 0;
        for (var i = 0; i < list.length; i++) total += list[i].length;
      }
      var result = Buffer.alloc(total);
      var offset = 0;
      for (var i = 0; i < list.length; i++) {
        var buf = list[i];
        for (var j = 0; j < buf.length && offset < total; j++) {
          result[offset++] = buf[j];
        }
      }
      return result;
    }

    static compare(a, b) {
      var len = Math.min(a.length, b.length);
      for (var i = 0; i < len; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      if (a.length < b.length) return -1;
      if (a.length > b.length) return 1;
      return 0;
    }

    static isEncoding(encoding) {
      return [
        "utf-8","utf8","hex","base64","latin1","binary","ascii",
      ].indexOf((encoding || "").toLowerCase()) !== -1;
    }

    toString(encoding, start, end) {
      encoding = encoding || "utf-8";
      var s = start || 0;
      var e = end !== undefined ? end : this.length;
      var slice = this.subarray(s, e);
      var arr = [];
      for (var i = 0; i < slice.length; i++) arr.push(slice[i]);
      return _decode(arr, encoding);
    }

    toJSON() {
      var data = [];
      for (var i = 0; i < this.length; i++) data.push(this[i]);
      return { type: "Buffer", data: data };
    }

    equals(other) {
      if (this.length !== other.length) return false;
      for (var i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) return false;
      }
      return true;
    }

    compare(other) {
      return Buffer.compare(this, other);
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      targetStart = targetStart || 0;
      sourceStart = sourceStart || 0;
      sourceEnd = sourceEnd !== undefined ? sourceEnd : this.length;
      var written = 0;
      for (var i = sourceStart; i < sourceEnd && targetStart + written < target.length; i++) {
        target[targetStart + written] = this[i];
        written++;
      }
      return written;
    }

    write(string, offset, length, encoding) {
      if (typeof offset === "string") {
        encoding = offset; offset = 0; length = undefined;
      } else if (typeof length === "string") {
        encoding = length; length = undefined;
      }
      offset = offset || 0;
      encoding = encoding || "utf-8";
      var bytes = _encode(string, encoding);
      var maxLen = length !== undefined ? Math.min(bytes.length, length) : bytes.length;
      var writeLen = Math.min(maxLen, this.length - offset);
      for (var i = 0; i < writeLen; i++) this[offset + i] = bytes[i];
      return writeLen;
    }

    indexOf(value, byteOffset, encoding) {
      if (typeof value === "string") {
        var bytes = _encode(value, encoding || "utf-8");
        byteOffset = byteOffset || 0;
        for (var i = byteOffset; i <= this.length - bytes.length; i++) {
          var match = true;
          for (var j = 0; j < bytes.length; j++) {
            if (this[i + j] !== bytes[j]) { match = false; break; }
          }
          if (match) return i;
        }
        return -1;
      }
      if (typeof value === "number") {
        byteOffset = byteOffset || 0;
        for (var i = byteOffset; i < this.length; i++) {
          if (this[i] === (value & 0xff)) return i;
        }
        return -1;
      }
      return -1;
    }

    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    // Numeric read/write via DataView
    readUInt8(offset)  { return this[offset]; }
    writeUInt8(value, offset) { this[offset] = value & 0xff; return offset + 1; }

    readUInt16BE(offset) { return (this[offset] << 8) | this[offset + 1]; }
    writeUInt16BE(value, offset) {
      this[offset] = (value >>> 8) & 0xff;
      this[offset + 1] = value & 0xff;
      return offset + 2;
    }

    readUInt16LE(offset) { return this[offset] | (this[offset + 1] << 8); }
    writeUInt16LE(value, offset) {
      this[offset] = value & 0xff;
      this[offset + 1] = (value >>> 8) & 0xff;
      return offset + 2;
    }

    readUInt32BE(offset) {
      return (
        ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0
      );
    }
    writeUInt32BE(value, offset) {
      this[offset]   = (value >>> 24) & 0xff;
      this[offset+1] = (value >>> 16) & 0xff;
      this[offset+2] = (value >>> 8)  & 0xff;
      this[offset+3] = value & 0xff;
      return offset + 4;
    }

    readInt8(offset) {
      var v = this[offset]; return v >= 128 ? v - 256 : v;
    }
    writeInt8(value, offset) {
      this[offset] = value < 0 ? value + 256 : value;
      return offset + 1;
    }

    readInt16BE(offset) {
      var v = (this[offset] << 8) | this[offset + 1];
      return v >= 0x8000 ? v - 0x10000 : v;
    }
    writeInt16BE(value, offset) {
      if (value < 0) value = 0x10000 + value;
      this[offset] = (value >>> 8) & 0xff;
      this[offset + 1] = value & 0xff;
      return offset + 2;
    }

    readFloatBE(offset) {
      return new DataView(this.buffer, this.byteOffset + offset, 4).getFloat32(0, false);
    }
    writeFloatBE(value, offset) {
      new DataView(this.buffer, this.byteOffset + offset, 4).setFloat32(0, value, false);
      return offset + 4;
    }

    readDoubleBE(offset) {
      return new DataView(this.buffer, this.byteOffset + offset, 8).getFloat64(0, false);
    }
    writeDoubleBE(value, offset) {
      new DataView(this.buffer, this.byteOffset + offset, 8).setFloat64(0, value, false);
      return offset + 8;
    }

    subarray(begin, end) {
      var sub = super.subarray(begin, end);
      Object.setPrototypeOf(sub, Buffer.prototype);
      return sub;
    }

    slice(begin, end) {
      return this.subarray(begin, end);
    }
  }

  globalThis.Buffer = Buffer;
})();
