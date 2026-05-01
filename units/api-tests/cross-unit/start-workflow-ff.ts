import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { value?: unknown };
export type ResponseBody = { instanceId: string };
export type QueryParams = never;

/**
 * Starts the companion `echo` workflow fire-and-forget via
 * `sdk.startWorkflowSync`.
 *
 * Returns `{ instanceId }` immediately; the workflow runs in the background.
 * Use this to verify that `startWorkflowSync` is accepted without blocking.
 *
 * Request body:
 *   value — arbitrary payload forwarded to the workflow (default: null)
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

    const { instanceId } = sdk.startWorkflowSync<{ value: unknown }>({
      unitPath: "test.wf.workflow.wf-echo",
      input: { value: body.value ?? null },
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ instanceId: String(instanceId) } satisfies ResponseBody));
  })();
}
