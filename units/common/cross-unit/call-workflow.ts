/** Cross-unit harness: SDK → workflow (see `companion-workflows/wf-echo.ts`). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { value?: unknown };
export type ResponseBody = { echoed: unknown };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    opts: { timeoutMs: 120_000 },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(output satisfies ResponseBody));
}
