/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers API → queue worker: `sdk.enqueueWorkerSync` returning `runId` while the job runs asynchronously.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { data?: Record<string, unknown> };
export type ResponseBody = { runId: string };
export type QueryParams = never;

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
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
  })();
}
