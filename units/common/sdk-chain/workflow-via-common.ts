import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { echoViaCommon } from "@units/test.common.common.sdk-bridge-workflow";

export type RequestBody = { value?: unknown };
export type ResponseBody = { echoed: unknown };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // defaults
  }
  const output = echoViaCommon(body.value ?? "via-common");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(output satisfies ResponseBody));
}
