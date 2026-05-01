import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { value?: unknown };
export type ResponseBody = { echoed: unknown };
export type QueryParams = never;

/**
 * Calls the companion `echo` workflow and waits for its output via
 * `sdk.callWorkflowAndWaitForOutputSync`.
 *
 * The echo workflow immediately returns `{ echoed: input.value }` without
 * sleeping or waiting for signals, so this call is safe from an API unit
 * (no indefinite blocking).
 *
 * Request body:
 *   value — value to pass through the workflow (default: null)
 *
 * Returns `{ echoed: <value> }` — the workflow's output.
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

    const output = sdk.callWorkflowAndWaitForOutputSync<{ value: unknown }, { echoed: unknown }>({
      unitPath: "test.wf.workflow.wf-echo",
      input: { value: body.value ?? null },
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(output satisfies ResponseBody));
  })();
}
