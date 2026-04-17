#!/usr/bin/env node
import fs from "node:fs";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: report-summary-line.mjs <report.json>\n");
  process.exit(1);
}

const r = JSON.parse(fs.readFileSync(path, "utf8"));
const s = r.summary ?? {};
const p = s.total_passed ?? 0;
const k = s.total_skipped ?? 0;
const f = s.total_failed ?? 0;
const t = s.total_tests ?? 0;
process.stdout.write(`${p} passed, ${k} skipped, ${f} failed (${t} tests)\n`);
