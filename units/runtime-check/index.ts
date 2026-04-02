/**
 * QuickJS Runtime Health Check
 *
 * Exercises every feature a typical Node.js backend project relies on.
 * Run against QuickJS to discover which capabilities are present, broken, or missing.
 *
 * GET  /       — full health report: `summary`, grouped `sections`, and flat `tests`
 * POST /echo   — echo parsed JSON body back (tests body reading)
 *
 * There is no separate route per section; only GET / returns section breakdowns.
 * Flat `tests` uses prefixed names (e.g. `crypto: createHash (SHA-256)`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseQuerystring } from "node:querystring";
import { text } from "node:stream/consumers";
import { URL } from "node:url";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import { EventEmitter } from "node:events";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
}

interface GroupedTests {
  pass: boolean;
  tests: TestResult[];
}

function runTest(name: string, fn: () => string | void): TestResult {
  try {
    const detail = fn();
    return { name, pass: true, ...(detail ? { detail } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, error: msg };
  }
}

async function runTestAsync(name: string, fn: () => Promise<string | void>): Promise<TestResult> {
  try {
    const detail = await fn();
    return { name, pass: true, ...(detail ? { detail } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, error: msg };
  }
}

function group(tests: TestResult[]): GroupedTests {
  return { pass: tests.every((t) => t.pass), tests };
}

// ---------------------------------------------------------------------------
// 1. ES Language Features
// ---------------------------------------------------------------------------

function checkESLanguage(): GroupedTests {
  return group([
    runTest("arrow functions", () => {
      const add = (a: number, b: number) => a + b;
      assert(add(2, 3) === 5);
    }),

    runTest("template literals", () => {
      const name = "baal";
      assert(`hello ${name}` === "hello baal");
    }),

    runTest("destructuring (object + array)", () => {
      const { a, b } = { a: 1, b: 2 };
      const [x, y] = [10, 20];
      assert(a === 1 && b === 2 && x === 10 && y === 20);
    }),

    runTest("spread / rest", () => {
      const arr = [1, 2, 3];
      const copy = [...arr, 4];
      assert(copy.length === 4 && copy[3] === 4);
      const fn = (...args: number[]) => args.reduce((s, v) => s + v, 0);
      assert(fn(1, 2, 3) === 6);
    }),

    runTest("default parameters", () => {
      const greet = (n: string = "world") => `hi ${n}`;
      assert(greet() === "hi world");
      assert(greet("baal") === "hi baal");
    }),

    runTest("classes + inheritance", () => {
      class Base {
        value: number;
        constructor(v: number) { this.value = v; }
        double() { return this.value * 2; }
      }
      class Child extends Base {
        triple() { return this.value * 3; }
      }
      const c = new Child(5);
      assert(c.double() === 10 && c.triple() === 15);
    }),

    runTest("Symbol + Symbol.iterator", () => {
      const s = Symbol("test");
      assert(typeof s === "symbol");
      const iterable = {
        *[Symbol.iterator]() { yield 1; yield 2; yield 3; },
      };
      const vals = [...iterable];
      assert(vals.length === 3 && vals[2] === 3);
    }),

    runTest("generators", () => {
      function* range(n: number) { for (let i = 0; i < n; i++) yield i; }
      const arr = [...range(4)];
      assert(arr.length === 4 && arr[3] === 3);
    }),

    runTest("for...of", () => {
      const items: number[] = [];
      for (const v of [10, 20, 30]) items.push(v);
      assert(items.length === 3);
    }),

    runTest("Map", () => {
      const m = new Map<string, number>();
      m.set("a", 1);
      m.set("b", 2);
      assert(m.size === 2 && m.get("a") === 1);
      assert([...m.keys()].join(",") === "a,b");
    }),

    runTest("Set", () => {
      const s = new Set([1, 2, 2, 3]);
      assert(s.size === 3 && s.has(2));
    }),

    runTest("WeakMap + WeakSet", () => {
      const wm = new WeakMap();
      const ws = new WeakSet();
      const obj = {};
      wm.set(obj, 42);
      ws.add(obj);
      assert(wm.get(obj) === 42 && ws.has(obj));
    }),

    runTest("Promise.all / Promise.race", () => {
      assert(typeof Promise.all === "function");
      assert(typeof Promise.race === "function");
    }),

    runTest("Promise.allSettled", () => {
      assert(typeof Promise.allSettled === "function");
    }),

    runTest("Promise.any", () => {
      assert(typeof Promise.any === "function");
    }),

    runTest("async / await", () => {
      assert(typeof (async () => {}).constructor === "function");
    }),

    runTest("optional chaining + nullish coalescing", () => {
      const obj: Record<string, unknown> = {};
      const val = (obj as { a?: { b?: number } }).a?.b ?? 42;
      assert(val === 42);
    }),

    runTest("logical assignment (&&= ||= ??=)", () => {
      let a: number | null = null;
      a ??= 10;
      assert(a === 10);
      let b = 0;
      b ||= 5;
      assert(b === 5);
    }),

    runTest("Proxy + Reflect", () => {
      const target = { x: 1 };
      const p = new Proxy(target, {
        get(t, prop, receiver) { return Reflect.get(t, prop, receiver); },
      });
      assert(p.x === 1);
    }),

    runTest("RegExp named groups + lookbehind", () => {
      const m = "2025-04-02".match(/(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/);
      assert(m?.groups?.["year"] === "2025");
      const lb = "USD100".match(/(?<=USD)\d+/);
      assert(lb?.[0] === "100");
    }),

    runTest("String.prototype.replaceAll", () => {
      assert("a-b-c".replaceAll("-", "_") === "a_b_c");
    }),

    runTest("Array.prototype.at", () => {
      assert([10, 20, 30].at(-1) === 30);
    }),

    runTest("Object.hasOwn", () => {
      assert(Object.hasOwn({ a: 1 }, "a") === true);
      assert(Object.hasOwn({ a: 1 }, "b") === false);
    }),

    runTest("structuredClone", () => {
      const orig = { nested: { val: 42 }, arr: [1, 2] };
      const clone = structuredClone(orig);
      clone.nested.val = 99;
      assert(orig.nested.val === 42);
      return "deep clone verified";
    }),

    runTest("Array.prototype.findLast / findLastIndex", () => {
      const arr = [1, 2, 3, 4, 5];
      assert(arr.findLast((v) => v % 2 === 0) === 4);
      assert(arr.findLastIndex((v) => v % 2 === 0) === 3);
    }),

    runTest("group values by key (manual pattern)", () => {
      const arr = [1, 2, 3, 4, 5];
      const grouped: Record<string, number[]> = Object.create(null);
      for (const v of arr) {
        const k = v % 2 === 0 ? "even" : "odd";
        if (!grouped[k]) grouped[k] = [];
        grouped[k]!.push(v);
      }
      assert(grouped["even"]!.length === 2);
      assert(grouped["odd"]!.length === 3);
    }),

    runTest("Error.cause", () => {
      const inner = new Error("root");
      const outer = new Error("wrapper", { cause: inner });
      assert((outer.cause as Error).message === "root");
    }),

    runTest("AggregateError", () => {
      const ae = new AggregateError([new Error("a"), new Error("b")], "multi");
      assert(ae.errors.length === 2);
    }),

    runTest("queueMicrotask", () => {
      assert(typeof queueMicrotask === "function");
    }),

    runTest("globalThis", () => {
      assert(typeof globalThis === "object");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 2. JSON
// ---------------------------------------------------------------------------

function checkJSON(): GroupedTests {
  return group([
    runTest("JSON.parse", () => {
      const obj = JSON.parse('{"a":1,"b":"two","c":true,"d":null}');
      assert(obj.a === 1 && obj.b === "two" && obj.c === true && obj.d === null);
    }),

    runTest("JSON.stringify", () => {
      const s = JSON.stringify({ x: [1, 2], y: "hello" });
      assert(s === '{"x":[1,2],"y":"hello"}');
    }),

    runTest("JSON.stringify with replacer", () => {
      const s = JSON.stringify({ a: 1, b: 2, c: 3 }, (key, val) =>
        key === "b" ? undefined : (val as unknown),
      );
      assert(s === '{"a":1,"c":3}');
    }),

    runTest("JSON.stringify with indentation", () => {
      const s = JSON.stringify({ a: 1 }, null, 2);
      assert(s.includes("\n") && s.includes("  "));
    }),

    runTest("JSON.parse reviver", () => {
      const obj = JSON.parse('{"date":"2025-01-01T00:00:00.000Z"}', (key, val) =>
        key === "date" ? new Date(val as string) : (val as unknown),
      );
      assert(obj.date instanceof Date);
    }),

    runTest("JSON roundtrip with special chars", () => {
      const original = { emoji: "Hello 🌍", newline: "line1\nline2", tab: "a\tb" };
      const rt = JSON.parse(JSON.stringify(original)) as typeof original;
      assert(rt.emoji === original.emoji);
      assert(rt.newline === original.newline);
    }),

    runTest("JSON.parse with nested structures", () => {
      const deep = JSON.parse('{"a":{"b":{"c":{"d":[1,2,3]}}}}');
      assert(deep.a.b.c.d[2] === 3);
    }),

    runTest("JSON.stringify toJSON method", () => {
      const obj = {
        val: 42,
        toJSON() { return { custom: true }; },
      };
      assert(JSON.stringify(obj) === '{"custom":true}');
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 3. URL + URLSearchParams
// ---------------------------------------------------------------------------

function checkURL(): GroupedTests {
  return group([
    runTest("URL constructor", () => {
      const u = new URL("https://example.com:8080/path?q=1#frag");
      assert(u.protocol === "https:");
      assert(u.hostname === "example.com");
      assert(u.port === "8080");
      assert(u.pathname === "/path");
      assert(u.hash === "#frag");
    }),

    runTest("URL with base", () => {
      const u = new URL("/api/v1?key=val", "http://localhost:3000");
      assert(u.href === "http://localhost:3000/api/v1?key=val");
    }),

    runTest("URL mutation", () => {
      const u = new URL("http://example.com/old");
      u.pathname = "/new";
      u.searchParams.set("page", "2");
      assert(u.pathname === "/new");
      assert(u.searchParams.get("page") === "2");
    }),

    runTest("URLSearchParams constructor (string)", () => {
      const p = new URLSearchParams("a=1&b=2&a=3");
      assert(p.get("a") === "1");
      assert(p.getAll("a").length === 2);
    }),

    runTest("URLSearchParams constructor (object)", () => {
      const p = new URLSearchParams({ foo: "bar", baz: "qux" });
      assert(p.get("foo") === "bar");
    }),

    runTest("URLSearchParams constructor (array of pairs)", () => {
      const p = new URLSearchParams([["x", "1"], ["y", "2"]]);
      assert(p.get("x") === "1" && p.get("y") === "2");
    }),

    runTest("URLSearchParams iteration", () => {
      const p = new URLSearchParams("a=1&b=2");
      const entries = [...p.entries()];
      assert(entries.length === 2);
      const keys = [...p.keys()];
      assert(keys.includes("a") && keys.includes("b"));
    }),

    runTest("URLSearchParams.toString", () => {
      const p = new URLSearchParams();
      p.append("key", "hello world");
      assert(p.toString() === "key=hello+world" || p.toString() === "key=hello%20world");
    }),

    runTest("URLSearchParams.sort", () => {
      const p = new URLSearchParams("z=1&a=2&m=3");
      p.sort();
      assert([...p.keys()].join(",") === "a,m,z");
    }),

    runTest("URLSearchParams.has / .delete", () => {
      const p = new URLSearchParams("a=1&b=2");
      assert(p.has("a") === true);
      p.delete("a");
      assert(p.has("a") === false);
    }),

    runTest("URL encoding in search params", () => {
      const p = new URLSearchParams();
      p.set("q", "hello world & goodbye");
      const encoded = p.toString();
      assert(!encoded.includes(" ") || encoded.includes("+"));
      assert(new URLSearchParams(encoded).get("q") === "hello world & goodbye");
    }),

    runTest("encodeURIComponent / decodeURIComponent", () => {
      const original = "hello world/foo?bar=baz&x=1";
      const encoded = encodeURIComponent(original);
      assert(decodeURIComponent(encoded) === original);
      assert(!encoded.includes("/") && !encoded.includes("?"));
    }),

    runTest("encodeURI / decodeURI", () => {
      const uri = "https://example.com/path with spaces?q=hello world";
      const encoded = encodeURI(uri);
      assert(encoded.includes("https://example.com/"));
      assert(decodeURI(encoded) === uri);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 4. TextEncoder / TextDecoder
// ---------------------------------------------------------------------------

function checkEncoding(): GroupedTests {
  return group([
    runTest("TextEncoder exists", () => {
      assert(typeof TextEncoder === "function");
    }),

    runTest("TextEncoder.encode", () => {
      const enc = new TextEncoder();
      const bytes = enc.encode("hello");
      assert(bytes instanceof Uint8Array);
      assert(bytes.length === 5);
      assert(bytes[0] === 0x68); // 'h'
    }),

    runTest("TextDecoder exists", () => {
      assert(typeof TextDecoder === "function");
    }),

    runTest("TextDecoder.decode", () => {
      const dec = new TextDecoder();
      const result = dec.decode(new Uint8Array([104, 101, 108, 108, 111]));
      assert(result === "hello");
    }),

    runTest("TextEncoder/TextDecoder roundtrip", () => {
      const original = "Hello 🌍 — special chars: àéîõü";
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      assert(dec.decode(enc.encode(original)) === original);
    }),

    runTest("TextDecoder with UTF-8 label", () => {
      const dec = new TextDecoder("utf-8");
      const result = dec.decode(new Uint8Array([0xC3, 0xA9])); // é
      assert(result === "é");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 5. Base64 (atob / btoa)
// ---------------------------------------------------------------------------

function checkBase64(): GroupedTests {
  return group([
    runTest("btoa exists", () => {
      assert(typeof btoa === "function");
    }),

    runTest("atob exists", () => {
      assert(typeof atob === "function");
    }),

    runTest("btoa basic", () => {
      assert(btoa("hello") === "aGVsbG8=");
    }),

    runTest("atob basic", () => {
      assert(atob("aGVsbG8=") === "hello");
    }),

    runTest("btoa/atob roundtrip", () => {
      const original = "The quick brown fox jumps over the lazy dog";
      assert(atob(btoa(original)) === original);
    }),

    runTest("base64 with special characters (binary-safe via latin1)", () => {
      const input = "\x00\x01\x02\xff\xfe";
      const encoded = btoa(input);
      assert(atob(encoded) === input);
    }),

    runTest("base64url manual encode/decode", () => {
      const data = "subjects?_d=1/2+3";
      const b64 = btoa(data);
      const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const back = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
      assert(back === data);
      return `b64url: ${b64url}`;
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 6. Buffer
// ---------------------------------------------------------------------------

function checkBuffer(): GroupedTests {
  return group([
    runTest("Buffer exists", () => {
      assert(typeof Buffer === "function");
    }),

    runTest("Buffer.from (string, utf-8)", () => {
      const buf = Buffer.from("hello", "utf-8");
      assert(buf.length === 5);
      assert(buf[0] === 0x68);
    }),

    runTest("Buffer.from (base64)", () => {
      const buf = Buffer.from("aGVsbG8=", "base64");
      assert(buf.toString("utf-8") === "hello");
    }),

    runTest("Buffer.from (hex)", () => {
      const buf = Buffer.from("48656c6c6f", "hex");
      assert(buf.toString("utf-8") === "Hello");
    }),

    runTest("Buffer.toString (base64)", () => {
      const buf = Buffer.from("hello");
      assert(buf.toString("base64") === "aGVsbG8=");
    }),

    runTest("Buffer.toString (hex)", () => {
      const buf = Buffer.from("hello");
      assert(buf.toString("hex") === "68656c6c6f");
    }),

    runTest("Buffer.alloc", () => {
      const buf = Buffer.alloc(10, 0);
      assert(buf.length === 10);
      assert(buf[0] === 0 && buf[9] === 0);
    }),

    runTest("Buffer.concat", () => {
      const a = Buffer.from("hel");
      const b = Buffer.from("lo");
      const c = Buffer.concat([a, b]);
      assert(c.toString() === "hello");
    }),

    runTest("Buffer.isBuffer", () => {
      assert(Buffer.isBuffer(Buffer.from("x")) === true);
      assert(Buffer.isBuffer("x") === false);
    }),

    runTest("Buffer slice / subarray", () => {
      const buf = Buffer.from("hello world");
      const sub = buf.subarray(0, 5);
      assert(sub.toString() === "hello");
    }),

    runTest("Buffer JSON roundtrip", () => {
      const buf = Buffer.from([1, 2, 3, 4, 5]);
      const json = JSON.stringify(buf);
      const parsed = JSON.parse(json);
      assert(parsed.type === "Buffer" && parsed.data.length === 5);
    }),

    runTest("Buffer.byteLength", () => {
      assert(Buffer.byteLength("hello") === 5);
      assert(Buffer.byteLength("🌍") === 4);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 7. Crypto
// ---------------------------------------------------------------------------

function checkCrypto(): GroupedTests {
  return group([
    runTest("crypto module exists", () => {
      assert(typeof crypto !== "undefined");
    }),

    runTest("crypto.randomUUID", () => {
      const uuid = crypto.randomUUID();
      assert(typeof uuid === "string");
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid));
      return uuid;
    }),

    runTest("crypto.randomBytes", () => {
      const bytes = crypto.randomBytes(16);
      assert(bytes.length === 16);
      return `hex: ${bytes.toString("hex")}`;
    }),

    runTest("crypto.randomInt", () => {
      const n = crypto.randomInt(0, 100);
      assert(n >= 0 && n < 100);
    }),

    runTest("crypto.createHash (SHA-256)", () => {
      const hash = crypto.createHash("sha256").update("hello").digest("hex");
      assert(hash === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      return hash;
    }),

    runTest("crypto.createHash (SHA-512)", () => {
      const hash = crypto.createHash("sha512").update("hello").digest("hex");
      assert(hash.length === 128);
    }),

    runTest("crypto.createHash (MD5)", () => {
      const hash = crypto.createHash("md5").update("hello").digest("hex");
      assert(hash === "5d41402abc4b2a76b9719d911017c592");
    }),

    runTest("crypto.createHmac (SHA-256)", () => {
      const hmac = crypto.createHmac("sha256", "secret-key").update("message").digest("hex");
      assert(typeof hmac === "string" && hmac.length === 64);
      return hmac;
    }),

    runTest("crypto hash multi-update", () => {
      const h = crypto.createHash("sha256");
      h.update("hello");
      h.update(" ");
      h.update("world");
      const combined = h.digest("hex");
      const single = crypto.createHash("sha256").update("hello world").digest("hex");
      assert(combined === single);
    }),

    runTest("crypto.createCipheriv / createDecipheriv (AES-256-CBC)", () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const plaintext = "secret message for encryption test";

      const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");

      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      assert(decrypted === plaintext);
      return `encrypted length: ${encrypted.length}`;
    }),

    runTest("crypto.createCipheriv (AES-256-GCM)", () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const plaintext = "authenticated encryption test";

      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");
      const authTag = cipher.getAuthTag();

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      assert(decrypted === plaintext);
    }),

    runTest("crypto.pbkdf2Sync", () => {
      const derived = crypto.pbkdf2Sync("password", "salt", 100000, 64, "sha512");
      assert(derived.length === 64);
      return `hex: ${derived.toString("hex").slice(0, 32)}...`;
    }),

    runTest("crypto.scryptSync", () => {
      const derived = crypto.scryptSync("password", "salt", 64);
      assert(derived.length === 64);
    }),

    runTest("crypto.timingSafeEqual", () => {
      const a = Buffer.from("secret");
      const b = Buffer.from("secret");
      const c = Buffer.from("other!");
      assert(crypto.timingSafeEqual(a, b) === true);
      assert(crypto.timingSafeEqual(a, c) === false);
    }),

    runTest("crypto.sign / verify (HMAC-based via createHmac)", () => {
      const key = "signing-key";
      const data = "data-to-sign";
      const sig = crypto.createHmac("sha256", key).update(data).digest("hex");
      const verify = crypto.createHmac("sha256", key).update(data).digest("hex");
      assert(sig === verify);
    }),

    runTest("crypto.getHashes", () => {
      const hashes = crypto.getHashes();
      assert(Array.isArray(hashes));
      assert(hashes.includes("sha256"));
      return `available: ${hashes.slice(0, 5).join(", ")}...`;
    }),

    runTest("crypto.getCiphers", () => {
      const ciphers = crypto.getCiphers();
      assert(Array.isArray(ciphers));
      assert(ciphers.includes("aes-256-cbc"));
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 8. Typed Arrays + ArrayBuffer + DataView
// ---------------------------------------------------------------------------

function checkTypedArrays(): GroupedTests {
  return group([
    runTest("ArrayBuffer", () => {
      const ab = new ArrayBuffer(16);
      assert(ab.byteLength === 16);
    }),

    runTest("Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3, 255]);
      assert(arr.length === 4 && arr[3] === 255);
    }),

    runTest("Int8Array", () => {
      const arr = new Int8Array([127, -128]);
      assert(arr[0] === 127 && arr[1] === -128);
    }),

    runTest("Uint16Array / Int16Array", () => {
      const u = new Uint16Array([65535]);
      const i = new Int16Array([-1]);
      assert(u[0] === 65535 && i[0] === -1);
    }),

    runTest("Uint32Array / Int32Array", () => {
      const u = new Uint32Array([4294967295]);
      assert(u[0] === 4294967295);
    }),

    runTest("Float32Array / Float64Array", () => {
      const f32 = new Float32Array([3.14]);
      const f64 = new Float64Array([3.141592653589793]);
      assert(Math.abs(f32[0]! - 3.14) < 0.001);
      assert(f64[0] === 3.141592653589793);
    }),

    runTest("BigInt64Array / BigUint64Array", () => {
      const bi = new BigInt64Array([BigInt("-9223372036854775808")]);
      const bu = new BigUint64Array([BigInt("18446744073709551615")]);
      assert(bi[0] === BigInt("-9223372036854775808"));
      assert(bu[0] === BigInt("18446744073709551615"));
    }),

    runTest("DataView", () => {
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setFloat64(0, Math.PI);
      assert(Math.abs(view.getFloat64(0) - Math.PI) < 1e-15);
    }),

    runTest("SharedArrayBuffer", () => {
      assert(typeof SharedArrayBuffer === "function");
      const sab = new SharedArrayBuffer(16);
      assert(sab.byteLength === 16);
    }),

    runTest("Atomics", () => {
      assert(typeof Atomics === "object");
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.store(view, 0, 42);
      assert(Atomics.load(view, 0) === 42);
    }),

    runTest("TypedArray.from / .of", () => {
      const a = Uint8Array.from([1, 2, 3]);
      const b = Uint8Array.of(4, 5, 6);
      assert(a.length === 3 && b.length === 3);
    }),

    runTest("TypedArray.slice / subarray", () => {
      const arr = new Uint8Array([10, 20, 30, 40, 50]);
      const sliced = arr.slice(1, 3);
      assert(sliced[0] === 20 && sliced[1] === 30 && sliced.length === 2);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 9. Date + Intl
// ---------------------------------------------------------------------------

function checkDateIntl(): GroupedTests {
  return group([
    runTest("Date.now", () => {
      const now = Date.now();
      assert(typeof now === "number" && now > 1700000000000);
    }),

    runTest("new Date (ISO string)", () => {
      const d = new Date("2025-06-15T12:30:00.000Z");
      assert(d.getUTCFullYear() === 2025);
      assert(d.getUTCMonth() === 5); // 0-indexed
      assert(d.getUTCDate() === 15);
    }),

    runTest("Date.toISOString", () => {
      const d = new Date("2025-01-01T00:00:00.000Z");
      assert(d.toISOString() === "2025-01-01T00:00:00.000Z");
    }),

    runTest("Date arithmetic", () => {
      const d1 = new Date("2025-01-01T00:00:00Z");
      const d2 = new Date("2025-01-02T00:00:00Z");
      const diffMs = d2.getTime() - d1.getTime();
      assert(diffMs === 86400000);
    }),

    runTest("Date.getTimezoneOffset", () => {
      const d = new Date();
      const offset = d.getTimezoneOffset();
      assert(typeof offset === "number");
    }),

    runTest("Intl.DateTimeFormat", () => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        year: "numeric", month: "short", day: "numeric",
      });
      const s = fmt.format(new Date("2025-06-15T00:00:00Z"));
      assert(typeof s === "string" && s.length > 0);
      return s;
    }),

    runTest("Intl.NumberFormat", () => {
      const fmt = new Intl.NumberFormat("en-US", {
        style: "currency", currency: "USD",
      });
      const s = fmt.format(1234.56);
      assert(s.includes("1,234.56") || s.includes("1234.56"));
      return s;
    }),

    runTest("Intl.Collator", () => {
      const collator = new Intl.Collator("en", { sensitivity: "base" });
      assert(collator.compare("a", "A") === 0);
      assert(collator.compare("a", "b") < 0);
    }),

    runTest("Intl.PluralRules", () => {
      const pr = new Intl.PluralRules("en-US");
      assert(pr.select(0) === "other");
      assert(pr.select(1) === "one");
      assert(pr.select(2) === "other");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 10. Timers
// ---------------------------------------------------------------------------

async function checkTimers(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(runTest("setTimeout exists", () => {
    assert(typeof setTimeout === "function");
  }));

  tests.push(runTest("clearTimeout exists", () => {
    assert(typeof clearTimeout === "function");
  }));

  tests.push(runTest("setInterval exists", () => {
    assert(typeof setInterval === "function");
  }));

  tests.push(runTest("clearInterval exists", () => {
    assert(typeof clearInterval === "function");
  }));

  tests.push(await runTestAsync("setTimeout fires", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }));

  tests.push(await runTestAsync("setInterval fires + clearInterval stops", async () => {
    let count = 0;
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        count++;
        if (count >= 2) {
          clearInterval(id);
          resolve();
        }
      }, 1);
    });
    assert(count >= 2);
  }));

  tests.push(await runTestAsync("timers/promises setTimeout", async () => {
    const before = Date.now();
    await setTimeoutPromise(1);
    const elapsed = Date.now() - before;
    assert(elapsed >= 0);
  }));

  tests.push(runTest("queueMicrotask", () => {
    assert(typeof queueMicrotask === "function");
    const state = { called: false };
    queueMicrotask(() => { state.called = true; });
  }));

  tests.push(runTest("performance.now exists", () => {
    assert(typeof performance !== "undefined");
    assert(typeof performance.now === "function");
    const t = performance.now();
    assert(typeof t === "number" && t >= 0);
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 11. Error Handling Patterns
// ---------------------------------------------------------------------------

function checkErrorHandling(): GroupedTests {
  return group([
    runTest("try/catch/finally", () => {
      let finallyRan = false;
      try {
        throw new Error("test");
      } catch (e) {
        assert(e instanceof Error);
      } finally {
        finallyRan = true;
      }
      assert(finallyRan);
    }),

    runTest("Error types (TypeError, RangeError, SyntaxError, ReferenceError)", () => {
      assert(typeof TypeError === "function");
      assert(typeof RangeError === "function");
      assert(typeof SyntaxError === "function");
      assert(typeof ReferenceError === "function");
      assert(new TypeError("t") instanceof Error);
    }),

    runTest("Custom error class", () => {
      class AppError extends Error {
        code: string;
        constructor(message: string, code: string) {
          super(message);
          this.name = "AppError";
          this.code = code;
        }
      }
      const err = new AppError("not found", "NOT_FOUND");
      assert(err instanceof Error);
      assert(err instanceof AppError);
      assert(err.code === "NOT_FOUND");
    }),

    runTest("Error.stack exists", () => {
      const err = new Error("trace test");
      assert(typeof err.stack === "string");
    }),

    runTest("Promise rejection handling", () => {
      const p = Promise.reject(new Error("rejected"));
      assert(typeof p.catch === "function");
      p.catch(() => {}); // prevent unhandled
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 12. String Operations (backend-critical)
// ---------------------------------------------------------------------------

function checkStringOps(): GroupedTests {
  return group([
    runTest("String.prototype.trim / trimStart / trimEnd", () => {
      assert("  hi  ".trim() === "hi");
      assert("  hi  ".trimStart() === "hi  ");
      assert("  hi  ".trimEnd() === "  hi");
    }),

    runTest("String.prototype.padStart / padEnd", () => {
      assert("5".padStart(3, "0") === "005");
      assert("5".padEnd(3, "0") === "500");
    }),

    runTest("String.prototype.startsWith / endsWith / includes", () => {
      const s = "hello world";
      assert(s.startsWith("hello"));
      assert(s.endsWith("world"));
      assert(s.includes("lo wo"));
    }),

    runTest("String.prototype.repeat", () => {
      assert("ab".repeat(3) === "ababab");
    }),

    runTest("String.prototype.matchAll", () => {
      const matches = [...("aAbBcC".matchAll(/[a-z]/g))];
      assert(matches.length === 3);
    }),

    runTest("String.prototype.normalize (NFC/NFD)", () => {
      const nfd = "\u0065\u0301"; // e + combining accent
      const nfc = nfd.normalize("NFC");
      assert(nfc === "\u00e9");
      assert(nfc.length === 1);
    }),

    runTest("String.raw", () => {
      const s = String.raw`\n\t`;
      assert(s === "\\n\\t");
    }),

    runTest("String.fromCodePoint / codePointAt", () => {
      const emoji = String.fromCodePoint(0x1F30D); // 🌍
      assert(emoji === "🌍");
      assert(emoji.codePointAt(0) === 0x1F30D);
    }),

    runTest("RegExp (common backend patterns)", () => {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      assert(emailRe.test("user@example.com"));
      assert(!emailRe.test("not-an-email"));

      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert(uuidRe.test("550e8400-e29b-41d4-a716-446655440000"));

      const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
      assert(ipv4Re.test("192.168.1.1"));
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 13. Math
// ---------------------------------------------------------------------------

function checkMath(): GroupedTests {
  return group([
    runTest("Math.random", () => {
      const r = Math.random();
      assert(r >= 0 && r < 1);
    }),

    runTest("Math.floor / ceil / round / trunc", () => {
      assert(Math.floor(1.9) === 1);
      assert(Math.ceil(1.1) === 2);
      assert(Math.round(1.5) === 2);
      assert(Math.trunc(-1.9) === -1);
    }),

    runTest("Math.min / max / abs", () => {
      assert(Math.min(3, 1, 2) === 1);
      assert(Math.max(3, 1, 2) === 3);
      assert(Math.abs(-5) === 5);
    }),

    runTest("Math.pow / sqrt / cbrt / hypot", () => {
      assert(Math.pow(2, 10) === 1024);
      assert(Math.sqrt(144) === 12);
      assert(Math.cbrt(27) === 3);
      assert(Math.hypot(3, 4) === 5);
    }),

    runTest("Math.log / log2 / log10 / exp", () => {
      assert(Math.abs(Math.log(Math.E) - 1) < 1e-10);
      assert(Math.log2(8) === 3);
      assert(Math.log10(1000) === 3);
    }),

    runTest("Math.sign / clz32 / fround / imul", () => {
      assert(Math.sign(-5) === -1);
      assert(Math.sign(5) === 1);
      assert(typeof Math.clz32 === "function");
      assert(typeof Math.fround === "function");
      assert(typeof Math.imul === "function");
    }),

    runTest("Math.PI / E / LN2 / SQRT2", () => {
      assert(Math.abs(Math.PI - 3.14159265) < 0.0001);
      assert(Math.abs(Math.E - 2.71828182) < 0.0001);
      assert(typeof Math.LN2 === "number");
      assert(typeof Math.SQRT2 === "number");
    }),

    runTest("Number.isFinite / isNaN / isInteger / isSafeInteger", () => {
      assert(Number.isFinite(42));
      assert(!Number.isFinite(Infinity));
      assert(Number.isNaN(NaN));
      assert(!Number.isNaN(42));
      assert(Number.isInteger(42));
      assert(!Number.isInteger(42.5));
      assert(Number.isSafeInteger(42));
      assert(!Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1));
    }),

    runTest("Number.parseInt / parseFloat", () => {
      assert(Number.parseInt("42px", 10) === 42);
      assert(Number.parseFloat("3.14abc") === 3.14);
    }),

    runTest("BigInt", () => {
      const big = BigInt("9007199254740993");
      assert(big > BigInt(Number.MAX_SAFE_INTEGER));
      assert((BigInt(2) ** BigInt(64)).toString() === "18446744073709551616");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 14. Collections & Iteration Protocols
// ---------------------------------------------------------------------------

function checkCollections(): GroupedTests {
  return group([
    runTest("Array.from with mapFn", () => {
      const arr = Array.from({ length: 5 }, (_, i) => i * 2);
      assert(arr.length === 5 && arr[4] === 8);
    }),

    runTest("Array.isArray", () => {
      assert(Array.isArray([]) === true);
      assert(Array.isArray("not array") === false);
    }),

    runTest("Array flat / flatMap", () => {
      assert([1, [2, [3]]].flat(Infinity).length === 3);
      assert([1, 2, 3].flatMap((x) => [x, x * 2]).length === 6);
    }),

    runTest("Array.prototype.reduce / reduceRight", () => {
      const sum = [1, 2, 3, 4].reduce((acc, v) => acc + v, 0);
      assert(sum === 10);
    }),

    runTest("Array.prototype.every / some / filter / find", () => {
      const arr = [1, 2, 3, 4, 5];
      assert(arr.every((v) => v > 0));
      assert(arr.some((v) => v > 4));
      assert(arr.filter((v) => v % 2 === 0).length === 2);
      assert(arr.find((v) => v > 3) === 4);
    }),

    runTest("Array.prototype.sort (stable)", () => {
      const items = [
        { name: "b", order: 1 },
        { name: "a", order: 1 },
        { name: "c", order: 2 },
      ];
      items.sort((a, b) => a.order - b.order);
      assert(items[0]!.name === "b" && items[1]!.name === "a");
    }),

    runTest("Object.keys / values / entries", () => {
      const obj = { a: 1, b: 2, c: 3 };
      assert(Object.keys(obj).length === 3);
      assert(Object.values(obj).reduce((s, v) => s + v, 0) === 6);
      assert(Object.entries(obj).length === 3);
    }),

    runTest("Object.assign / spread", () => {
      const merged = Object.assign({}, { a: 1 }, { b: 2 });
      assert(merged.a === 1 && merged.b === 2);
      const spread = { ...merged, c: 3 };
      assert(spread.c === 3);
    }),

    runTest("Object.freeze / isFrozen", () => {
      const obj = Object.freeze({ x: 1 });
      assert(Object.isFrozen(obj));
    }),

    runTest("Object.fromEntries", () => {
      const obj = Object.fromEntries([["a", 1], ["b", 2]]);
      assert(obj["a"] === 1 && obj["b"] === 2);
    }),

    runTest("for...in (enumerable properties)", () => {
      const obj = { a: 1, b: 2 };
      const keys: string[] = [];
      for (const k in obj) keys.push(k);
      assert(keys.length === 2);
    }),

    runTest("Symbol.iterator protocol", () => {
      class Range {
        constructor(private start: number, private end: number) {}
        [Symbol.iterator]() {
          let current = this.start;
          const end = this.end;
          return {
            next() {
              return current <= end
                ? { value: current++, done: false }
                : { value: undefined, done: true as const };
            },
          };
        }
      }
      const vals = [...new Range(1, 4)];
      assert(vals.length === 4 && vals[3] === 4);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 15. Async Patterns
// ---------------------------------------------------------------------------

async function checkAsyncPatterns(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(await runTestAsync("Promise.all", async () => {
    const results = await Promise.all([
      Promise.resolve(1),
      Promise.resolve(2),
      Promise.resolve(3),
    ]);
    assert(results.length === 3 && results[0] === 1);
  }));

  tests.push(await runTestAsync("Promise.allSettled", async () => {
    const results = await Promise.allSettled([
      Promise.resolve("ok"),
      Promise.reject(new Error("fail")),
    ]);
    assert(results[0]!.status === "fulfilled");
    assert(results[1]!.status === "rejected");
  }));

  tests.push(await runTestAsync("Promise.race", async () => {
    const result = await Promise.race([
      new Promise((r) => setTimeout(() => r("slow"), 100)),
      Promise.resolve("fast"),
    ]);
    assert(result === "fast");
  }));

  tests.push(await runTestAsync("Promise.any", async () => {
    const result = await Promise.any([
      Promise.reject(new Error("a")),
      Promise.resolve("b"),
      Promise.resolve("c"),
    ]);
    assert(result === "b");
  }));

  tests.push(await runTestAsync("async generator / for-await-of", async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const vals: number[] = [];
    for await (const v of gen()) vals.push(v);
    assert(vals.length === 3 && vals[2] === 3);
  }));

  tests.push(await runTestAsync("Promise chaining", async () => {
    const result = await Promise.resolve(1)
      .then((v) => v + 1)
      .then((v) => v * 2)
      .then((v) => v.toString());
    assert(result === "4");
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 16. EventEmitter
// ---------------------------------------------------------------------------

function checkEventEmitter(): GroupedTests {
  return group([
    runTest("EventEmitter exists", () => {
      assert(typeof EventEmitter === "function");
    }),

    runTest("EventEmitter on/emit", () => {
      const ee = new EventEmitter();
      let received: string | null = null;
      ee.on("test", (val: string) => { received = val; });
      ee.emit("test", "hello");
      assert(received === "hello");
    }),

    runTest("EventEmitter once", () => {
      const ee = new EventEmitter();
      let count = 0;
      ee.once("ping", () => { count++; });
      ee.emit("ping");
      ee.emit("ping");
      assert(count === 1);
    }),

    runTest("EventEmitter removeListener", () => {
      const ee = new EventEmitter();
      let count = 0;
      const handler = () => { count++; };
      ee.on("ev", handler);
      ee.emit("ev");
      ee.removeListener("ev", handler);
      ee.emit("ev");
      assert(count === 1);
    }),

    runTest("EventEmitter listenerCount", () => {
      const ee = new EventEmitter();
      ee.on("ev", () => {});
      ee.on("ev", () => {});
      assert(ee.listenerCount("ev") === 2);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 17. Request / Response Shim (the runtime.js contract)
// ---------------------------------------------------------------------------

function checkReqResShim(
  req: IncomingMessage,
  res: ServerResponse,
): GroupedTests {
  return group([
    runTest("req.method exists", () => {
      assert(typeof req.method === "string" && req.method.length > 0);
    }),

    runTest("req.url exists", () => {
      assert(typeof req.url === "string");
    }),

    runTest("req.headers is object", () => {
      assert(typeof req.headers === "object" && req.headers !== null);
    }),

    runTest("req.rawHeaders is array", () => {
      assert(Array.isArray(req.rawHeaders));
    }),

    runTest("res.statusCode settable", () => {
      const prev = res.statusCode;
      res.statusCode = 299;
      assert(res.statusCode === 299);
      res.statusCode = prev;
    }),

    runTest("res.setHeader", () => {
      assert(typeof res.setHeader === "function");
      res.setHeader("X-Test", "value");
    }),

    runTest("res.removeHeader", () => {
      assert(typeof res.removeHeader === "function");
      res.setHeader("X-Remove-Test", "val");
      res.removeHeader("X-Remove-Test");
    }),

    runTest("res.appendHeader", () => {
      assert(typeof res.appendHeader === "function");
    }),

    runTest("res.setHeader with array (multi-value)", () => {
      res.setHeader("X-Multi", ["val1", "val2"]);
    }),

    runTest("res.end", () => {
      assert(typeof res.end === "function");
    }),

    runTest("parseQuerystring (runtime global)", () => {
      const result = parseQuerystring("a=1&b=2");
      assert(result["a"] === "1" && result["b"] === "2");
    }),

    runTest("text(req) body reader", () => {
      assert(typeof text === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 18. Console
// ---------------------------------------------------------------------------

function checkConsole(): GroupedTests {
  return group([
    runTest("console.log", () => {
      assert(typeof console.log === "function");
    }),

    runTest("console.error", () => {
      assert(typeof console.error === "function");
    }),

    runTest("console.warn", () => {
      assert(typeof console.warn === "function");
    }),

    runTest("console.info", () => {
      assert(typeof console.info === "function");
    }),

    runTest("console.debug", () => {
      assert(typeof console.debug === "function");
    }),

    runTest("console.trace", () => {
      assert(typeof console.trace === "function");
    }),

    runTest("console.time / timeEnd", () => {
      assert(typeof console.time === "function");
      assert(typeof console.timeEnd === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 19. WeakRef + FinalizationRegistry
// ---------------------------------------------------------------------------

function checkWeakRefFinalization(): GroupedTests {
  return group([
    runTest("WeakRef exists", () => {
      assert(typeof WeakRef === "function");
    }),

    runTest("WeakRef basic usage", () => {
      let obj: object | undefined = { data: "test" };
      const ref = new WeakRef(obj);
      assert(ref.deref() === obj);
      obj = undefined;
    }),

    runTest("FinalizationRegistry exists", () => {
      assert(typeof FinalizationRegistry === "function");
    }),

    runTest("FinalizationRegistry constructable", () => {
      const _registry = new FinalizationRegistry((_held: unknown) => {});
      assert(typeof _registry.register === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 20. AbortController / AbortSignal
// ---------------------------------------------------------------------------

function checkAbortController(): GroupedTests {
  return group([
    runTest("AbortController exists", () => {
      assert(typeof AbortController === "function");
    }),

    runTest("AbortController basic usage", () => {
      const ac = new AbortController();
      assert(ac.signal.aborted === false);
      ac.abort();
      assert(ac.signal.aborted === true);
    }),

    runTest("AbortSignal.reason", () => {
      const ac = new AbortController();
      ac.abort("custom reason");
      assert(ac.signal.reason === "custom reason");
    }),

    runTest("AbortSignal.timeout", () => {
      assert(typeof AbortSignal.timeout === "function");
    }),

    runTest("AbortSignal.any", () => {
      assert(typeof AbortSignal.any === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 21. Fetch API
// ---------------------------------------------------------------------------

function checkFetchAPI(): GroupedTests {
  return group([
    runTest("fetch exists", () => {
      assert(typeof fetch === "function");
    }),

    runTest("Request constructor exists", () => {
      assert(typeof Request === "function");
    }),

    runTest("Response constructor exists", () => {
      assert(typeof Response === "function");
    }),

    runTest("Headers constructor exists", () => {
      assert(typeof Headers === "function");
    }),

    runTest("Headers basic usage", () => {
      const h = new Headers();
      h.set("Content-Type", "application/json");
      assert(h.get("content-type") === "application/json");
      h.append("X-Custom", "val1");
      h.append("X-Custom", "val2");
      assert(h.has("x-custom"));
    }),

    runTest("Request construction", () => {
      const r = new Request("https://example.com/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      });
      assert(r.method === "POST");
      assert(r.url === "https://example.com/api");
    }),

    runTest("Response construction", () => {
      const r = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      assert(r.status === 200);
      assert(r.ok === true);
    }),

    runTest("Response.json / Response.text static", () => {
      assert(typeof Response.json === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 22. Streams API (Web Streams)
// ---------------------------------------------------------------------------

function checkStreams(): GroupedTests {
  return group([
    runTest("ReadableStream exists", () => {
      assert(typeof ReadableStream === "function");
    }),

    runTest("WritableStream exists", () => {
      assert(typeof WritableStream === "function");
    }),

    runTest("TransformStream exists", () => {
      assert(typeof TransformStream === "function");
    }),

    runTest("ReadableStream basic", () => {
      const rs = new ReadableStream({
        start(controller) {
          controller.enqueue("chunk1");
          controller.enqueue("chunk2");
          controller.close();
        },
      });
      assert(typeof rs.getReader === "function");
    }),

    runTest("TextEncoderStream exists", () => {
      assert(typeof TextEncoderStream === "function");
    }),

    runTest("TextDecoderStream exists", () => {
      assert(typeof TextDecoderStream === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 23. Process / Environment
// ---------------------------------------------------------------------------

function checkProcess(): GroupedTests {
  return group([
    runTest("process exists", () => {
      assert(typeof process !== "undefined");
    }),

    runTest("process.env", () => {
      assert(typeof process.env === "object");
    }),

    runTest("process.version", () => {
      assert(typeof process.version === "string");
    }),

    runTest("process.platform", () => {
      assert(typeof process.platform === "string");
    }),

    runTest("process.arch", () => {
      assert(typeof process.arch === "string");
    }),

    runTest("process.pid", () => {
      assert(typeof process.pid === "number");
    }),

    runTest("process.cwd()", () => {
      assert(typeof process.cwd === "function");
    }),

    runTest("process.hrtime.bigint()", () => {
      assert(typeof process.hrtime?.bigint === "function");
    }),

    runTest("process.nextTick", () => {
      assert(typeof process.nextTick === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function assert(condition: boolean, msg?: string): void {
  if (!condition) throw new Error(msg ?? "assertion failed");
}

// ---------------------------------------------------------------------------
// Health check runner
// ---------------------------------------------------------------------------

function flattenLabeledTests(
  labeled: Record<string, GroupedTests>,
): TestResult[] {
  const out: TestResult[] = [];
  for (const [label, sec] of Object.entries(labeled)) {
    for (const t of sec.tests) {
      out.push({ ...t, name: `${label}: ${t.name}` });
    }
  }
  return out;
}

async function runHealthCheck(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{
  summary: ReturnType<typeof buildSummary>;
  sections: Record<string, GroupedTests>;
  tests: TestResult[];
}> {
  const [timers, asyncPatterns] = await Promise.all([
    checkTimers(),
    checkAsyncPatterns(),
  ]);

  const sections: Record<string, GroupedTests> = {
    es_language: checkESLanguage(),
    json: checkJSON(),
    url: checkURL(),
    encoding: checkEncoding(),
    base64: checkBase64(),
    buffer: checkBuffer(),
    crypto: checkCrypto(),
    typed_arrays: checkTypedArrays(),
    date_intl: checkDateIntl(),
    timers,
    error_handling: checkErrorHandling(),
    string_ops: checkStringOps(),
    math: checkMath(),
    collections: checkCollections(),
    async_patterns: asyncPatterns,
    event_emitter: checkEventEmitter(),
    req_res_shim: checkReqResShim(req, res),
    console: checkConsole(),
    weakref_finalization: checkWeakRefFinalization(),
    abort_controller: checkAbortController(),
    fetch_api: checkFetchAPI(),
    streams: checkStreams(),
    process: checkProcess(),
  };

  const tests = flattenLabeledTests(sections);
  const summary = buildSummary(sections);
  return { summary, sections, tests };
}

function buildSummary(sections: Record<string, GroupedTests>) {
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const sectionSummaries: Record<
    string,
    { pass: boolean; passed: number; failed: number; total: number }
  > = {};

  for (const [name, sec] of Object.entries(sections)) {
    const passed = sec.tests.filter((t) => t.pass).length;
    const failed = sec.tests.length - passed;
    totalTests += sec.tests.length;
    totalPassed += passed;
    totalFailed += failed;
    sectionSummaries[name] = {
      pass: sec.pass,
      passed,
      failed,
      total: sec.tests.length,
    };
  }

  return {
    healthy: totalFailed === 0,
    total_tests: totalTests,
    total_passed: totalPassed,
    total_failed: totalFailed,
    sections: sectionSummaries,
  };
}

// ---------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host;
  const base = `http://${host}`;
  const url = new URL(req.url ?? "/", base);

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && url.pathname === "/") {
    const { summary, sections, tests } = await runHealthCheck(req, res);
    res.statusCode = summary.healthy ? 200 : 503;
    res.end(JSON.stringify({ summary, sections, tests }, null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/echo") {
    try {
      const raw = await text(req);
      const body = raw.trim() === "" ? null : (JSON.parse(raw) as unknown);
      res.statusCode = 200;
      res.end(JSON.stringify({ echo: body }, null, 2));
    } catch (_e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid JSON body" }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({
    hint: "GET / for the full health report, POST /echo to test body parsing",
  }));
}
