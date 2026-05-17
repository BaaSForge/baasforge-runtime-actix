import type { IncomingMessage, ServerResponse } from "node:http";
import { INLINE_LABEL, joinLabels } from "@units/test.common.common.export-inline";

export type RequestBody = never;
export type ResponseBody = { label: string; joined: string };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = {
    label: INLINE_LABEL,
    joined: joinLabels("x", "y"),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
