import type { IncomingMessage, ServerResponse } from "node:http";
import { FACTOR as LOGGER_FACTOR } from "@units/test.common.common.logger";
import { FACTOR as SUMMER_FACTOR, sharedSum } from "@units/test.common.common.summer";

export type RequestBody = never;
export type ResponseBody = {
  loggerFactor: number;
  summerFactor: number;
  sum: number;
};
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = {
    loggerFactor: LOGGER_FACTOR,
    summerFactor: SUMMER_FACTOR,
    sum: sharedSum(1, 2),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
