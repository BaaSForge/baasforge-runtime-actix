import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

const WF = "test.wf.workflow.wf-offset" as const;

export type RequestBody = { n?: number };
export type ResponseBody = { result: number };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // defaults
  }
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { result: number }>({
    unitPath: WF,
    input: { n: body.n ?? 5 },
    opts: { timeoutMs: 120_000 },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result satisfies ResponseBody));
}
