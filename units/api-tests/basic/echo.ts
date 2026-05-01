/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers JSON POST body: `text` from `node:stream/consumers`, JSON.parse with fallback, typed `RequestBody`/`ResponseBody`, `void (async () => { ... })()` around async body read before `res.end`.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

export type RequestBody = Record<string, unknown>;
export type ResponseBody = { echoed: Record<string, unknown>; method: string };
export type QueryParams = never;

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
    const json = JSON.stringify(responseBody);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(json);
  })();
}
