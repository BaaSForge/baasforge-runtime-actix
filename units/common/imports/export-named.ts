import type { IncomingMessage, ServerResponse } from "node:http";
import { TOKEN, VERSION } from "@units/test.common.common.export-named-alpha";

export type RequestBody = never;
export type ResponseBody = { token: string; version: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { token: TOKEN, version: VERSION };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
