import type { IncomingMessage, ServerResponse } from "node:http";
import { SIZE, isLarge } from "@units/test.common.common.export-type-value";

export type RequestBody = never;
export type ResponseBody = { size: string; large: boolean };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { size: SIZE, large: isLarge(SIZE) };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
