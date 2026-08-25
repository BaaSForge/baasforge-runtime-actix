//! API-unit JS fixtures for the cold-start bench and proof runs.

pub const HELLO: &str = r#"
export function handleRequest(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
"#;

pub const ZOD_ONLY: &str = r#"
import { z } from "zod";
export function handleRequest(req, res) {
  const schema = z.object({ ok: z.literal(true) });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(schema.parse({ ok: true })));
}
"#;

pub const JOSE_ONLY: &str = r#"
import { SignJWT } from "jose";
export async function handleRequest(req, res) {
  const secret = new TextEncoder().encode("baal-cold-start-bench-secret-key!!");
  const token = await new SignJWT({ sub: "bench" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(secret);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ tokenLen: token.length }));
}
"#;

pub const LODASH_ES: &str = r#"
import { get, uniq } from "lodash-es";
export function handleRequest(req, res) {
  const value = get({ a: { b: [1, 1, 2] } }, "a.b");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ n: uniq(value).length }));
}
"#;

pub const HEAVY: &str = r#"
import { z } from "zod";
import { SignJWT } from "jose";
import { get } from "lodash-es";
export async function handleRequest(req, res) {
  const schema = z.object({ n: z.number() });
  const n = schema.parse({ n: get({ n: 1 }, "n") }).n;
  const secret = new TextEncoder().encode("baal-cold-start-bench-secret-key!!");
  const token = await new SignJWT({ n })
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ n, tokenLen: token.length }));
}
"#;

pub const POLLUTE: &str = r#"
export function handleRequest(req, res) {
  Object.prototype.__baal_pwned = "yes";
  globalThis.__baal_secret = "s3cret";
  try { setTimeout(() => { globalThis.__baal_fired = true; }, 60000); } catch (e) {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ polluted: true }));
}
"#;

pub const OBSERVE: &str = r#"
export function handleRequest(req, res) {
  const proto = String(Object.prototype.__baal_pwned || "clean");
  const secret = String(globalThis.__baal_secret || "clean");
  const fired = String(globalThis.__baal_fired || "clean");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ proto, secret, fired }));
}
"#;

pub fn source(name: &str) -> Option<&'static str> {
    match name {
        "hello" => Some(HELLO),
        "zod-only" | "zod" => Some(ZOD_ONLY),
        "jose-only" | "jose" => Some(JOSE_ONLY),
        "lodash-es" | "lodash" => Some(LODASH_ES),
        "heavy" => Some(HEAVY),
        "pollute" => Some(POLLUTE),
        "observe" => Some(OBSERVE),
        _ => None,
    }
}

pub fn all_names() -> &'static [&'static str] {
    &["hello", "zod-only", "jose-only", "lodash-es", "heavy"]
}
