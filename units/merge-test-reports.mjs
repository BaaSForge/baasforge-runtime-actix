#!/usr/bin/env node
import fs from "node:fs";

function objectMultiply(a, b) {
  if (a == null || typeof a !== "object" || Array.isArray(a)) return b ?? a;
  if (b == null || typeof b !== "object" || Array.isArray(b)) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const x = out[k];
    const y = b[k];
    if (
      x != null &&
      typeof x === "object" &&
      !Array.isArray(x) &&
      y != null &&
      typeof y === "object" &&
      !Array.isArray(y)
    ) {
      out[k] = objectMultiply(x, y);
    } else {
      out[k] = y;
    }
  }
  return out;
}

function merge(main, ws) {
  const ms = main.summary ?? {};
  const wsu = ws.summary ?? {};
  const mt = Array.isArray(main.tests) ? main.tests : [];
  const wt = Array.isArray(ws.tests) ? ws.tests : [];
  return {
    summary: {
      healthy: Boolean(ms.healthy && wsu.healthy),
      total_tests: (ms.total_tests ?? 0) + (wsu.total_tests ?? 0),
      total_passed: (ms.total_passed ?? 0) + (wsu.total_passed ?? 0),
      total_failed: (ms.total_failed ?? 0) + (wsu.total_failed ?? 0),
      total_skipped: (ms.total_skipped ?? 0) + (wsu.total_skipped ?? 0),
      sections: objectMultiply(ms.sections ?? {}, wsu.sections ?? {}),
    },
    sections: objectMultiply(main.sections ?? {}, ws.sections ?? {}),
    tests: mt.concat(wt),
  };
}

const [, , mainPath, wsPath, outPath] = process.argv;
if (!mainPath || !wsPath || !outPath) {
  process.stderr.write(
    "usage: merge-test-reports.mjs <main-report.json> <ws-report.json> <out.json>\n",
  );
  process.exit(1);
}

const main = JSON.parse(fs.readFileSync(mainPath, "utf8"));
const ws = JSON.parse(fs.readFileSync(wsPath, "utf8"));
fs.writeFileSync(outPath, JSON.stringify(merge(main, ws), null, 2) + "\n");
