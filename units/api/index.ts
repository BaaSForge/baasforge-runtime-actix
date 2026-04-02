/**
 * HTTP request handler (demos: cookies, headers, URL, query, JSON, status).
 * Run: `npm run build` then `node dist/server.js` (Node.js 22.x).
 *
 * Uses only Node core + ECMAScript builtins (no extra deps). Emit is ES2022 for
 * engines like QuickJS that implement modern syntax; Node builtins still
 * require Node (or a compatible host) to execute.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseQuerystring } from "node:querystring";
import { text } from "node:stream/consumers";
import { URL } from "node:url";

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host;
  const base = `http://${host}`;
  const url = new URL(req.url ?? "/", base);

  // --- Demo endpoint: GET / — shows URL, query, cookies, headers; sets/removes outgoing headers & cookies
  if (req.method === "GET" && url.pathname === "/") {
    res.statusCode = 200;

    res.setHeader("X-Demo-Custom", "set-via-setHeader");
    res.setHeader("X-Demo-Custom", "modified-value");

    res.setHeader("X-Removed-In-Demo", "this-will-not-appear");
    res.removeHeader("X-Removed-In-Demo");

    const setCookieParts = [
      "session=demo-session-id; Path=/; HttpOnly; SameSite=Lax",
      "prefs=theme%3Ddark; Path=/; Max-Age=3600",
    ];
    res.setHeader("Set-Cookie", setCookieParts);

    res.appendHeader("Set-Cookie", "old_cookie=; Path=/; Max-Age=0");

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const cookieHeader = req.headers.cookie ?? "";
    // Cookie pairs are semicolon-separated; `node:querystring` parses them (Node core).
    const cookies = parseQuerystring(cookieHeader, "; ", "=");

    const payload = {
      demo: "single GET / bundles the examples below",

      requestUrl: req.url,

      href: url.href,
      pathname: url.pathname,

      query: Object.fromEntries(url.searchParams.entries()),
      queryEntries: [...url.searchParams.entries()],

      cookies,
      rawCookieHeader: req.headers.cookie ?? null,

      headers: req.headers,

      rawHeaderPairs: (() => {
        const out: { name: string; value: string }[] = [];
        const rh = req.rawHeaders;
        for (let i = 0; i < rh.length; i += 2) {
          out.push({ name: rh[i]!, value: rh[i + 1]! });
        }
        return out;
      })(),
    };

    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/") {
    try {
      const raw = await text(req);
      const body =
        raw.trim() === "" ? null : (JSON.parse(raw) as unknown);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify(
          {
            message: "parsed JSON body",
            received: body,
          },
          null,
          2,
        ),
      );
    } catch (_e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid JSON body" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/error-demo") {
    res.statusCode = 418;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "I'm a teapot", status: 418 }));
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      hint: "Try GET /, POST / with Content-Type: application/json, or GET /error-demo",
    }),
  );
}
