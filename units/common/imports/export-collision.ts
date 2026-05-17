import type { IncomingMessage, ServerResponse } from "node:http";
import { TOKEN as ALPHA_TOKEN, VERSION as ALPHA_VERSION } from "@units/test.common.common.pkg-alpha";
import { TOKEN as BETA_TOKEN, VERSION as BETA_VERSION } from "@units/test.common.common.pkg-beta";

export type RequestBody = never;
export type ResponseBody = {
  alphaToken: string;
  betaToken: string;
  alphaVersion: number;
  betaVersion: number;
};
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = {
    alphaToken: ALPHA_TOKEN,
    betaToken: BETA_TOKEN,
    alphaVersion: ALPHA_VERSION,
    betaVersion: BETA_VERSION,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
