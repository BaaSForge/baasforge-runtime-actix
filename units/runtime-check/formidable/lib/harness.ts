import { TEST_PROJECT_ID } from "./test-harness.js";

export function formidableHarnessUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/${TEST_PROJECT_ID}/test/common/${slug}`;
}

async function postHarness(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, { method: "POST", ...init });
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

export async function postMultipart(
  baseUrl: string,
  slug: string,
  build: (fd: FormData) => void,
): Promise<{ status: number; body: unknown }> {
  const fd = new FormData();
  build(fd);
  return postHarness(formidableHarnessUrl(baseUrl, slug), { body: fd });
}
