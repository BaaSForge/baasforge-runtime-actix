import type { IncomingMessage, ServerResponse } from "node:http";
import { sdk } from "@sdk";

export type RequestBody = never;
export type ResponseBody = { url: string; echoed: Record<string, unknown> };
export type QueryParams = never;

/**
 * Demonstrates API-to-API communication using `sdk.getApiUnitTriggerUrl`.
 *
 * 1. Calls `sdk.getApiUnitTriggerUrl` to resolve the trigger URL of the
 *    `echo` API unit (automatically stage-scoped if this unit is in a stage
 *    runtime).
 * 2. Sends `{ via: "sdk-url" }` to that URL via `fetch`.
 * 3. Returns the resolved URL and the echoed payload.
 *
 * Declared `async` so the platform properly awaits the fetch round-trip
 * before capturing the response snapshot.
 */
export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = sdk.getApiUnitTriggerUrl({ unitPathOrId: "test.api-tests.api.echo" });

  const echoResp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ via: "sdk-url" }),
  });

  const echoBody = await echoResp.json() as Record<string, unknown>;
  const echoed = (echoBody["echoed"] as Record<string, unknown> | undefined) ?? {};

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ url, echoed } satisfies ResponseBody));
}
