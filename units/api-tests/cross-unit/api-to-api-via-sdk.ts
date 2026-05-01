/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers API → API: `sdk.getApiUnitTriggerUrl` (runtime-scoped URL) plus `fetch` to another unit; `async handleRequest` so the platform awaits the sub-request.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sdk } from "@sdk";

export type RequestBody = never;
export type ResponseBody = { url: string; echoed: Record<string, unknown> };
export type QueryParams = never;

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
