import type { IncomingMessage, ServerResponse } from "node:http";
import { PUBLIC_VALUE, doubleLocal } from "@units/test.common.common.export-from-local";

export type RequestBody = never;
export type ResponseBody = { value: number; doubled: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { value: PUBLIC_VALUE, doubled: doubleLocal(PUBLIC_VALUE) };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
