// @ts-nocheck
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  void readFileSync;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
