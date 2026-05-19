import type { IncomingMessage, ServerResponse } from "node:http";
import formidable from "formidable";
import { sendJson, summarizeFiles } from "@units/test.common.common.http-json";

export type RequestBody = never;
export type ResponseBody = {
  fields: Record<string, string[] | undefined>;
  files: Record<string, Record<string, unknown>[]>;
};
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = formidable({ multiples: false });
  const [fields, files] = await form.parse(req);
  sendJson(res, 200, {
    fields,
    files: summarizeFiles(files),
  } satisfies ResponseBody);
}
