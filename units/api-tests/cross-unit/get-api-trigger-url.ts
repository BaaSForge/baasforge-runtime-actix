import type { IncomingMessage, ServerResponse } from "node:http";
import { sdk } from "@sdk";

export type RequestBody = never;
export type ResponseBody = { url: string };
export type QueryParams = never;

/**
 * Returns the trigger URL the SDK builds for the `echo` API unit.
 *
 * When this unit runs in the **production** runtime, `sdk.getApiUnitTriggerUrl`
 * returns a bare production URL (no `/stage/` segment).
 *
 * When it runs in a **stage** runtime, the SDK injects the runtime's id:
 *   `.../stage/{runtimeId}/test/api-tests/echo`
 *
 * This unit is used to verify that the SDK is runtime-context-aware and
 * never mixes production and stage trigger URLs.
 */
export function handleRequest(_req: IncomingMessage, res: ServerResponse): void {
  const url = sdk.getApiUnitTriggerUrl({ unitPathOrId: "test.api-tests.api.echo" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ url } satisfies ResponseBody));
}
