/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers API → workflow fire-and-forget: `sdk.startWorkflowSync` returning `instanceId` without blocking on workflow completion.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk } from "@sdk";

export type RequestBody = { value?: unknown };
export type ResponseBody = { instanceId: string };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
}
