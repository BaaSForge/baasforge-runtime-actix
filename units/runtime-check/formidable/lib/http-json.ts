import type { ServerResponse } from "node:http";
import type { File } from "formidable";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function summarizeFile(file: File): Record<string, unknown> {
  return {
    ...file.toJSON(),
    toString: file.toString(),
  };
}

export function summarizeFiles(
  files: Record<string, File[] | undefined>,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [key, list] of Object.entries(files)) {
    if (!list) continue;
    out[key] = list.map((f) => summarizeFile(f));
  }
  return out;
}
