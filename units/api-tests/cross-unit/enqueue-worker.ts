import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { data?: Record<string, unknown> };
export type ResponseBody = { runId: string };
export type QueryParams = never;

/**
 * Enqueues a job on the companion `noop` queue worker via
 * `sdk.enqueueWorkerSync`.
 *
 * Returns `{ runId }` as soon as the platform accepts the job.
 * The job itself runs asynchronously in the background.
 *
 * Request body:
 *   data — arbitrary job data forwarded to the worker (default: {})
 */
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
