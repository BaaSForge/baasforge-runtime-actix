/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers Non-JSON HTTP response: `writeHead` with `Content-Disposition` attachment, custom metadata header, plain text payload (download-style GET).
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { kind: "attachment"; name: string; lines: number };
export type QueryParams = never;

export function handleRequest(_req: IncomingMessage, res: ServerResponse): void {
  const payload = "alpha\nbeta\ngamma\n";
  const snapshot: ResponseBody = { kind: "attachment", name: "sample-lines.txt", lines: 3 };
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": 'attachment; filename="sample-lines.txt"',
    "X-Test-Download-Meta": JSON.stringify(snapshot),
  });
  res.end(payload);
}
