/**
 * `jose` npm package test runner (`test.runtime.api.jose`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, jwtVerify } from "jose";
import { SignJWT as SignJWTSub } from "jose/jwt/sign";
import { jwtVerify as jwtVerifySub } from "jose/jwt/verify";
import { decodeJwt } from "jose/jwt/decode";
import { createRemoteJWKSet } from "jose/jwks/remote";
import { importJWK } from "jose/key/import";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const HS_SECRET = new TextEncoder().encode("test-secret-key-32bytes-long!!");

const TESTS: SuiteTest[] = [
  {
    name: "SignJWT + jwtVerify: HS256 (root import)",
    run: async () => {
      const token = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .sign(HS_SECRET);
      const { payload } = await jwtVerify(token, HS_SECRET);
      if (payload.sub !== "user-1") throw new Error(JSON.stringify(payload));
    },
  },
  {
    name: "jose/jwt/sign + jose/jwt/verify: subpath imports",
    run: async () => {
      const token = await new SignJWTSub({ sub: "user-2" })
        .setProtectedHeader({ alg: "HS256" })
        .sign(HS_SECRET);
      const { payload } = await jwtVerifySub(token, HS_SECRET);
      if (payload.sub !== "user-2") throw new Error(JSON.stringify(payload));
    },
  },
  {
    name: "jose/jwt/decode: payload without verify",
    run: async () => {
      const token = await new SignJWT({ sub: "decode-me" })
        .setProtectedHeader({ alg: "HS256" })
        .sign(HS_SECRET);
      const payload = decodeJwt(token);
      if (payload.sub !== "decode-me") throw new Error(JSON.stringify(payload));
    },
  },
  {
    name: "jose/key/import: import symmetric JWK",
    run: async () => {
      const jwk = {
        kty: "oct",
        k: "dGVzdC1zZWNyZXQta2V5LTMyYnl0ZXMtbG9uZyEh",
        alg: "HS256",
      };
      const key = await importJWK(jwk, "HS256");
      const token = await new SignJWT({ ok: true }).setProtectedHeader({ alg: "HS256" }).sign(key);
      const { payload } = await jwtVerify(token, key);
      if (payload["ok"] !== true) throw new Error(JSON.stringify(payload));
    },
  },
  {
    name: "jose/jwks/remote: factory is a function",
    run: async () => {
      const jwks = createRemoteJWKSet(new URL("https://example.com/.well-known/jwks.json"));
      if (typeof jwks !== "function") throw new Error(`expected function, got ${typeof jwks}`);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "jose", () => runSuiteTests(TESTS));
}
