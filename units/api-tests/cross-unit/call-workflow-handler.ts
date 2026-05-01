/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers API → workflow shared handlers: `startWorkflowSync` then `callWorkflowHandlerAndWaitForResultSync` twice on the same `WorkflowInstanceId`.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk, type WorkflowInstanceId } from "@sdk";

const WF = "test.wf.workflow.wf-handler-gate" as const;

export type RequestBody = { msg?: string };
export type ResponseBody = {
  instanceId: string;
  handlerEcho: { echoed: string };
  handlerFinish: { closed: boolean };
};
export type QueryParams = never;

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const raw = await text(req);
    let body: RequestBody = {};
    try {
      body = JSON.parse(raw) as RequestBody;
    } catch {
      // defaults
    }

    const { instanceId } = sdk.startWorkflowSync<Record<string, never>>({
      unitPath: WF,
      input: {},
    });

    const handlerEcho = sdk.callWorkflowHandlerAndWaitForResultSync<
      { msg?: string },
      { echoed: string }
    >({
      unitPath: WF,
      instanceId: instanceId as WorkflowInstanceId,
      handler: "echo",
      input: { msg: body.msg ?? "api-handler-default" },
      opts: { timeoutMs: 30_000 },
    });

    const handlerFinish = sdk.callWorkflowHandlerAndWaitForResultSync<
      Record<string, never>,
      { closed: boolean }
    >({
      unitPath: WF,
      instanceId: instanceId as WorkflowInstanceId,
      handler: "finish",
      input: {},
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        instanceId: String(instanceId),
        handlerEcho,
        handlerFinish,
      } satisfies ResponseBody),
    );
  })();
}
