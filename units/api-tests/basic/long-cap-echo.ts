import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

export type RequestBody = Record<string, unknown>;
export type ResponseBody = { echoed: Record<string, unknown>; method: string };
export type QueryParams = never;

/** Same behaviour as `echo`; row metadata has `timeout_seconds: 120` for e2e routing. */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const raw = await text(req);
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
    }
    const responseBody: ResponseBody = {
      echoed: body,
      method: req.method ?? "UNKNOWN",
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
  })();
}
