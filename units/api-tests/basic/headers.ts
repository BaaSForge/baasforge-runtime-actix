import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { received: Record<string, string> };
export type QueryParams = never;

/**
 * Echoes a subset of interesting request headers back to the caller.
 * Tests that custom headers sent by the client reach the unit unchanged.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const probeKeys = ["content-type", "x-test-header", "x-custom-value", "accept"];
  const received: Record<string, string> = {};
  for (const key of probeKeys) {
    const val = req.headers[key];
    if (typeof val === "string") {
      received[key] = val;
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received } satisfies ResponseBody));
}
