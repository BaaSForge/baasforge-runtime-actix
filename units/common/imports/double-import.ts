import type { IncomingMessage, ServerResponse } from "node:http";
import { FACTOR as LOGGER_FACTOR } from "@units/test.common.common.logger";
import { logFn } from "@units/test.common.common.logger";

export type RequestBody = never;
export type ResponseBody = { factor: number; hasLogFn: boolean };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = {
    factor: LOGGER_FACTOR,
    hasLogFn: typeof logFn === "function",
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
