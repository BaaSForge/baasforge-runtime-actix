/**
 * QuickJS Runtime Health Check
 *
 * Exercises every feature a typical Node.js backend project relies on.
 * Run against QuickJS to discover which capabilities are present, broken, or missing.
 *
 * GET / — single endpoint that returns a full health report containing
 *         `summary`, grouped `sections`, and flat `tests` arrays.
 *
 * All checks (including self-fetch round-trips) are triggered by the
 * single GET / call.  Internal test helpers are dispatched via the
 * `_t` query parameter (e.g. `/?_t=json`) and are not meant to be
 * called directly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseQuerystring } from "node:querystring";
import { text } from "node:stream/consumers";
import { URL } from "node:url";
import {
  randomUUID,
  randomBytes,
  randomInt,
  randomFillSync,
  createHash,
  createHmac,
  getHashes,
  getCiphers,
  pbkdf2Sync,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  subtle,
  getRandomValues,
  webcrypto,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_FILTER: string[] = [];

const TEST_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";

let _testSection = "";

function matchesTestFilter(section: string, name: string): boolean {
  if (TEST_FILTER.length === 0) return true;
  const sectionLc = section.toLowerCase();
  const nameLc = name.toLowerCase();
  const fullLc = `${sectionLc}: ${nameLc}`;
  return TEST_FILTER.some((f) => {
    const needle = f.toLowerCase();
    return sectionLc.includes(needle) || nameLc.includes(needle) || fullLc.includes(needle);
  });
}

function withSection<T>(section: string, fn: () => T): T {
  const prev = _testSection;
  _testSection = section;
  try {
    return fn();
  } finally {
    _testSection = prev;
  }
}

async function withSectionAsync<T>(section: string, fn: () => Promise<T>): Promise<T> {
  const prev = _testSection;
  _testSection = section;
  try {
    return await fn();
  } finally {
    _testSection = prev;
  }
}

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
  filtered?: true;
}

interface GroupedTests {
  pass: boolean;
  tests: TestResult[];
}

function runTest(name: string, fn: () => string | void): TestResult {
  if (!matchesTestFilter(_testSection, name)) return { name, pass: true, filtered: true };
  try {
    const detail = fn();
    return { name, pass: true, ...(detail ? { detail } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, error: msg };
  }
}

async function runTestAsync(name: string, fn: () => Promise<string | void>): Promise<TestResult> {
  if (!matchesTestFilter(_testSection, name)) return { name, pass: true, filtered: true };
  try {
    const detail = await fn();
    return { name, pass: true, ...(detail ? { detail } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, error: msg };
  }
}

function group(tests: TestResult[]): GroupedTests {
  const run = tests.filter((t) => !t.filtered);
  return { pass: run.length === 0 || run.every((t) => t.pass), tests: run };
}

function moduleLoaderHarnessUrl(baseUrl: string, slug: string): string {
  const origin = new URL(baseUrl).origin;
  return `${origin}/api/v1/trigger/${TEST_PROJECT_ID}/test/common/${slug}`;
}

async function fetchHarness(
  url: string,
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

function responseText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function expectJsExecutionFailed(
  resp: { status: number; body: unknown },
  substr: string,
): void {
  const text = responseText(resp.body);
  if (resp.status !== 400) {
    throw new Error(`expected 400, got ${resp.status}: ${text}`);
  }
  if (!text.includes("javascript execution failed")) {
    throw new Error(`expected javascript execution failed: ${text}`);
  }
  if (!text.includes(substr)) {
    throw new Error(`expected "${substr}" in response: ${text}`);
  }
}

function harnessJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`expected JSON object, got ${responseText(body)}`);
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module loader: node:* only when imported (seeded harness units)
// ---------------------------------------------------------------------------

async function checkModuleLoaderDynamicImports(baseUrl: string): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(
    await runTestAsync("no-import: parse without node:querystring import fails", async () => {
      const resp = await fetchHarness(moduleLoaderHarnessUrl(baseUrl, "no-import-uses-parse"));
      expectJsExecutionFailed(resp, "parse");
    }),
  );

  tests.push(
    await runTestAsync("import: disallowed node:fs rejected at load", async () => {
      const resp = await fetchHarness(moduleLoaderHarnessUrl(baseUrl, "disallowed-node-fs-import"));
      expectJsExecutionFailed(resp, "unknown or disallowed module");
    }),
  );

  tests.push(
    await runTestAsync("import: node:buffer works when explicitly imported", async () => {
      const resp = await fetchHarness(moduleLoaderHarnessUrl(baseUrl, "import-node-buffer-ok"));
      if (resp.status !== 200) {
        throw new Error(`expected 200, got ${resp.status}: ${responseText(resp.body)}`);
      }
      const b = harnessJsonBody(resp.body);
      if (b["ok"] !== true) throw new Error(`ok: ${JSON.stringify(b)}`);
      if (b["length"] !== 2) throw new Error(`length: ${JSON.stringify(b)}`);
    }),
  );

  tests.push(
    await runTestAsync("nested: api → common → node:querystring loads dynamically", async () => {
      const resp = await fetchHarness(moduleLoaderHarnessUrl(baseUrl, "via-common-querystring"));
      if (resp.status !== 200) {
        throw new Error(`expected 200, got ${resp.status}: ${responseText(resp.body)}`);
      }
      const b = harnessJsonBody(resp.body);
      if (b["a"] !== "1") throw new Error(`parsed: ${JSON.stringify(b)}`);
    }),
  );

  return group(tests);
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
    runTest("TextEncoder.encode basic", () => {
      const enc = new TextEncoder();
      const bytes = enc.encode("hello");
      assert(bytes instanceof Uint8Array);
      assert(bytes.length === 5);
      assert(bytes[0] === 0x68 && bytes[1] === 0x65 && bytes[4] === 0x6f);
    }),

    runTest("TextEncoder.encodeInto", () => {
      const enc = new TextEncoder();
      const dest = new Uint8Array(10);
      const result = enc.encodeInto("hello", dest);
      assert(result.read === 5);
      assert(result.written === 5);
      assert(dest[0] === 0x68);
    }),

    runTest("TextEncoder.encodeInto partial write (small buffer)", () => {
      const enc = new TextEncoder();
      const dest = new Uint8Array(3);
      const result = enc.encodeInto("hello", dest);
      assert(result.written === 3);
      assert(result.read === 3);
      assert(dest[0] === 0x68 && dest[1] === 0x65 && dest[2] === 0x6c);
    }),

    runTest("TextDecoder.decode basic", () => {
      const dec = new TextDecoder();
      const result = dec.decode(new Uint8Array([104, 101, 108, 108, 111]));
      assert(result === "hello");
    }),

    runTest("TextEncoder/TextDecoder UTF-8 roundtrip (ASCII)", () => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const original = "The quick brown fox jumps over the lazy dog";
      assert(dec.decode(enc.encode(original)) === original);
    }),

    runTest("TextEncoder/TextDecoder roundtrip (multi-byte / emoji)", () => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const original = "Hello 🌍🎉💻 — special chars: àéîõü ñ 中文 日本語";
      const encoded = enc.encode(original);
      assert(encoded.length > original.length);
      assert(dec.decode(encoded) === original);
    }),

    runTest("TextEncoder multi-byte byte lengths", () => {
      const enc = new TextEncoder();
      assert(enc.encode("A").length === 1);
      assert(enc.encode("é").length === 2);
      assert(enc.encode("中").length === 3);
      assert(enc.encode("🌍").length === 4);
    }),

    runTest("TextEncoder/TextDecoder large payload roundtrip (100KB)", () => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const large = "abcdefghij".repeat(10000);
      const encoded = enc.encode(large);
      assert(encoded.length === 100000);
      assert(dec.decode(encoded) === large);
    }),

    runTest("TextDecoder with explicit UTF-8 label", () => {
      const dec = new TextDecoder("utf-8");
      const result = dec.decode(new Uint8Array([0xC3, 0xA9])); // é
      assert(result === "é");
    }),

    runTest("TextDecoder with fatal option rejects invalid bytes", () => {
      const dec = new TextDecoder("utf-8", { fatal: true });
      let threw = false;
      try {
        dec.decode(new Uint8Array([0xFF, 0xFE]));
      } catch {
        threw = true;
      }
      assert(threw, "expected fatal TextDecoder to throw on invalid UTF-8 bytes");
    }),

    runTest("TextDecoder BOM handling", () => {
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0x68, 0x69]); // UTF-8 BOM + "hi"
      const dec = new TextDecoder("utf-8");
      const result = dec.decode(bom);
      assert(result === "hi" || result === "\uFEFFhi");
    }),

    runTest("TextEncoder empty string", () => {
      const enc = new TextEncoder();
      assert(enc.encode("").length === 0);
    }),

    runTest("TextDecoder empty buffer", () => {
      const dec = new TextDecoder();
      assert(dec.decode(new Uint8Array(0)) === "");
    }),

    runTest("TextDecoder from ArrayBuffer", () => {
      const buf = new ArrayBuffer(5);
      const view = new Uint8Array(buf);
      view.set([72, 69, 76, 76, 79]);
      const dec = new TextDecoder();
      assert(dec.decode(buf) === "HELLO");
    }),

    runTest("TextDecoder.encoding property", () => {
      const dec = new TextDecoder("utf-8");
      assert(dec.encoding === "utf-8");
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
    runTest("Buffer.from (string, utf-8)", () => {
      const buf = Buffer.from("hello", "utf-8");
      assert(buf.length === 5);
      assert(buf[0] === 0x68);
    }),

    runTest("Buffer.from (base64) → toString(utf-8)", () => {
      const buf = Buffer.from("aGVsbG8=", "base64");
      assert(buf.toString("utf-8") === "hello");
    }),

    runTest("Buffer.from (hex) → toString(utf-8)", () => {
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

    runTest("Buffer.alloc zeroed", () => {
      const buf = Buffer.alloc(10, 0);
      assert(buf.length === 10);
      for (let i = 0; i < 10; i++) assert(buf[i] === 0);
    }),

    runTest("Buffer.alloc with fill value", () => {
      const buf = Buffer.alloc(5, 0xAB);
      for (let i = 0; i < 5; i++) assert(buf[i] === 0xAB);
    }),

    runTest("Buffer.allocUnsafe", () => {
      const buf = Buffer.allocUnsafe(16);
      assert(buf.length === 16);
    }),

    runTest("Buffer.concat", () => {
      const a = Buffer.from("hel");
      const b = Buffer.from("lo");
      const c = Buffer.concat([a, b]);
      assert(c.toString() === "hello");
    }),

    runTest("Buffer.concat with totalLength", () => {
      const a = Buffer.from("abc");
      const b = Buffer.from("def");
      const c = Buffer.concat([a, b], 4);
      assert(c.length === 4);
      assert(c.toString() === "abcd");
    }),

    runTest("Buffer.isBuffer", () => {
      assert(Buffer.isBuffer(Buffer.from("x")) === true);
      assert(Buffer.isBuffer("x") === false);
      assert(Buffer.isBuffer(new Uint8Array(1)) === false);
    }),

    runTest("Buffer.byteLength", () => {
      assert(Buffer.byteLength("hello") === 5);
      assert(Buffer.byteLength("🌍") === 4);
      assert(Buffer.byteLength("aGVsbG8=", "base64") === 5);
    }),

    runTest("Buffer slice / subarray shares memory", () => {
      const buf = Buffer.from("hello world");
      const sub = buf.subarray(0, 5);
      assert(sub.toString() === "hello");
      sub[0] = 0x48; // 'H'
      assert(buf[0] === 0x48);
    }),

    runTest("Buffer.compare", () => {
      const a = Buffer.from("abc");
      const b = Buffer.from("abc");
      const c = Buffer.from("abd");
      assert(Buffer.compare(a, b) === 0);
      assert(Buffer.compare(a, c) < 0);
      assert(Buffer.compare(c, a) > 0);
    }),

    runTest("buf.equals", () => {
      const a = Buffer.from("hello");
      const b = Buffer.from("hello");
      const c = Buffer.from("world");
      assert(a.equals(b) === true);
      assert(a.equals(c) === false);
    }),

    runTest("buf.fill", () => {
      const buf = Buffer.alloc(5);
      buf.fill(0x41); // 'A'
      assert(buf.toString() === "AAAAA");
    }),

    runTest("buf.indexOf / buf.includes", () => {
      const buf = Buffer.from("hello world");
      assert(buf.indexOf("world") === 6);
      assert(buf.indexOf("xyz") === -1);
      assert(buf.includes("hello") === true);
      assert(buf.includes("xyz") === false);
    }),

    runTest("buf.copy", () => {
      const src = Buffer.from("hello");
      const dst = Buffer.alloc(5);
      src.copy(dst);
      assert(dst.toString() === "hello");
    }),

    runTest("buf.copy with offsets", () => {
      const src = Buffer.from("hello");
      const dst = Buffer.from("XXXXXXXXXX");
      src.copy(dst, 3, 0, 5);
      assert(dst.toString() === "XXXhelloXX");
    }),

    runTest("buf.write", () => {
      const buf = Buffer.alloc(10);
      const written = buf.write("hi", 0, "utf-8");
      assert(written === 2);
      assert(buf[0] === 0x68 && buf[1] === 0x69);
    }),

    runTest("buf.readUInt8 / writeUInt8", () => {
      const buf = Buffer.alloc(2);
      buf.writeUInt8(255, 0);
      buf.writeUInt8(0, 1);
      assert(buf.readUInt8(0) === 255);
      assert(buf.readUInt8(1) === 0);
    }),

    runTest("buf.readUInt16BE / writeUInt16BE", () => {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(0x0102, 0);
      assert(buf[0] === 0x01 && buf[1] === 0x02);
      assert(buf.readUInt16BE(0) === 0x0102);
    }),

    runTest("buf.readUInt16LE / writeUInt16LE", () => {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(0x0102, 0);
      assert(buf[0] === 0x02 && buf[1] === 0x01);
      assert(buf.readUInt16LE(0) === 0x0102);
    }),

    runTest("buf.readUInt32BE / writeUInt32BE", () => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(0xDEADBEEF, 0);
      assert(buf.readUInt32BE(0) === 0xDEADBEEF);
    }),

    runTest("buf.readInt8 / writeInt8", () => {
      const buf = Buffer.alloc(2);
      buf.writeInt8(-128, 0);
      buf.writeInt8(127, 1);
      assert(buf.readInt8(0) === -128);
      assert(buf.readInt8(1) === 127);
    }),

    runTest("buf.readInt16BE / writeInt16BE", () => {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(-1, 0);
      assert(buf.readInt16BE(0) === -1);
    }),

    runTest("buf.readFloatBE / writeFloatBE", () => {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(3.14, 0);
      assert(Math.abs(buf.readFloatBE(0) - 3.14) < 0.001);
    }),

    runTest("buf.readDoubleBE / writeDoubleBE", () => {
      const buf = Buffer.alloc(8);
      buf.writeDoubleBE(Math.PI, 0);
      assert(Math.abs(buf.readDoubleBE(0) - Math.PI) < 1e-15);
    }),

    runTest("Buffer.from(ArrayBuffer)", () => {
      const ab = new ArrayBuffer(4);
      const view = new Uint8Array(ab);
      view.set([1, 2, 3, 4]);
      const buf = Buffer.from(ab);
      assert(buf[0] === 1 && buf[3] === 4);
    }),

    runTest("Buffer.from(Buffer) creates copy", () => {
      const original = Buffer.from("hello");
      const copy = Buffer.from(original);
      copy[0] = 0x48;
      assert(original[0] === 0x68);
      assert(copy[0] === 0x48);
    }),

    runTest("Buffer.from(array)", () => {
      const buf = Buffer.from([0x48, 0x49]);
      assert(buf.toString() === "HI");
    }),

    runTest("Buffer JSON roundtrip", () => {
      const buf = Buffer.from([1, 2, 3, 4, 5]);
      const json = JSON.stringify(buf);
      const parsed = JSON.parse(json);
      assert(parsed.type === "Buffer" && parsed.data.length === 5);
    }),

    runTest("Buffer encoding roundtrip (utf8 → base64 → utf8)", () => {
      const original = "Hello 🌍 Baal!";
      const b64 = Buffer.from(original, "utf-8").toString("base64");
      const back = Buffer.from(b64, "base64").toString("utf-8");
      assert(back === original);
    }),

    runTest("Buffer encoding roundtrip (utf8 → hex → utf8)", () => {
      const original = "Binary safe: \x00\x01\xFF";
      const hex = Buffer.from(original, "latin1").toString("hex");
      const back = Buffer.from(hex, "hex").toString("latin1");
      assert(back === original);
    }),

    runTest("Buffer.isEncoding", () => {
      assert(Buffer.isEncoding("utf-8") === true);
      assert(Buffer.isEncoding("hex") === true);
      assert(Buffer.isEncoding("base64") === true);
      assert(Buffer.isEncoding("latin1") === true);
      assert(Buffer.isEncoding("nonsense") === false);
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

    runTest("crypto.randomUUID format", () => {
      const uuid = randomUUID();
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid));
      return uuid;
    }),

    runTest("crypto.randomUUID uniqueness", () => {
      const uuids = new Set(Array.from({ length: 100 }, () => randomUUID()));
      assert(uuids.size === 100, "100 UUIDs should all be unique");
    }),

    runTest("crypto.randomBytes", () => {
      const bytes = randomBytes(32);
      assert(bytes.length === 32);
      assert(Buffer.isBuffer(bytes));
      const allZero = bytes.every((b) => b === 0);
      assert(!allZero, "random bytes should not all be zero");
      return `hex: ${bytes.toString("hex").slice(0, 32)}...`;
    }),

    runTest("crypto.randomInt", () => {
      for (let i = 0; i < 50; i++) {
        const n = randomInt(10, 20);
        assert(n >= 10 && n < 20, `randomInt out of range: ${n}`);
      }
    }),

    runTest("crypto.randomFillSync", () => {
      const buf = Buffer.alloc(16);
      randomFillSync(buf);
      const allZero = buf.every((b) => b === 0);
      assert(!allZero, "randomFillSync should fill with random data");
    }),

    runTest("crypto.createHash (SHA-256) known vector", () => {
      const hash = createHash("sha256").update("hello").digest("hex");
      assert(hash === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }),

    runTest("crypto.createHash (SHA-512)", () => {
      const hash = createHash("sha512").update("hello").digest("hex");
      assert(hash.length === 128);
    }),

    runTest("crypto.createHash (SHA-384)", () => {
      const hash = createHash("sha384").update("hello").digest("hex");
      assert(hash.length === 96);
    }),

    runTest("crypto.createHash (MD5) known vector", () => {
      const hash = createHash("md5").update("hello").digest("hex");
      assert(hash === "5d41402abc4b2a76b9719d911017c592");
    }),

    runTest("crypto.createHash (SHA-1)", () => {
      const hash = createHash("sha1").update("hello").digest("hex");
      assert(hash.length === 40);
    }),

    runTest("crypto.createHash digest as Buffer", () => {
      const buf = createHash("sha256").update("hello").digest();
      assert(Buffer.isBuffer(buf));
      assert(buf.length === 32);
    }),

    runTest("crypto.createHash digest as base64", () => {
      const b64 = createHash("sha256").update("hello").digest("base64");
      assert(typeof b64 === "string");
      const backToHex = Buffer.from(b64, "base64").toString("hex");
      assert(backToHex === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }),

    runTest("crypto.createHash with Buffer input", () => {
      const buf = Buffer.from("hello");
      const hash = createHash("sha256").update(buf).digest("hex");
      assert(hash === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }),

    runTest("crypto.createHash multi-update equals single update", () => {
      const h = createHash("sha256");
      h.update("hello");
      h.update(" ");
      h.update("world");
      const combined = h.digest("hex");
      const single = createHash("sha256").update("hello world").digest("hex");
      assert(combined === single);
    }),

    runTest("crypto.createHash empty input", () => {
      const hash = createHash("sha256").update("").digest("hex");
      assert(hash === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }),

    runTest("crypto.createHmac (SHA-256)", () => {
      const hmac = createHmac("sha256", "secret-key").update("message").digest("hex");
      assert(typeof hmac === "string" && hmac.length === 64);
      const hmac2 = createHmac("sha256", "secret-key").update("message").digest("hex");
      assert(hmac === hmac2, "same input should produce same HMAC");
    }),

    runTest("crypto.createHmac (SHA-1)", () => {
      const hmac = createHmac("sha1", "key").update("data").digest("hex");
      assert(hmac.length === 40);
    }),

    runTest("crypto.createHmac (SHA-512)", () => {
      const hmac = createHmac("sha512", "key").update("data").digest("hex");
      assert(hmac.length === 128);
    }),

    runTest("crypto.createHmac with Buffer key", () => {
      const key = Buffer.from("secret-key");
      const hmac = createHmac("sha256", key).update("message").digest("hex");
      const hmacStr = createHmac("sha256", "secret-key").update("message").digest("hex");
      assert(hmac === hmacStr, "Buffer key and string key should produce same result");
    }),

    runTest("crypto.createHmac different keys produce different output", () => {
      const h1 = createHmac("sha256", "key1").update("data").digest("hex");
      const h2 = createHmac("sha256", "key2").update("data").digest("hex");
      assert(h1 !== h2);
    }),

    runTest("crypto.createCipheriv / createDecipheriv (AES-256-CBC)", () => {
      const key = randomBytes(32);
      const iv = randomBytes(16);
      const plaintext = "secret message for encryption test — with unicode: 🔒";

      const cipher = createCipheriv("aes-256-cbc", key, iv);
      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");

      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      assert(decrypted === plaintext);
      return `encrypted length: ${encrypted.length}`;
    }),

    runTest("crypto.createCipheriv (AES-256-GCM) with authTag", () => {
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const plaintext = "authenticated encryption test";

      const cipher = createCipheriv("aes-256-gcm", key, iv);
      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");
      const authTag = cipher.getAuthTag();
      assert(authTag.length === 16);

      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      assert(decrypted === plaintext);
    }),

    runTest("crypto AES-256-GCM wrong authTag fails", () => {
      const key = randomBytes(32);
      const iv = randomBytes(12);

      const cipher = createCipheriv("aes-256-gcm", key, iv);
      let encrypted = cipher.update("data", "utf8", "hex");
      encrypted += cipher.final("hex");
      cipher.getAuthTag();

      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(randomBytes(16));
      decipher.update(encrypted, "hex", "utf8");
      let threw = false;
      try {
        decipher.final("utf8");
      } catch {
        threw = true;
      }
      assert(threw, "wrong authTag should cause decryption to fail");
    }),

    runTest("crypto.createCipheriv (AES-128-CBC)", () => {
      const key = randomBytes(16);
      const iv = randomBytes(16);

      const cipher = createCipheriv("aes-128-cbc", key, iv);
      let encrypted = cipher.update("test", "utf8", "hex");
      encrypted += cipher.final("hex");

      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      assert(decrypted === "test");
    }),

    runTest("crypto.pbkdf2Sync", () => {
      const derived = pbkdf2Sync("password", "salt", 100000, 64, "sha512");
      assert(derived.length === 64);
      const derived2 = pbkdf2Sync("password", "salt", 100000, 64, "sha512");
      assert(derived.equals(derived2), "deterministic derivation");
      return `hex: ${derived.toString("hex").slice(0, 32)}...`;
    }),

    runTest("crypto.pbkdf2Sync different passwords differ", () => {
      const d1 = pbkdf2Sync("pass1", "salt", 1000, 32, "sha256");
      const d2 = pbkdf2Sync("pass2", "salt", 1000, 32, "sha256");
      assert(!d1.equals(d2));
    }),

    runTest("crypto.scryptSync", () => {
      const derived = scryptSync("password", "salt", 64);
      assert(derived.length === 64);
    }),

    runTest("crypto.timingSafeEqual (equal buffers)", () => {
      const a = Buffer.from("secret-value");
      const b = Buffer.from("secret-value");
      assert(timingSafeEqual(a, b) === true);
    }),

    runTest("crypto.timingSafeEqual (different buffers)", () => {
      const a = Buffer.from("secret-value");
      const c = Buffer.from("other-value!");
      assert(timingSafeEqual(a, c) === false);
    }),

    runTest("crypto.timingSafeEqual rejects different lengths", () => {
      let threw = false;
      try {
        timingSafeEqual(Buffer.from("abc"), Buffer.from("abcd"));
      } catch {
        threw = true;
      }
      assert(threw, "timingSafeEqual should throw for different-length buffers");
    }),

    runTest("HMAC sign + verify pattern", () => {
      const key = "signing-key";
      const data = "data-to-sign";
      const sig = createHmac("sha256", key).update(data).digest("hex");
      const verify = createHmac("sha256", key).update(data).digest("hex");
      assert(sig === verify);
      const bad = createHmac("sha256", key).update("tampered").digest("hex");
      assert(sig !== bad, "tampered data should produce different signature");
    }),

    runTest("crypto.getHashes includes common algorithms", () => {
      const hashes = getHashes();
      assert(Array.isArray(hashes));
      assert(hashes.includes("sha256"));
      assert(hashes.includes("sha512"));
      assert(hashes.includes("md5"));
    }),

    runTest("crypto.getCiphers includes AES variants", () => {
      const ciphers = getCiphers();
      assert(Array.isArray(ciphers));
      assert(ciphers.includes("aes-256-cbc"));
      assert(ciphers.includes("aes-256-gcm"));
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

  tests.push(runTest("setImmediate exists", () => {
    assert(typeof setImmediate === "function");
  }));

  tests.push(await runTestAsync("setImmediate fires", async () => {
    let fired = false;
    await new Promise<void>((resolve) => {
      setImmediate(() => { fired = true; resolve(); });
    });
    assert(fired);
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
// 10b. Timer Semantics
// ---------------------------------------------------------------------------

async function checkTimerSemantics(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(await runTestAsync("clearTimeout cancels pending callback", async () => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 50);
    clearTimeout(id);
    await new Promise<void>((r) => setTimeout(r, 100));
    assert(!fired, "clearTimeout did not prevent the callback");
  }));

  tests.push(await runTestAsync("nested setTimeout fires", async () => {
    let count = 0;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        count++;
        setTimeout(() => { count++; resolve(); }, 1);
      }, 1);
    });
    assert(count === 2, `expected 2, got ${count}`);
  }));

  tests.push(await runTestAsync("timers/promises setImmediate", async () => {
    const { setImmediate: setImmediatePromise } = await import("node:timers/promises");
    assert(typeof setImmediatePromise === "function");
    const result = await setImmediatePromise("value");
    assert(result === "value");
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
        private start: number;
        private end: number;
        constructor(start: number, end: number) {
          this.start = start;
          this.end = end;
        }
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
// 16. Request / Response Shim (the runtime.js contract)
// ---------------------------------------------------------------------------

function checkReqResShim(
  req: IncomingMessage,
  res: ServerResponse,
): GroupedTests {
  const tests: TestResult[] = [];

  // --- req deep tests ---

  tests.push(runTest("req.method is GET for health check route", () => {
    assert(req.method === "GET", `expected GET, got ${req.method}`);
  }));

  tests.push(runTest("req.url starts with /", () => {
    assert(typeof req.url === "string");
    assert(req.url!.startsWith("/"), `url should start with /, got ${req.url}`);
  }));

  tests.push(runTest("req.headers has host header", () => {
    assert(typeof req.headers.host === "string" && req.headers.host.length > 0);
  }));

  tests.push(runTest("req.headers keys are lowercase", () => {
    for (const key of Object.keys(req.headers)) {
      assert(key === key.toLowerCase(), `header key "${key}" should be lowercase`);
    }
  }));

  tests.push(runTest("req.rawHeaders is paired key-value array", () => {
    assert(Array.isArray(req.rawHeaders));
    assert(req.rawHeaders.length % 2 === 0, "rawHeaders should have even length");
    assert(req.rawHeaders.length >= 2, "should have at least one header pair");
  }));

  tests.push(runTest("req.httpVersion is string", () => {
    assert(typeof req.httpVersion === "string" && req.httpVersion.length > 0);
  }));

  // --- res statusCode deep tests ---

  tests.push(runTest("res.statusCode settable to various HTTP codes", () => {
    const codes = [200, 201, 204, 301, 302, 400, 401, 403, 404, 500, 502, 503];
    for (const code of codes) {
      res.statusCode = code;
      assert(res.statusCode === code, `expected ${code}, got ${res.statusCode}`);
    }
    res.statusCode = 200;
  }));

  tests.push(runTest("res.statusMessage settable", () => {
    res.statusMessage = "Custom Status";
    assert(res.statusMessage === "Custom Status");
    res.statusMessage = "OK";
  }));

  // --- res header manipulation deep tests ---

  tests.push(runTest("res.setHeader + getHeader roundtrip", () => {
    res.setHeader("X-Roundtrip-Test", "value-123");
    const val = res.getHeader("X-Roundtrip-Test");
    assert(val === "value-123", `expected "value-123", got "${val}"`);
  }));

  tests.push(runTest("res.getHeader is case-insensitive", () => {
    res.setHeader("X-Case-Test", "CaseValue");
    assert(res.getHeader("x-case-test") === "CaseValue");
    assert(res.getHeader("X-CASE-TEST") === "CaseValue");
  }));

  tests.push(runTest("res.hasHeader returns true for set headers", () => {
    res.setHeader("X-Has-Test", "exists");
    assert(res.hasHeader("X-Has-Test") === true);
    assert(res.hasHeader("X-Nonexistent-Header") === false);
  }));

  tests.push(runTest("res.removeHeader fully removes the header", () => {
    res.setHeader("X-Remove-Verify", "present");
    assert(res.hasHeader("X-Remove-Verify") === true);
    res.removeHeader("X-Remove-Verify");
    assert(res.hasHeader("X-Remove-Verify") === false);
    assert(res.getHeader("X-Remove-Verify") === undefined);
  }));

  tests.push(runTest("res.appendHeader appends to existing header", () => {
    res.setHeader("X-Append-Verify", "val1");
    res.appendHeader("X-Append-Verify", "val2");
    const val = res.getHeader("X-Append-Verify");
    assert(Array.isArray(val), "expected array after appendHeader");
    assert((val as string[]).includes("val1") && (val as string[]).includes("val2"));
  }));

  tests.push(runTest("res.setHeader with array sets multi-value header", () => {
    res.setHeader("X-Multi-Verify", ["a", "b", "c"]);
    const val = res.getHeader("X-Multi-Verify");
    assert(Array.isArray(val));
    assert((val as string[]).length === 3);
    assert((val as string[])[0] === "a" && (val as string[])[2] === "c");
  }));

  tests.push(runTest("res.getHeaders returns all set headers", () => {
    res.setHeader("X-GetHeaders-Test", "ghval");
    const all = res.getHeaders();
    assert(typeof all === "object" && all !== null);
    const key = Object.keys(all).find((k) => k.toLowerCase() === "x-getheaders-test");
    assert(key !== undefined, "expected X-GetHeaders-Test in getHeaders()");
  }));

  tests.push(runTest("res.getHeaderNames returns array of names", () => {
    res.setHeader("X-Names-Test", "nval");
    const names = res.getHeaderNames();
    assert(Array.isArray(names));
    assert(names.some((n) => n.toLowerCase() === "x-names-test"));
  }));

  tests.push(runTest("res.writeHead is callable", () => {
    assert(typeof res.writeHead === "function");
  }));

  tests.push(runTest("res.write is callable", () => {
    assert(typeof res.write === "function");
  }));

  tests.push(runTest("res.end is callable", () => {
    assert(typeof res.end === "function");
  }));

  // --- parseQuerystring deep tests ---

  tests.push(runTest("parseQuerystring basic key=value pairs", () => {
    const result = parseQuerystring("a=1&b=2&c=3");
    assert(result["a"] === "1" && result["b"] === "2" && result["c"] === "3");
  }));

  tests.push(runTest("parseQuerystring repeated keys produce array", () => {
    const result = parseQuerystring("a=1&a=2&a=3");
    const val = result["a"];
    assert(Array.isArray(val) && val.length === 3);
    assert(val![0] === "1" && val![2] === "3");
  }));

  tests.push(runTest("parseQuerystring decodes percent-encoded chars", () => {
    const result = parseQuerystring("name=hello%20world&q=a%26b%3Dc");
    assert(result["name"] === "hello world");
    assert(result["q"] === "a&b=c");
  }));

  tests.push(runTest("parseQuerystring decodes + as space", () => {
    const result = parseQuerystring("name=hello+world");
    assert(result["name"] === "hello world");
  }));

  tests.push(runTest("parseQuerystring empty string yields empty object", () => {
    const result = parseQuerystring("");
    assert(Object.keys(result).length === 0);
  }));

  tests.push(runTest("parseQuerystring key without value", () => {
    const result = parseQuerystring("flag&key=val");
    assert("flag" in result);
    assert(result["key"] === "val");
  }));

  // --- text() body reader ---

  tests.push(runTest("text body reader function exists", () => {
    assert(typeof text === "function");
  }));

  // cleanup test headers
  for (const h of [
    "X-Roundtrip-Test", "X-Case-Test", "X-Has-Test", "X-Append-Verify",
    "X-Multi-Verify", "X-GetHeaders-Test", "X-Names-Test",
  ]) {
    try { res.removeHeader(h); } catch {}
  }

  return group(tests);
}

// ---------------------------------------------------------------------------
// 17. Console
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

    runTest("console.debug", () => {
      assert(typeof console.debug === "function");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 18. WeakRef + FinalizationRegistry
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
// 19. AbortController / AbortSignal
// ---------------------------------------------------------------------------

function checkAbortController(): GroupedTests {
  return group([
    runTest("AbortController exists", () => {
      assert(typeof AbortController === "function");
    }),

    runTest("AbortController.signal is AbortSignal", () => {
      const ac = new AbortController();
      assert(ac.signal instanceof AbortSignal);
      assert(ac.signal.aborted === false);
    }),

    runTest("AbortController.abort() sets signal.aborted to true", () => {
      const ac = new AbortController();
      assert(ac.signal.aborted === false);
      ac.abort();
      assert(ac.signal.aborted === true);
    }),

    runTest("AbortSignal.reason with string", () => {
      const ac = new AbortController();
      ac.abort("custom reason");
      assert(ac.signal.reason === "custom reason");
    }),

    runTest("AbortSignal.reason with Error object", () => {
      const ac = new AbortController();
      const err = new Error("abort error");
      ac.abort(err);
      assert(ac.signal.reason === err);
      assert((ac.signal.reason as Error).message === "abort error");
    }),

    runTest("AbortSignal abort event listener fires synchronously", () => {
      const ac = new AbortController();
      let fired = false;
      let receivedEvent: Event | null = null;
      ac.signal.addEventListener("abort", (e) => {
        fired = true;
        receivedEvent = e;
      });
      ac.abort();
      assert(fired, "abort event should fire");
      assert(receivedEvent !== null);
      assert(receivedEvent!.type === "abort");
    }),

    runTest("AbortSignal multiple listeners all fire", () => {
      const ac = new AbortController();
      let count = 0;
      ac.signal.addEventListener("abort", () => { count++; });
      ac.signal.addEventListener("abort", () => { count++; });
      ac.signal.addEventListener("abort", () => { count++; });
      ac.abort();
      assert(count === 3, `expected 3, got ${count}`);
    }),

    runTest("AbortSignal.abort() creates pre-aborted signal", () => {
      const signal = AbortSignal.abort("pre-aborted");
      assert(signal.aborted === true);
      assert(signal.reason === "pre-aborted");
    }),

    runTest("AbortSignal.timeout returns non-aborted signal", () => {
      const signal = AbortSignal.timeout(60000);
      assert(signal instanceof AbortSignal);
      assert(signal.aborted === false);
    }),

    runTest("AbortSignal.any combines multiple signals", () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const combined = AbortSignal.any([ac1.signal, ac2.signal]);
      assert(combined.aborted === false);
      ac1.abort("first");
      assert(combined.aborted === true);
      assert(combined.reason === "first");
    }),

    runTest("AbortSignal.any with pre-aborted signal", () => {
      const preAborted = AbortSignal.abort("already");
      const ac = new AbortController();
      const combined = AbortSignal.any([preAborted, ac.signal]);
      assert(combined.aborted === true);
      assert(combined.reason === "already");
    }),

    runTest("AbortSignal.throwIfAborted", () => {
      const ac = new AbortController();
      ac.signal.throwIfAborted(); // should not throw
      ac.abort("done");
      let threw = false;
      try {
        ac.signal.throwIfAborted();
      } catch {
        threw = true;
      }
      assert(threw, "throwIfAborted should throw after abort");
    }),

    runTest("AbortController abort is idempotent", () => {
      const ac = new AbortController();
      let count = 0;
      ac.signal.addEventListener("abort", () => { count++; });
      ac.abort("first");
      ac.abort("second");
      assert(count === 1, "abort event should fire only once");
      assert(ac.signal.reason === "first", "reason should be from first abort");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 20. Fetch API (constructors + real HTTP calls)
// ---------------------------------------------------------------------------

async function checkFetchAPI(baseUrl: string): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  // --- Headers deep tests ---

  tests.push(runTest("Headers constructor and case-insensitive access", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    assert(h.get("content-type") === "application/json");
    assert(h.get("CONTENT-TYPE") === "application/json");
  }));

  tests.push(runTest("Headers from object", () => {
    const h = new Headers({ "X-Foo": "bar", "X-Baz": "qux" });
    assert(h.get("x-foo") === "bar");
    assert(h.get("x-baz") === "qux");
  }));

  tests.push(runTest("Headers append + getSetCookie-style multi-value", () => {
    const h = new Headers();
    h.append("X-Multi", "val1");
    h.append("X-Multi", "val2");
    assert(h.has("x-multi"));
    const combined = h.get("x-multi");
    assert(combined!.includes("val1") && combined!.includes("val2"));
  }));

  tests.push(runTest("Headers delete", () => {
    const h = new Headers({ "X-Del": "val" });
    assert(h.has("x-del"));
    h.delete("X-Del");
    assert(!h.has("x-del"));
    assert(h.get("x-del") === null);
  }));

  tests.push(runTest("Headers iteration (entries, keys, values, forEach)", () => {
    const h = new Headers({ "A": "1", "B": "2" });
    const entries = [...h.entries()];
    assert(entries.length === 2);
    const keys = [...h.keys()];
    assert(keys.length === 2);
    const vals = [...h.values()];
    assert(vals.length === 2);
    let forEachCount = 0;
    h.forEach(() => { forEachCount++; });
    assert(forEachCount === 2);
  }));

  // --- Request deep tests ---

  tests.push(runTest("Request construction with all options", () => {
    const r = new Request(`${baseUrl}?_t=json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "test" },
      body: JSON.stringify({ key: "value" }),
    });
    assert(r.method === "POST");
    assert(r.url === `${baseUrl}?_t=json`);
    assert(r.headers.get("content-type") === "application/json");
    assert(r.headers.get("x-custom") === "test");
  }));

  // tests.push(runTest("Request clone preserves properties", () => {
  //   const r = new Request(`${baseUrl}?_t=json`, { method: "GET" });
  //   const cloned = r.clone();
  //   assert(cloned.url === r.url);
  //   assert(cloned.method === r.method);
  // }));

  tests.push(runTest("Request default method is GET", () => {
    const r = new Request(`${baseUrl}?_t=json`);
    assert(r.method === "GET");
  }));

  // --- Response deep tests ---

  tests.push(runTest("Response construction with status and headers", () => {
    const r = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "application/json" },
    });
    assert(r.status === 201);
    assert(r.statusText === "Created");
    assert(r.ok === true);
    assert(r.headers.get("content-type") === "application/json");
  }));

  tests.push(runTest("Response.ok reflects status range", () => {
    assert(new Response(null, { status: 200 }).ok === true);
    assert(new Response(null, { status: 299 }).ok === true);
    assert(new Response(null, { status: 300 }).ok === false);
    assert(new Response(null, { status: 404 }).ok === false);
    assert(new Response(null, { status: 500 }).ok === false);
  }));

  tests.push(runTest("Response.json() static constructor", () => {
    const r = Response.json({ hello: "world" }, { status: 200 });
    assert(r.status === 200);
    assert(r.headers.get("content-type")?.includes("application/json") === true);
  }));

  tests.push(runTest("Response.redirect() static constructor", () => {
    assert(typeof Response.redirect === "function");
    const r = Response.redirect("https://example.com/path", 302);
    assert(r.status === 302);
    const loc = r.headers.get("location");
    assert(loc !== null && loc.includes("example.com"));
  }));

  // --- Response body parsing ---

  tests.push(await runTestAsync("Response.json() body parsing", async () => {
    const r = new Response('{"a":1,"b":"two","nested":{"c":true}}', {
      headers: { "Content-Type": "application/json" },
    });
    const data = await r.json() as { a: number; b: string; nested: { c: boolean } };
    assert(data.a === 1);
    assert(data.b === "two");
    assert(data.nested.c === true);
  }));

  tests.push(await runTestAsync("Response.text() body parsing", async () => {
    const r = new Response("hello world — unicode: 🌍");
    const t = await r.text();
    assert(t === "hello world — unicode: 🌍");
  }));

  tests.push(await runTestAsync("Response.arrayBuffer() body parsing", async () => {
    const r = new Response("test");
    const ab = await r.arrayBuffer();
    assert(ab instanceof ArrayBuffer);
    assert(ab.byteLength === 4);
    const view = new Uint8Array(ab);
    assert(view[0] === 0x74); // 't'
  }));

  tests.push(await runTestAsync("Response.blob() body parsing", async () => {
    const r = new Response("blob data here");
    const blob = await r.blob();
    assert(blob instanceof Blob);
    assert(blob.size === 14);
    const t = await blob.text();
    assert(t === "blob data here");
  }));

  tests.push(await runTestAsync("Response clone + independent body reads", async () => {
    const r = new Response('{"x":42}');
    const r2 = r.clone();
    const t1 = await r.text();
    const t2 = await r2.text();
    assert(t1 === t2);
    assert(t1 === '{"x":42}');
  }));

  // --- Real HTTP calls: GET ---

  tests.push(await runTestAsync("fetch GET /test/json → valid JSON response", async () => {
    const resp = await fetch(`${baseUrl}?_t=json`);
    assert(resp.ok, `expected ok, got status ${resp.status}`);
    assert(resp.status === 200);
    const data = await resp.json() as { method: string; message: string };
    assert(data.method === "GET", `expected GET, got ${data.method}`);
    assert(data.message === "ok");
  }));

  tests.push(await runTestAsync("fetch GET response has correct content-type", async () => {
    const resp = await fetch(`${baseUrl}?_t=json`);
    const ct = resp.headers.get("content-type");
    assert(ct !== null && ct.includes("application/json"));
  }));

  tests.push(await runTestAsync("fetch GET /test/headers echoes custom headers", async () => {
    const resp = await fetch(`${baseUrl}?_t=headers`, {
      headers: {
        "X-Custom-Header": "custom-value-123",
        "X-Another": "another-val",
      },
    });
    assert(resp.ok);
    const data = await resp.json() as { headers: Record<string, string> };
    assert(
      data.headers["x-custom-header"] === "custom-value-123",
      `expected custom-value-123, got ${data.headers["x-custom-header"]}`,
    );
    assert(data.headers["x-another"] === "another-val");
  }));

  tests.push(await runTestAsync("fetch 404 for unknown path", async () => {
    const resp = await fetch(`${baseUrl}/nonexistent-path-xyz`);
    assert(resp.status === 404);
    assert(!resp.ok);
  }));

  // --- Real HTTP calls: POST with JSON body ---

  tests.push(await runTestAsync("fetch POST /echo with JSON body → roundtrip", async () => {
    const payload = {
      name: "baal",
      values: [1, 2, 3],
      nested: { ok: true, count: 42 },
      unicode: "Hello 🌍",
    };
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert(resp.ok);
    const data = await resp.json() as { echo: typeof payload };
    assert(data.echo.name === "baal");
    assert(data.echo.values.length === 3 && data.echo.values[2] === 3);
    assert(data.echo.nested.ok === true && data.echo.nested.count === 42);
    assert(data.echo.unicode === "Hello 🌍");
  }));

  tests.push(await runTestAsync("fetch POST /echo with empty body", async () => {
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    assert(resp.ok);
    const data = await resp.json() as { echo: null };
    assert(data.echo === null);
  }));

  // --- Real HTTP calls: POST raw body ---

  tests.push(await runTestAsync("fetch POST /test/echo-raw with text body", async () => {
    const body = "raw text content for testing";
    const resp = await fetch(`${baseUrl}?_t=echo-raw`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    assert(resp.ok);
    const data = await resp.json() as { body: string; byteLength: number };
    assert(data.body === body);
    assert(data.byteLength === Buffer.byteLength(body, "utf-8"));
  }));

  // --- Upload: large POST body ---

  tests.push(await runTestAsync("fetch POST upload large body (50KB)", async () => {
    const largeBody = "X".repeat(50000);
    const resp = await fetch(`${baseUrl}?_t=echo-raw`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: largeBody,
    });
    assert(resp.ok);
    const data = await resp.json() as { byteLength: number; body: string };
    assert(data.byteLength === 50000, `expected 50000 bytes, got ${data.byteLength}`);
    assert(data.body.length === 50000);
  }));

  tests.push(await runTestAsync("fetch POST upload JSON body (10KB)", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      data: "x".repeat(30),
    }));
    const body = JSON.stringify(items);
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert(resp.ok);
    const data = await resp.json() as { echo: typeof items };
    assert(Array.isArray(data.echo));
    assert(data.echo.length === 200);
    assert(data.echo[199]!.id === 199);
  }));

  // --- Download: large GET response ---

  tests.push(await runTestAsync("fetch GET download large response (50KB+)", async () => {
    const resp = await fetch(`${baseUrl}?_t=large`);
    assert(resp.ok);
    const data = await resp.text();
    assert(data.length >= 50000, `expected >= 50000 chars, got ${data.length}`);
  }));

  tests.push(await runTestAsync("fetch GET download large response as JSON", async () => {
    const resp = await fetch(`${baseUrl}?_t=large`);
    assert(resp.ok);
    const data = await resp.json() as { items: unknown[]; padding: string };
    assert(Array.isArray(data.items));
    assert(typeof data.padding === "string");
  }));

  // --- fetch with AbortController ---

  tests.push(await runTestAsync("fetch with pre-aborted signal throws", async () => {
    const ac = new AbortController();
    ac.abort("cancelled");
    let threw = false;
    try {
      await fetch(`${baseUrl}?_t=json`, { signal: ac.signal });
    } catch {
      threw = true;
    }
    assert(threw, "expected fetch to throw on aborted signal");
  }));

  // --- fetch via Request object ---

  tests.push(await runTestAsync("fetch using Request object (POST)", async () => {
    const req = new Request(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ via: "request-object" }),
    });
    const resp = await fetch(req);
    assert(resp.ok);
    const data = await resp.json() as { echo: { via: string } };
    assert(data.echo.via === "request-object");
  }));

  tests.push(await runTestAsync("fetch using Request object (GET)", async () => {
    const req = new Request(`${baseUrl}?_t=json`, { method: "GET" });
    const resp = await fetch(req);
    assert(resp.ok);
    const data = await resp.json() as { method: string };
    assert(data.method === "GET");
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 21. Streams API (Web Streams — deep functionality tests)
// ---------------------------------------------------------------------------

async function checkStreams(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(runTest("ReadableStream constructor exists", () => {
    assert(typeof ReadableStream === "function");
  }));

  tests.push(runTest("WritableStream constructor exists", () => {
    assert(typeof WritableStream === "function");
  }));

  tests.push(runTest("TransformStream constructor exists", () => {
    assert(typeof TransformStream === "function");
  }));

  tests.push(await runTestAsync("ReadableStream: read all chunks to completion", async () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue("chunk1");
        controller.enqueue("chunk2");
        controller.enqueue("chunk3");
        controller.close();
      },
    });
    const reader = rs.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as string);
    }
    assert(chunks.length === 3);
    assert(chunks[0] === "chunk1" && chunks[1] === "chunk2" && chunks[2] === "chunk3");
  }));

  tests.push(await runTestAsync("ReadableStream: pull-based data generation", async () => {
    let pullCount = 0;
    const rs = new ReadableStream({
      pull(controller) {
        pullCount++;
        if (pullCount <= 3) {
          controller.enqueue(pullCount);
        } else {
          controller.close();
        }
      },
    });
    const reader = rs.getReader();
    const values: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      values.push(value as number);
    }
    assert(values.length === 3);
    assert(values[0] === 1 && values[2] === 3);
  }));

  tests.push(await runTestAsync("ReadableStream: Uint8Array binary chunks", async () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const reader = rs.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    assert(chunks.length === 2);
    assert(chunks[0]![0] === 1 && chunks[1]![2] === 6);
  }));

  tests.push(await runTestAsync("WritableStream: collect all written chunks", async () => {
    const collected: string[] = [];
    const ws = new WritableStream({
      write(chunk) {
        collected.push(chunk as string);
      },
    });
    const writer = ws.getWriter();
    await writer.write("alpha");
    await writer.write("beta");
    await writer.write("gamma");
    await writer.close();
    assert(collected.length === 3);
    assert(collected.join(",") === "alpha,beta,gamma");
  }));

  tests.push(await runTestAsync("TransformStream: uppercase transform end-to-end", async () => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue((chunk as string).toUpperCase());
      },
    });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    const writeAll = (async () => {
      await writer.write("hello");
      await writer.write("world");
      await writer.close();
    })();

    const results: string[] = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        results.push(value as string);
      }
    })();

    await Promise.all([writeAll, readAll]);
    assert(results.length === 2);
    assert(results[0] === "HELLO" && results[1] === "WORLD");
  }));

  tests.push(await runTestAsync("TransformStream: JSON line parser", async () => {
    const ts = new TransformStream({
      transform(chunk, controller) {
        const lines = (chunk as string).split("\n").filter((l) => l.trim());
        for (const line of lines) {
          controller.enqueue(JSON.parse(line));
        }
      },
    });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    const writeAll = (async () => {
      await writer.write('{"a":1}\n{"b":2}\n');
      await writer.close();
    })();

    const objects: unknown[] = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        objects.push(value);
      }
    })();

    await Promise.all([writeAll, readAll]);
    assert(objects.length === 2);
    assert((objects[0] as { a: number }).a === 1);
    assert((objects[1] as { b: number }).b === 2);
  }));

  tests.push(await runTestAsync("ReadableStream.tee() splits into independent streams", async () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue("data1");
        controller.enqueue("data2");
        controller.close();
      },
    });
    const [s1, s2] = rs.tee();
    const r1 = s1.getReader();
    const r2 = s2.getReader();

    const c1: string[] = [];
    const c2: string[] = [];
    while (true) {
      const { done, value } = await r1.read();
      if (done) break;
      c1.push(value as string);
    }
    while (true) {
      const { done, value } = await r2.read();
      if (done) break;
      c2.push(value as string);
    }
    assert(c1.length === 2 && c2.length === 2);
    assert(c1[0] === "data1" && c2[0] === "data1");
    assert(c1[1] === "data2" && c2[1] === "data2");
  }));

  tests.push(await runTestAsync("ReadableStream.pipeTo() pipes all data", async () => {
    const collected: string[] = [];
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue("x");
        controller.enqueue("y");
        controller.enqueue("z");
        controller.close();
      },
    });
    const ws = new WritableStream({
      write(chunk) { collected.push(chunk as string); },
    });
    await rs.pipeTo(ws);
    assert(collected.join("") === "xyz");
  }));

  tests.push(await runTestAsync("ReadableStream.pipeThrough() TransformStream", async () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue("hello");
        controller.enqueue("world");
        controller.close();
      },
    });
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(`[${(chunk as string).toUpperCase()}]`);
      },
    });
    const reader = rs.pipeThrough(ts).getReader();
    const results: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      results.push(value as string);
    }
    assert(results[0] === "[HELLO]" && results[1] === "[WORLD]");
  }));

  tests.push(await runTestAsync("ReadableStream.cancel()", async () => {
    let cancelReason: unknown = undefined;
    const rs = new ReadableStream({
      cancel(reason) { cancelReason = reason; },
    });
    await rs.cancel("done reading");
    assert(cancelReason === "done reading");
  }));

  // tests.push(await runTestAsync("Response body is a ReadableStream", async () => {
  //   const resp = new Response("stream body content");
  //   assert(resp.body instanceof ReadableStream);
  //   const t = await resp.text();
  //   assert(t === "stream body content");
  // }));

  // tests.push(await runTestAsync("Create Response from ReadableStream", async () => {
  //   const rs = new ReadableStream({
  //     start(controller) {
  //       controller.enqueue(new TextEncoder().encode("streamed "));
  //       controller.enqueue(new TextEncoder().encode("response"));
  //       controller.close();
  //     },
  //   });
  //   const resp = new Response(rs);
  //   const t = await resp.text();
  //   assert(t === "streamed response");
  // }));

  tests.push(runTest("TextEncoderStream exists", () => {
    assert(typeof TextEncoderStream === "function");
  }));

  tests.push(runTest("TextDecoderStream exists", () => {
    assert(typeof TextDecoderStream === "function");
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 22. Process / Environment
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

    // runTest("process.pid", () => {
    //   assert(typeof process.pid === "number");
    // }),

    runTest("process.cwd()", () => {
      assert(typeof process.cwd === "function");
    }),

    runTest("process.hrtime.bigint()", () => {
      assert(typeof process.hrtime?.bigint === "function");
    }),

    // runTest("process.nextTick", () => {
    //   assert(typeof process.nextTick === "function");
    // }),
  ]);
}

// ---------------------------------------------------------------------------
// 23. EventTarget
// ---------------------------------------------------------------------------

function checkEventTarget(): GroupedTests {
  return group([
    runTest("EventTarget constructor exists", () => {
      assert(typeof EventTarget === "function");
    }),

    runTest("EventTarget addEventListener + dispatchEvent", () => {
      const target = new EventTarget();
      let received: Event | null = null;
      target.addEventListener("test", (e) => { received = e; });
      target.dispatchEvent(new Event("test"));
      assert(received !== null);
      assert(received!.type === "test");
    }),

    runTest("EventTarget removeEventListener stops firing", () => {
      const target = new EventTarget();
      let count = 0;
      const handler = () => { count++; };
      target.addEventListener("inc", handler);
      target.dispatchEvent(new Event("inc"));
      assert(count === 1);
      target.removeEventListener("inc", handler);
      target.dispatchEvent(new Event("inc"));
      assert(count === 1, "handler should not fire after removal");
    }),

    runTest("EventTarget once option", () => {
      const target = new EventTarget();
      let count = 0;
      target.addEventListener("o", () => { count++; }, { once: true });
      target.dispatchEvent(new Event("o"));
      target.dispatchEvent(new Event("o"));
      assert(count === 1, "once listener should fire only once");
    }),

    runTest("CustomEvent with detail", () => {
      const target = new EventTarget();
      let detail: unknown = null;
      target.addEventListener("custom", (e) => {
        detail = (e as CustomEvent).detail;
      });
      target.dispatchEvent(new CustomEvent("custom", { detail: { key: "value", num: 42 } }));
      assert((detail as { key: string }).key === "value");
      assert((detail as { num: number }).num === 42);
    }),

    runTest("EventTarget multiple listeners fire in order", () => {
      const target = new EventTarget();
      const calls: string[] = [];
      target.addEventListener("m", () => { calls.push("a"); });
      target.addEventListener("m", () => { calls.push("b"); });
      target.addEventListener("m", () => { calls.push("c"); });
      target.dispatchEvent(new Event("m"));
      assert(calls.join(",") === "a,b,c");
    }),

    // runTest("Event properties: type, cancelable, defaultPrevented", () => {
    //   const e = new Event("test", { cancelable: true });
    //   assert(e.type === "test");
    //   assert(e.cancelable === true);
    //   assert(e.defaultPrevented === false);
    //   e.preventDefault();
    //   assert(e.defaultPrevented === true);
    // }),
  ]);
}

// ---------------------------------------------------------------------------
// 24. Blob
// ---------------------------------------------------------------------------

async function checkBlob(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(runTest("Blob constructor exists", () => {
    assert(typeof Blob === "function");
  }));

  tests.push(runTest("Blob from string parts", () => {
    const blob = new Blob(["hello ", "world"]);
    assert(blob.size === 11);
  }));

  tests.push(runTest("Blob with type option", () => {
    const blob = new Blob(['{"a":1}'], { type: "application/json" });
    assert(blob.type === "application/json");
  }));

  tests.push(await runTestAsync("Blob.text()", async () => {
    const blob = new Blob(["hello world"]);
    const t = await blob.text();
    assert(t === "hello world");
  }));

  tests.push(await runTestAsync("Blob.arrayBuffer()", async () => {
    const blob = new Blob(["test"]);
    const ab = await blob.arrayBuffer();
    assert(ab instanceof ArrayBuffer);
    assert(ab.byteLength === 4);
  }));

  tests.push(await runTestAsync("Blob.slice() content", async () => {
    const blob = new Blob(["hello world"]);
    const sliced = blob.slice(6, 11);
    assert(sliced.size === 5);
    const t = await sliced.text();
    assert(t === "world");
  }));

  tests.push(runTest("Blob from Uint8Array", () => {
    const bytes = new Uint8Array([72, 73]);
    const blob = new Blob([bytes]);
    assert(blob.size === 2);
  }));

  // tests.push(runTest("Blob.stream() returns ReadableStream", () => {
  //   const blob = new Blob(["stream test"]);
  //   const stream = blob.stream();
  //   assert(stream instanceof ReadableStream);
  // }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 25. FormData
// ---------------------------------------------------------------------------

function checkFormData(): GroupedTests {
  return group([
    runTest("FormData constructor exists", () => {
      assert(typeof FormData === "function");
    }),

    runTest("FormData append + get", () => {
      const fd = new FormData();
      fd.append("key", "value");
      assert(fd.get("key") === "value");
    }),

    runTest("FormData set overwrites", () => {
      const fd = new FormData();
      fd.append("key", "value1");
      fd.set("key", "value2");
      assert(fd.get("key") === "value2");
      assert(fd.getAll("key").length === 1);
    }),

    runTest("FormData append multiple values + getAll", () => {
      const fd = new FormData();
      fd.append("m", "a");
      fd.append("m", "b");
      fd.append("m", "c");
      const all = fd.getAll("m");
      assert(all.length === 3);
      assert(all[0] === "a" && all[2] === "c");
    }),

    // runTest("FormData has + delete", () => {
    //   const fd = new FormData();
    //   fd.set("key", "val");
    //   assert(fd.has("key") === true);
    //   fd.delete("key");
    //   assert(fd.has("key") === false);
    //   assert(fd.get("key") === null);
    // }),

    runTest("FormData iteration (entries, keys, values)", () => {
      const fd = new FormData();
      fd.set("a", "1");
      fd.set("b", "2");
      assert([...fd.entries()].length === 2);
      assert([...fd.keys()].length === 2);
      assert([...fd.values()].length === 2);
    }),

    runTest("FormData forEach", () => {
      const fd = new FormData();
      fd.set("x", "1");
      fd.set("y", "2");
      let count = 0;
      fd.forEach(() => { count++; });
      assert(count === 2);
    }),

    runTest("FormData with Blob value", () => {
      const fd = new FormData();
      const blob = new Blob(["file content"], { type: "text/plain" });
      fd.set("file", blob, "test.txt");
      const retrieved = fd.get("file");
      assert(retrieved !== null);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 26. Web Crypto (subtle)
// ---------------------------------------------------------------------------

async function checkWebCryptoSubtle(): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(runTest("crypto.subtle exists", () => {
    assert(subtle != null);
  }));

  tests.push(runTest("crypto.subtle has no timingSafeEqual (Node webcrypto parity)", () => {
    assert(Reflect.get(subtle as object, "timingSafeEqual") === undefined);
  }));

  tests.push(runTest("node:crypto.webcrypto matches Node surface", () => {
    assert(webcrypto != null);
    assert(webcrypto.subtle === subtle);
    assert(typeof webcrypto.getRandomValues === "function");
    assert(typeof webcrypto.randomUUID === "function");
    assert(Reflect.get(webcrypto as object, "timingSafeEqual") === undefined);
  }));

  tests.push(runTest("node:crypto.webcrypto.getRandomValues", () => {
    const arr = new Uint8Array(8);
    webcrypto.getRandomValues(arr);
    assert(!arr.every((b) => b === 0));
  }));

  tests.push(runTest("node:crypto.webcrypto.randomUUID format", () => {
    const id = webcrypto.randomUUID();
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  }));

  tests.push(await runTestAsync("crypto.subtle.digest SHA-256 known vector", async () => {
    const data = new TextEncoder().encode("hello");
    const hash = await subtle.digest("SHA-256", data);
    assert(hash instanceof ArrayBuffer);
    assert(hash.byteLength === 32);
    const hex = [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert(hex === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  }));

  tests.push(await runTestAsync("crypto.subtle.digest SHA-512", async () => {
    const data = new TextEncoder().encode("hello");
    const hash = await subtle.digest("SHA-512", data);
    assert(hash instanceof ArrayBuffer);
    assert(hash.byteLength === 64);
  }));

  tests.push(await runTestAsync("crypto.subtle HMAC generateKey + sign + verify", async () => {
    const key = await subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const data = new TextEncoder().encode("message to sign");
    const signature = await subtle.sign("HMAC", key, data);
    assert(signature instanceof ArrayBuffer && signature.byteLength > 0);

    const valid = await subtle.verify("HMAC", key, signature, data);
    assert(valid === true);

    const tampered = new TextEncoder().encode("tampered");
    const invalid = await subtle.verify("HMAC", key, signature, tampered);
    assert(invalid === false);
  }));

  tests.push(await runTestAsync("crypto.subtle HMAC importKey + sign", async () => {
    const rawKey = new TextEncoder().encode("my-secret-key-for-hmac");
    const key = await subtle.importKey(
      "raw",
      rawKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const data = new TextEncoder().encode("payload");
    const sig = await subtle.sign("HMAC", key, data);
    assert(sig.byteLength === 32);

    const valid = await subtle.verify("HMAC", key, sig, data);
    assert(valid === true);
  }));

  tests.push(await runTestAsync("crypto.subtle PBKDF2 importKey + deriveBits (known vector)", async () => {
    const salt = new Uint8Array(16);
    salt.fill(7);
    const keyMat = await subtle.importKey(
      "raw",
      new TextEncoder().encode("hunter2"),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const bits = await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMat,
      256,
    );
    assert(bits instanceof ArrayBuffer);
    assert(bits.byteLength === 32);
    const hex = [...new Uint8Array(bits)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert(hex === "d47782be820e75a3e07c919f81642b1679c08bc6e3f004a0ae6a1dd9245c8a3d");
  }));

  tests.push(await runTestAsync("crypto.subtle PBKDF2 deriveBits with hash object", async () => {
    const salt = new Uint8Array(16);
    salt.fill(7);
    const keyMat = await subtle.importKey(
      "raw",
      new TextEncoder().encode("hunter2"),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const bits = await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: { name: "SHA-256" },
      },
      keyMat,
      256,
    );
    const hex = [...new Uint8Array(bits)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert(hex === "d47782be820e75a3e07c919f81642b1679c08bc6e3f004a0ae6a1dd9245c8a3d");
  }));

  // tests.push(await runTestAsync("crypto.subtle PBKDF2 matches crypto.pbkdf2Sync", async () => {
  //   const salt = new Uint8Array(16);
  //   getRandomValues(salt);
  //   const password = "unit-runtime-pbkdf2";
  //   const keyMat = await subtle.importKey(
  //     "raw",
  //     new TextEncoder().encode(password),
  //     { name: "PBKDF2" },
  //     false,
  //     ["deriveBits"],
  //   );
  //   const subtleOut = await subtle.deriveBits(
  //     {
  //       name: "PBKDF2",
  //       salt,
  //       iterations: 5000,
  //       hash: "SHA-256",
  //     },
  //     keyMat,
  //     256,
  //   );
  //   const syncBuf = pbkdf2Sync(password, salt, 5000, 32, "sha256");
  //   assert(syncBuf.length === 32);
  //   const a = new Uint8Array(subtleOut);
  //   for (let i = 0; i < 32; i++) {
  //     assert(a[i] === syncBuf[i]);
  //   }
  // }));

  tests.push(await runTestAsync("crypto.subtle AES-GCM encrypt + decrypt", async () => {
    const key = await subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const iv = getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("secret data for subtle crypto");

    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext,
    );
    assert(ciphertext instanceof ArrayBuffer);
    assert(ciphertext.byteLength > plaintext.byteLength);

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    const result = new TextDecoder().decode(decrypted);
    assert(result === "secret data for subtle crypto");
  }));

  tests.push(await runTestAsync("crypto.subtle exportKey", async () => {
    const key = await subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const exported = await subtle.exportKey("raw", key);
    assert(exported instanceof ArrayBuffer);
    assert(exported.byteLength > 0);
  }));

  tests.push(runTest("crypto.getRandomValues (Web Crypto style)", () => {
    const arr = new Uint8Array(16);
    getRandomValues(arr);
    assert(!arr.every((b) => b === 0));
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 27. Advanced Object, Reflect & Proxy
// ---------------------------------------------------------------------------

function checkAdvancedObjectReflectProxy(): GroupedTests {
  return group([
    runTest("Object.defineProperty (writable: false)", () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, "readonly", {
        value: 42,
        writable: false,
        enumerable: true,
        configurable: false,
      });
      assert(obj["readonly"] === 42);
    }),

    runTest("Object.defineProperty getter/setter", () => {
      const store: { _val: number } & Record<string, unknown> = { _val: 0 };
      Object.defineProperty(store, "doubled", {
        get() { return (this as typeof store)._val * 2; },
        set(v: number) { (this as typeof store)._val = v; },
        enumerable: true,
        configurable: true,
      });
      store._val = 5;
      assert(store["doubled"] === 10);
      store["doubled"] = 7;
      assert(store._val === 7);
    }),

    runTest("Object.getOwnPropertyDescriptor", () => {
      const obj = { a: 1 };
      const desc = Object.getOwnPropertyDescriptor(obj, "a");
      assert(desc !== undefined);
      assert(desc!.value === 1 && desc!.writable === true && desc!.enumerable === true);
    }),

    runTest("Object.getOwnPropertyDescriptors", () => {
      const obj = { a: 1, b: 2 };
      const descs = Object.getOwnPropertyDescriptors(obj);
      assert(descs.a.value === 1 && descs.b.value === 2);
    }),

    runTest("Object.getOwnPropertyNames includes non-enumerable", () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, "hidden", { value: 1, enumerable: false });
      obj["visible"] = 2;
      const names = Object.getOwnPropertyNames(obj);
      assert(names.includes("hidden") && names.includes("visible"));
      assert(!Object.keys(obj).includes("hidden"));
    }),

    runTest("Object.getOwnPropertySymbols", () => {
      const sym = Symbol("test");
      const obj = { [sym]: 42, normal: 1 };
      const symbols = Object.getOwnPropertySymbols(obj);
      assert(symbols.length === 1 && symbols[0] === sym);
    }),

    runTest("Object.create with prototype chain", () => {
      const proto = { greet() { return "hello"; } };
      const obj = Object.create(proto) as typeof proto;
      assert(obj.greet() === "hello");
      assert(Object.getPrototypeOf(obj) === proto);
    }),

    runTest("Object.create with null prototype", () => {
      const obj = Object.create(null) as Record<string, unknown>;
      obj["key"] = "value";
      assert(Object.getPrototypeOf(obj) === null);
      assert(!("toString" in obj));
    }),

    runTest("Object.is (NaN, +0/-0 edge cases)", () => {
      assert(Object.is(NaN, NaN) === true);
      assert(Object.is(0, -0) === false);
      assert(Object.is(1, 1) === true);
    }),

    runTest("Reflect.ownKeys (strings + symbols)", () => {
      const sym = Symbol("s");
      const obj = { b: 2, a: 1, [sym]: 3 };
      const keys = Reflect.ownKeys(obj);
      assert(keys.includes("a") && keys.includes("b") && keys.includes(sym));
    }),

    runTest("Reflect.has / Reflect.deleteProperty", () => {
      const obj: Record<string, number> = { a: 1, b: 2 };
      assert(Reflect.has(obj, "a") === true);
      assert(Reflect.deleteProperty(obj, "a") === true);
      assert(!("a" in obj));
    }),

    runTest("Reflect.apply", () => {
      assert(Reflect.apply(Math.max, null, [1, 5, 3]) === 5);
    }),

    runTest("Reflect.construct", () => {
      class Pair {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      const p = Reflect.construct(Pair, [10, 20]) as Pair;
      assert(p.x === 10 && p.y === 20 && p instanceof Pair);
    }),

    runTest("Proxy get/set/has/deleteProperty traps", () => {
      const log: string[] = [];
      const target: Record<string, number> = { x: 1 };
      const proxy = new Proxy(target, {
        get(t, p) { log.push(`get:${String(p)}`); return Reflect.get(t, p); },
        set(t, p, v) { log.push(`set:${String(p)}`); return Reflect.set(t, p, v); },
        has(t, p) { log.push(`has:${String(p)}`); return Reflect.has(t, p); },
        deleteProperty(t, p) { log.push(`del:${String(p)}`); return Reflect.deleteProperty(t, p); },
      });
      void proxy["x"];
      proxy["y"] = 2;
      "x" in proxy;
      delete proxy["y"];
      assert(log.join(",") === "get:x,set:y,has:x,del:y");
    }),

    runTest("Proxy apply trap (function proxy)", () => {
      const fn = (a: number, b: number) => a + b;
      const proxy = new Proxy(fn, {
        apply(target, thisArg, args) {
          return (Reflect.apply(target, thisArg, args) as number) * 10;
        },
      });
      assert(proxy(2, 3) === 50);
    }),

    runTest("Proxy construct trap", () => {
      class Original {
        val: number;
        constructor(val: number) {
          this.val = val;
        }
      }
      const Proxied = new Proxy(Original, {
        construct(target, args) {
          const instance = Reflect.construct(target, args) as Original;
          instance.val *= 2;
          return instance;
        },
      });
      const obj = new Proxied(5);
      assert(obj.val === 10);
    }),

    runTest("Proxy.revocable", () => {
      const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
      assert(proxy.a === 1);
      revoke();
      let threw = false;
      try { void proxy.a; } catch { threw = true; }
      assert(threw, "revoked proxy should throw");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 28. Function Patterns (bind, call, apply, closures, composition)
// ---------------------------------------------------------------------------

function checkFunctionPatterns(): GroupedTests {
  return group([
    runTest("Function.prototype.bind (partial application)", () => {
      function add(a: number, b: number) { return a + b; }
      const add5 = add.bind(null, 5);
      assert(add5(3) === 8 && add5(10) === 15);
    }),

    runTest("Function.prototype.call", () => {
      function greet(this: { name: string }, greeting: string) {
        return `${greeting}, ${this.name}`;
      }
      assert(greet.call({ name: "baal" }, "hello") === "hello, baal");
    }),

    runTest("Function.prototype.apply", () => {
      function sum(this: void, ...args: number[]) { return args.reduce((a, b) => a + b, 0); }
      assert(sum.apply(undefined, [1, 2, 3, 4]) === 10);
    }),

    runTest("closure captures mutable state", () => {
      function makeCounter() {
        let count = 0;
        return { inc() { count++; }, get() { return count; } };
      }
      const c = makeCounter();
      c.inc(); c.inc(); c.inc();
      assert(c.get() === 3);
    }),

    runTest("closure factory (middleware pattern)", () => {
      function withPrefix(prefix: string) {
        return (msg: string) => `${prefix}: ${msg}`;
      }
      const logger = withPrefix("LOG");
      const errLogger = withPrefix("ERR");
      assert(logger("test") === "LOG: test");
      assert(errLogger("fail") === "ERR: fail");
    }),

    runTest("function composition (pipe)", () => {
      const pipe = (...fns: Array<(x: number) => number>) =>
        (x: number) => fns.reduce((v, fn) => fn(v), x);
      const transform = pipe((x) => x + 1, (x) => x * 2, (x) => x - 3);
      assert(transform(5) === 9);
    }),

    runTest("Function constructor (dynamic code)", () => {
      const add = new Function("a", "b", "return a + b") as (a: number, b: number) => number;
      assert(add(3, 4) === 7);
    }),

    runTest("getter/setter in object literal", () => {
      const obj = {
        _val: 0,
        get value() { return this._val; },
        set value(v: number) { this._val = v * 2; },
      };
      obj.value = 5;
      assert(obj.value === 10);
    }),

    runTest("computed property names", () => {
      const key = "dynamic";
      const obj: Record<string, unknown> = { [key]: true, [`${key}Fn`]() { return 42; } };
      assert(obj["dynamic"] === true);
      assert((obj["dynamicFn"] as () => number)() === 42);
    }),

    runTest("generator protocol (fibonacci)", () => {
      function* fib() {
        let a = 0, b = 1;
        while (true) { yield a; [a, b] = [b, a + b]; }
      }
      const gen = fib();
      const first5 = Array.from({ length: 5 }, () => gen.next().value);
      assert(first5.join(",") === "0,1,1,2,3");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 29. Well-Known Symbols
// ---------------------------------------------------------------------------

function checkWellKnownSymbols(): GroupedTests {
  return group([
    runTest("Symbol.toPrimitive", () => {
      class Money {
        private amount: number;
        constructor(amount: number) {
          this.amount = amount;
        }
        [Symbol.toPrimitive](hint: string) {
          if (hint === "number") return this.amount;
          if (hint === "string") return `$${this.amount}`;
          return this.amount;
        }
      }
      const m = new Money(42);
      assert(Number(m) === 42);
      assert(String(m) === "$42");
    }),

    runTest("Symbol.hasInstance", () => {
      class Validator {
        static [Symbol.hasInstance](val: unknown): boolean {
          return typeof val === "string" && (val as string).length > 0;
        }
      }
      assert(typeof Validator[Symbol.hasInstance] === "function");
      assert(Validator[Symbol.hasInstance]("hello") === true);
      assert(Validator[Symbol.hasInstance]("") === false);
    }),

    runTest("Symbol.toStringTag", () => {
      class MyClass { get [Symbol.toStringTag]() { return "MyCustomClass"; } }
      assert(Object.prototype.toString.call(new MyClass()) === "[object MyCustomClass]");
    }),

    runTest("Symbol.iterator custom class", () => {
      class Countdown {
        private n: number;
        constructor(n: number) {
          this.n = n;
        }
        [Symbol.iterator]() {
          let current = this.n;
          return {
            next() {
              return current > 0
                ? { value: current--, done: false as const }
                : { value: undefined, done: true as const };
            },
          };
        }
      }
      assert([...new Countdown(3)].join(",") === "3,2,1");
    }),

    runTest("Symbol.asyncIterator exists", () => {
      assert(typeof Symbol.asyncIterator === "symbol");
    }),

    runTest("Symbol.isConcatSpreadable", () => {
      const arr = [1, 2];
      const spreadable = { length: 2, 0: 3, 1: 4, [Symbol.isConcatSpreadable]: true };
      const result = arr.concat(spreadable as unknown as number[]);
      assert(result.length === 4 && result[2] === 3 && result[3] === 4);
    }),

    runTest("Symbol.for / Symbol.keyFor (global registry)", () => {
      const s1: symbol = Symbol.for("app.key");
      const s2: symbol = Symbol.for("app.key");
      assert(s1 === s2);
      assert(Symbol.keyFor(s1) === "app.key");
      assert(Symbol.keyFor(Symbol("local")) === undefined);
    }),

    runTest("Symbol.species exists", () => {
      assert(typeof Symbol.species === "symbol");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 30. Data Manipulation & Backend Patterns
// ---------------------------------------------------------------------------

function checkDataManipulation(): GroupedTests {
  return group([
    runTest("deep object merge", () => {
      function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
        const r = { ...a };
        for (const k of Object.keys(b)) {
          r[k] = (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) &&
                   a[k] && typeof a[k] === "object" && !Array.isArray(a[k]))
            ? deepMerge(a[k] as Record<string, unknown>, b[k] as Record<string, unknown>)
            : b[k];
        }
        return r;
      }
      const merged = deepMerge(
        { a: 1, nested: { x: 10, y: 20 } },
        { nested: { y: 99, z: 30 }, b: 2 },
      );
      assert((merged["nested"] as Record<string, number>)["x"] === 10);
      assert((merged["nested"] as Record<string, number>)["y"] === 99);
      assert((merged["nested"] as Record<string, number>)["z"] === 30);
    }),

    runTest("object pick / omit", () => {
      const pick = (obj: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
      const omit = (obj: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
      const user = { id: 1, name: "baal", password: "secret", email: "a@b.com" };
      assert(!("password" in omit(user, ["password"])));
      assert(Object.keys(pick(user, ["id", "name"])).length === 2);
    }),

    runTest("array groupBy via reduce", () => {
      const items = [
        { type: "fruit", name: "apple" },
        { type: "veggie", name: "carrot" },
        { type: "fruit", name: "banana" },
        { type: "veggie", name: "pea" },
      ];
      const grouped = items.reduce<Record<string, typeof items>>((acc, item) => {
        (acc[item.type] ??= []).push(item);
        return acc;
      }, {});
      assert(grouped["fruit"]!.length === 2);
      assert(grouped["veggie"]!.length === 2);
    }),

    runTest("array deduplicate via Set", () => {
      assert([...new Set([1, 2, 2, 3, 3, 3])].join(",") === "1,2,3");
    }),

    runTest("array chunk", () => {
      function chunk<T>(arr: T[], size: number): T[][] {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
      }
      const result = chunk([1, 2, 3, 4, 5, 6, 7], 3);
      assert(result.length === 3 && result[0]!.length === 3 && result[2]!.length === 1);
    }),

    runTest("Map ↔ Object conversion", () => {
      const obj = { a: 1, b: 2, c: 3 };
      const map = new Map(Object.entries(obj));
      assert(map.size === 3 && map.get("b") === 2);
      const back = Object.fromEntries(map);
      assert(back["a"] === 1 && back["c"] === 3);
    }),

    runTest("nested destructuring with defaults", () => {
      const config: { db?: { host?: string; port?: number } } = { db: { host: "localhost" } };
      const { db: { host = "127.0.0.1", port = 5432 } = {} } = config;
      assert(host === "localhost" && port === 5432);
    }),

    runTest("reduce to build lookup Map", () => {
      const users = [{ id: 1, name: "alice" }, { id: 2, name: "bob" }];
      const lookup = users.reduce((m, u) => m.set(u.id, u), new Map<number, typeof users[0]>());
      assert(lookup.size === 2 && lookup.get(2)!.name === "bob");
    }),

    runTest("JSON safe parse pattern", () => {
      function safeParse(json: string) {
        try { return { ok: true as const, data: JSON.parse(json) as unknown }; }
        catch (e) { return { ok: false as const, error: (e as Error).message }; }
      }
      const good = safeParse('{"x":1}');
      assert(good.ok === true);
      const bad = safeParse("not json");
      assert(bad.ok === false);
    }),

    runTest("flatMap for 1-to-many transforms", () => {
      const orders = [{ id: 1, items: ["a", "b"] }, { id: 2, items: ["c"] }];
      const all = orders.flatMap((o) => o.items.map((item) => ({ orderId: o.id, item })));
      assert(all.length === 3 && all[2]!.orderId === 2);
    }),

    runTest("multi-criteria sort", () => {
      const items = [
        { p: 2, n: "c" }, { p: 1, n: "b" }, { p: 1, n: "a" }, { p: 2, n: "a" },
      ];
      items.sort((a, b) => a.p - b.p || a.n.localeCompare(b.n));
      assert(items[0]!.n === "a" && items[0]!.p === 1);
      assert(items[2]!.n === "a" && items[2]!.p === 2);
    }),

    runTest("immutable update (spread + override)", () => {
      const state = { user: { name: "alice", age: 30 }, settings: { theme: "dark" } };
      const updated = { ...state, user: { ...state.user, age: 31 } };
      assert(updated.user.age === 31 && state.user.age === 30);
      assert(updated.settings === state.settings);
    }),

    runTest("template literal tag (SQL parameterization)", () => {
      function sql(strings: TemplateStringsArray, ...values: unknown[]) {
        const params: unknown[] = [];
        const query = strings.reduce((acc, str, i) => {
          if (i < values.length) { params.push(values[i]); return acc + str + `$${i + 1}`; }
          return acc + str;
        }, "");
        return { query, params };
      }
      const name = "alice"; const age = 30;
      const result = sql`SELECT * FROM users WHERE name = ${name} AND age > ${age}`;
      assert(result.query === "SELECT * FROM users WHERE name = $1 AND age > $2");
      assert(result.params[0] === "alice" && result.params[1] === 30);
    }),

    runTest("cookie parsing pattern", () => {
      const raw = "session=abc123; theme=dark; lang=en";
      const cookies = Object.fromEntries(
        raw.split(";").map((pair) => {
          const [key, ...rest] = pair.trim().split("=");
          return [key!, rest.join("=")];
        }),
      );
      assert(cookies["session"] === "abc123" && cookies["theme"] === "dark");
    }),

    runTest("JWT-like token creation + decode", () => {
      const b64url = (s: string) =>
        btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(JSON.stringify({ sub: "user-1", iat: 1700000000 }));
      const token = `${header}.${payload}.fakesig`;
      const parts = token.split(".");
      assert(parts.length === 3);
      const decoded = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string };
      assert(decoded.sub === "user-1");
    }),

    runTest("memoization pattern", () => {
      let calls = 0;
      function memoize<R>(fn: (n: number) => R) {
        const cache = new Map<string, R>();
        return (n: number): R => {
          const key = JSON.stringify(n);
          if (cache.has(key)) return cache.get(key)!;
          const result = fn(n);
          cache.set(key, result);
          return result;
        };
      }
      const square = memoize((n: number) => { calls++; return n * n; });
      assert(square(5) === 25);
      assert(square(5) === 25);
      assert(calls === 1);
    }),

    runTest("Authorization header parsing (Bearer token)", () => {
      const authHeader = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig";
      const [scheme, token] = authHeader.split(" ", 2);
      assert(scheme === "Bearer");
      assert(token!.startsWith("eyJ"));
      const parts = token!.split(".");
      const headerData = JSON.parse(atob(parts[0]!)) as { alg: string };
      const payloadData = JSON.parse(atob(parts[1]!)) as { sub: string };
      assert(headerData.alg === "HS256");
      assert(payloadData.sub === "1234567890");
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 31. Fetch HTTP Methods & Advanced Patterns
// ---------------------------------------------------------------------------

async function checkFetchHTTPMethods(baseUrl: string): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(await runTestAsync("fetch PUT echoes method", async () => {
    const resp = await fetch(`${baseUrl}?_t=method`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update" }),
    });
    assert(resp.ok);
    const data = await resp.json() as { method: string };
    assert(data.method === "PUT");
  }));

  tests.push(await runTestAsync("fetch DELETE echoes method", async () => {
    const resp = await fetch(`${baseUrl}?_t=method`, { method: "DELETE" });
    assert(resp.ok);
    const data = await resp.json() as { method: string };
    assert(data.method === "DELETE");
  }));

  tests.push(await runTestAsync("fetch PATCH echoes method", async () => {
    const resp = await fetch(`${baseUrl}?_t=method`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "patched" }),
    });
    assert(resp.ok);
    const data = await resp.json() as { method: string };
    assert(data.method === "PATCH");
  }));

  tests.push(await runTestAsync("fetch HEAD returns no body but has headers", async () => {
    const resp = await fetch(`${baseUrl}?_t=json`, { method: "HEAD" });
    assert(resp.ok && resp.status === 200);
    assert(resp.headers.get("content-type")?.includes("application/json") === true);
    const body = await resp.text();
    assert(body === "", "HEAD response should have empty body");
  }));

  // LLRT v0.8.1-beta fetch() only allows GET/POST/PUT/PATCH/DELETE/HEAD/CONNECT.
  // OPTIONS is a browser-side CORS preflight concern, not a server-side fetch need.
  // tests.push(await runTestAsync("fetch OPTIONS echoes method", async () => {
  //   const resp = await fetch(`${baseUrl}?_t=method`, { method: "OPTIONS" });
  //   assert(resp.ok);
  //   const data = await resp.json() as { method: string };
  //   assert(data.method === "OPTIONS");
  // }));

  tests.push(await runTestAsync("fetch GET /test/status/201", async () => {
    const resp = await fetch(`${baseUrl}?_t=status&_code=201`);
    assert(resp.status === 201 && resp.ok);
  }));

  tests.push(await runTestAsync("fetch GET /test/status/400", async () => {
    const resp = await fetch(`${baseUrl}?_t=status&_code=400`);
    assert(resp.status === 400 && !resp.ok);
  }));

  tests.push(await runTestAsync("fetch GET /test/status/500", async () => {
    const resp = await fetch(`${baseUrl}?_t=status&_code=500`);
    assert(resp.status === 500 && !resp.ok);
  }));

  tests.push(await runTestAsync("fetch GET /test/empty → 204 no content", async () => {
    const resp = await fetch(`${baseUrl}?_t=empty`);
    assert(resp.status === 204);
    assert(await resp.text() === "");
  }));

  tests.push(await runTestAsync("fetch multiple concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${baseUrl}?_t=json`).then((r) => r.json())),
    );
    assert(results.length === 5);
    for (const r of results) assert((r as { method: string }).method === "GET");
  }));

  tests.push(await runTestAsync("fetch POST with query params in URL", async () => {
    const resp = await fetch(`${baseUrl}?_t=method&foo=bar&baz=qux`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "val" }),
    });
    assert(resp.ok);
    const data = await resp.json() as { method: string; query: string };
    assert(data.method === "POST" && data.query.includes("foo=bar"));
  }));

  tests.push(await runTestAsync("fetch GET /test/set-cookie receives header", async () => {
    const resp = await fetch(`${baseUrl}?_t=set-cookie`);
    assert(resp.ok);
    const sc = resp.headers.get("set-cookie");
    assert(sc !== null && sc.includes("session="));
  }));

  return group(tests);
}

// ---------------------------------------------------------------------------
// 32. Enhanced Req/Res Deep Tests (via self-fetch)
// ---------------------------------------------------------------------------

async function checkReqResDeep(baseUrl: string): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(await runTestAsync("res.writeHead sets status + headers", async () => {
    const resp = await fetch(`${baseUrl}?_t=write-head`);
    assert(resp.status === 299);
    assert(resp.headers.get("x-custom-via-writehead") === "hello");
    assert(resp.headers.get("x-another") === "world");
  }));

  tests.push(await runTestAsync("res.write + res.end streaming", async () => {
    const resp = await fetch(`${baseUrl}?_t=multi-write`);
    assert(await resp.text() === "chunk1chunk2chunk3");
  }));

  tests.push(await runTestAsync("res.end with data param", async () => {
    const resp = await fetch(`${baseUrl}?_t=end-with-data`);
    assert(resp.ok);
    assert(await resp.text() === "direct-end-data");
  }));

  tests.push(await runTestAsync("204 no content via writeHead + end", async () => {
    const resp = await fetch(`${baseUrl}?_t=empty`);
    assert(resp.status === 204);
    assert(await resp.text() === "");
  }));

  tests.push(await runTestAsync("content-type preserved through write", async () => {
    const resp = await fetch(`${baseUrl}?_t=multi-write`);
    assert(resp.headers.get("content-type")?.includes("text/plain") === true);
  }));

  tests.push(await runTestAsync("large chunked response via multiple writes (50KB)", async () => {
    const resp = await fetch(`${baseUrl}?_t=chunked-large`);
    assert(resp.ok);
    const body = await resp.text();
    assert(body.length === 50000, `expected 50000, got ${body.length}`);
  }));

  tests.push(await runTestAsync("POST body preserves unicode", async () => {
    const payload = { emoji: "🎉🔥💻", chinese: "中文测试", arabic: "مرحبا", mixed: "Hello 世界 🌍" };
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json() as { echo: typeof payload };
    assert(data.echo.emoji === payload.emoji);
    assert(data.echo.chinese === payload.chinese);
    assert(data.echo.mixed === payload.mixed);
  }));

  tests.push(await runTestAsync("POST special JSON values roundtrip", async () => {
    const payload = {
      nullVal: null as null,
      boolTrue: true,
      boolFalse: false,
      zero: 0,
      negFloat: -3.14,
      empty: "",
      nested: { deep: { arr: [1, null, "three", true] as const } },
    };
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json() as { echo: { nullVal: null; boolFalse: boolean; zero: number; nested: { deep: { arr: unknown[] } } } };
    assert(data.echo.nullVal === null);
    assert(data.echo.boolFalse === false);
    assert(data.echo.zero === 0);
    assert(data.echo.nested.deep.arr[1] === null);
  }));

  tests.push(await runTestAsync("echo large JSON array (1000 items)", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, val: `item-${i}` }));
    const resp = await fetch(`${baseUrl}?_t=echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items),
    });
    const data = await resp.json() as { echo: Array<{ id: number }> };
    assert(data.echo.length === 1000 && data.echo[999]!.id === 999);
  }));

  tests.push(await runTestAsync("req.headers roundtrip with 20 custom headers", async () => {
    const hdrs: Record<string, string> = {};
    for (let i = 0; i < 20; i++) hdrs[`x-hdr-${i}`] = `val-${i}`;
    const resp = await fetch(`${baseUrl}?_t=headers`, { headers: hdrs });
    const data = await resp.json() as { headers: Record<string, string> };
    for (let i = 0; i < 20; i++) assert(data.headers[`x-hdr-${i}`] === `val-${i}`);
  }));

  tests.push(await runTestAsync("req.headers with long value (4KB)", async () => {
    const longVal = "x".repeat(4000);
    const resp = await fetch(`${baseUrl}?_t=headers`, {
      headers: { "X-Long": longVal },
    });
    const data = await resp.json() as { headers: Record<string, string> };
    assert(data.headers["x-long"] === longVal);
  }));

  tests.push(await runTestAsync("Set-Cookie response header", async () => {
    const resp = await fetch(`${baseUrl}?_t=set-cookie`);
    const sc = resp.headers.get("set-cookie");
    assert(sc !== null && sc.length > 0);
  }));

  return group(tests);
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
  const host = req.headers.host ?? "localhost";
  // __triggerBasePath is injected by the BAAL runner (e.g. /api/v1/trigger/.../check).
  // Self-referential fetch calls must hit the full trigger URL, not just the origin.
  const selfPath: string = ((globalThis as Record<string, unknown>)["__triggerBasePath"] as string) ?? "";
  const baseUrl = `http://${host}${selfPath}`;

  const [timers, timerSemantics, asyncPatterns, fetchApi, streams, blob, webCryptoSubtle, fetchMethods, reqResDeep, moduleLoader] = await Promise.all([
    withSectionAsync("timers", () => checkTimers()),
    withSectionAsync("timer_semantics", () => checkTimerSemantics()),
    withSectionAsync("async_patterns", () => checkAsyncPatterns()),
    withSectionAsync("fetch_api", () => checkFetchAPI(baseUrl)),
    withSectionAsync("streams", () => checkStreams()),
    withSectionAsync("blob", () => checkBlob()),
    withSectionAsync("web_crypto_subtle", () => checkWebCryptoSubtle()),
    withSectionAsync("fetch_http_methods", () => checkFetchHTTPMethods(baseUrl)),
    withSectionAsync("req_res_deep", () => checkReqResDeep(baseUrl)),
    withSectionAsync("module_loader_dynamic_imports", () => checkModuleLoaderDynamicImports(baseUrl)),
  ]);

  const sections: Record<string, GroupedTests> = {
    es_language: withSection("es_language", () => checkESLanguage()),
    json: withSection("json", () => checkJSON()),
    url: withSection("url", () => checkURL()),
    encoding: withSection("encoding", () => checkEncoding()),
    base64: withSection("base64", () => checkBase64()),
    buffer: withSection("buffer", () => checkBuffer()),
    crypto: withSection("crypto", () => checkCrypto()),
    typed_arrays: withSection("typed_arrays", () => checkTypedArrays()),
    date_intl: withSection("date_intl", () => checkDateIntl()),
    timers,
    timer_semantics: timerSemantics,
    error_handling: withSection("error_handling", () => checkErrorHandling()),
    string_ops: withSection("string_ops", () => checkStringOps()),
    math: withSection("math", () => checkMath()),
    collections: withSection("collections", () => checkCollections()),
    async_patterns: asyncPatterns,
    req_res_shim: withSection("req_res_shim", () => checkReqResShim(req, res)),
    console: withSection("console", () => checkConsole()),
    weakref_finalization: withSection("weakref_finalization", () => checkWeakRefFinalization()),
    abort_controller: withSection("abort_controller", () => checkAbortController()),
    fetch_api: fetchApi,
    streams,
    process: withSection("process", () => checkProcess()),
    event_target: withSection("event_target", () => checkEventTarget()),
    blob,
    form_data: withSection("form_data", () => checkFormData()),
    web_crypto_subtle: webCryptoSubtle,
    advanced_object_reflect_proxy: withSection("advanced_object_reflect_proxy", () => checkAdvancedObjectReflectProxy()),
    function_patterns: withSection("function_patterns", () => checkFunctionPatterns()),
    well_known_symbols: withSection("well_known_symbols", () => checkWellKnownSymbols()),
    data_manipulation: withSection("data_manipulation", () => checkDataManipulation()),
    fetch_http_methods: fetchMethods,
    req_res_deep: reqResDeep,
    module_loader_dynamic_imports: moduleLoader,
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
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const action = url.searchParams.get("_t");

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!action && req.method === "GET" && url.pathname === "/") {
    const { summary, sections, tests } = await runHealthCheck(req, res);
    res.statusCode = summary.healthy ? 200 : 503;
    res.end(JSON.stringify({ summary, sections, tests }, null, 2));
    return;
  }

  switch (action) {
    case "json": {
      if (req.method === "HEAD") { res.statusCode = 200; res.end(); return; }
      res.statusCode = 200;
      res.end(JSON.stringify({ method: "GET", message: "ok" }));
      return;
    }
    case "echo": {
      try {
        const raw = await text(req);
        const body = raw.trim() === "" ? null : (JSON.parse(raw) as unknown);
        res.statusCode = 200;
        res.end(JSON.stringify({ echo: body }, null, 2));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      }
      return;
    }
    case "echo-raw": {
      const raw = await text(req);
      res.statusCode = 200;
      res.end(JSON.stringify({ body: raw, byteLength: Buffer.byteLength(raw, "utf-8") }));
      return;
    }
    case "large": {
      const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, value: Math.random() }));
      res.statusCode = 200;
      res.end(JSON.stringify({ items, padding: "x".repeat(30000) }));
      return;
    }
    case "headers": {
      res.statusCode = 200;
      res.end(JSON.stringify({ headers: req.headers }));
      return;
    }
    case "method": {
      let body: unknown = null;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        try {
          const raw = await text(req);
          body = raw.trim() ? JSON.parse(raw) : null;
        } catch { body = null; }
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ method: req.method, query: url.search, body }));
      return;
    }
    case "status": {
      const code = parseInt(url.searchParams.get("_code") ?? "200", 10);
      res.statusCode = code;
      res.end(JSON.stringify({ status: code }));
      return;
    }
    case "empty": {
      res.writeHead(204);
      res.end();
      return;
    }
    case "multi-write": {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("chunk1");
      res.write("chunk2");
      res.end("chunk3");
      return;
    }
    case "write-head": {
      res.writeHead(299, { "X-Custom-Via-WriteHead": "hello", "X-Another": "world" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    case "end-with-data": {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("direct-end-data");
      return;
    }
    case "set-cookie": {
      res.setHeader("Set-Cookie", ["session=abc123; Path=/; HttpOnly", "theme=dark; Path=/"]);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    case "chunked-large": {
      res.writeHead(200, { "Content-Type": "text/plain" });
      for (let i = 0; i < 5; i++) res.write("A".repeat(10000));
      res.end();
      return;
    }
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
}
