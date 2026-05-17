import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

const WORKER = "test.queue-worker.queue_worker.offset-job" as const;

export type RequestBody = { n?: number };
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
  const result = sdk.enqueueWorkerSync<{ n: number }>({
    unitPath: WORKER,
    data: { n: body.n ?? 3 },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runId: String(result.runId) } satisfies ResponseBody));
}
