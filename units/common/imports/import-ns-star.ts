import type { IncomingMessage, ServerResponse } from "node:http";
import * as AlphaPkg from "@units/test.common.common.pkg-alpha";

export type RequestBody = never;
export type ResponseBody = { token: string; version: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { token: AlphaPkg.TOKEN, version: AlphaPkg.VERSION };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
