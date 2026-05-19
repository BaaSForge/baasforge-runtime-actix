declare module "@units/test.common.common.http-json" {
  import type { ServerResponse } from "node:http";
  import type { File } from "formidable";

  export function sendJson(res: ServerResponse, status: number, body: unknown): void;

  export function summarizeFile(file: File): Record<string, unknown>;

  export function summarizeFiles(
    files: Record<string, File[] | undefined>,
  ): Record<string, Record<string, unknown>[]>;
}
