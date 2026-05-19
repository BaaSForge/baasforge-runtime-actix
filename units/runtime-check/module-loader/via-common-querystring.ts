// @ts-nocheck
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseA1 } from "@units/test.common.common.querystring-helper";

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseA1();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
