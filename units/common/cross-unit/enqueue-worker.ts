/** Cross-unit harness: SDK → queue worker (see `companion-queue-workers/noop.ts`). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { data?: Record<string, unknown> };
export type ResponseBody = { runId: string };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // use defaults
  }

  const jobData: Record<string, unknown> = body.data ?? {};

  const { runId } = sdk.enqueueWorkerSync<Record<string, unknown>>({
    unitPath: "test.queue-worker.queue_worker.noop",
    data: jobData,
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runId: String(runId) } satisfies ResponseBody));
}
