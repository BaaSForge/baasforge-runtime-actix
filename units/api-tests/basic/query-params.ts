/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers Typed `QueryParams`, building `URL` from `req.url`, iterating `searchParams`, GET handler with no body.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { params: Record<string, string> };
export type QueryParams = { [key: string]: string };

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ params } satisfies ResponseBody));
}
