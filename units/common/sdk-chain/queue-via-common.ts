import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { enqueueViaCommon } from "@units/test.common.common.sdk-bridge-queue";

export type RequestBody = { data?: Record<string, unknown> };
export type ResponseBody = { runId: string };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // defaults
  }
  const { runId } = enqueueViaCommon(body.data ?? { viaCommon: true });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runId: String(runId) } satisfies ResponseBody));
}
