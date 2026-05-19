// @ts-nocheck
import type { IncomingMessage, ServerResponse } from "node:http";

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parse("a=1");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
