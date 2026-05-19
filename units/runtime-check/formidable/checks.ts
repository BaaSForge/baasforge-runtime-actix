import type { GroupedTests, TestResult } from "./lib/test-harness.js";
import { postMultipart } from "./lib/harness.js";
import {
  group,
  harnessJsonBody,
  responseText,
  runTestAsync,
} from "./lib/test-harness.js";

export async function runFormidableChecks(baseUrl: string): Promise<GroupedTests> {
  const tests: TestResult[] = [];

  tests.push(
    await runTestAsync("parse: promise multipart fields + file", async () => {
      const resp = await postMultipart(baseUrl, "parse-promise-multipart", (fd) => {
        fd.append("title", "hello");
        fd.append("upload", new Blob(["abc"], { type: "text/plain" }), "a.txt");
      });
      if (resp.status !== 200) throw new Error(responseText(resp.body));
      const b = harnessJsonBody(resp.body);
      const fields = b["fields"] as Record<string, string[]>;
      if (fields["title"]?.[0] !== "hello") throw new Error(JSON.stringify(b));
      const files = b["files"] as Record<string, unknown[]>;
      if (!files["upload"]?.[0]) throw new Error(JSON.stringify(b));
    }),
  );

  return group(tests);
}
