import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TOKEN,
  VERSION,
  BETA_TOKEN,
  BETA_VERSION,
} from "@units/test.common.common.export-mixed-barrel";

export type RequestBody = never;
export type ResponseBody = {
  alphaToken: string;
  alphaVersion: number;
  betaToken: string;
  betaVersion: number;
};
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = {
    alphaToken: TOKEN,
    alphaVersion: VERSION,
    betaToken: BETA_TOKEN,
    betaVersion: BETA_VERSION,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
