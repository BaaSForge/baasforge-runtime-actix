// @ts-nocheck
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const length = Buffer.from("ab").length;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, length }));
}
