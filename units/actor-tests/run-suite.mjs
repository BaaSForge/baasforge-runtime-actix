#!/usr/bin/env node
/**
 * Actor integration test suite — runs in Node (not QuickJS).
 *
 * Per-test timeouts use AbortSignal; the in-server QuickJS runner cannot
 * interrupt self-referencing fetch() and will hang under load.
 *
 * Usage (called by test.sh):
 *   node run-suite.mjs http://127.0.0.1:3335 /path/to/output.json
 */

import { writeFileSync } from "node:fs";
import { runActorTestSuite } from "./dist/index.js";

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22) {
  process.stderr.write(
    `ERROR: run-suite.mjs requires Node.js >= 22 (current: ${process.version}).\n`,
  );
  process.exit(1);
}

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3335";
const outPath = process.argv[3];

function suiteTimeoutMs() {
  const raw = process.env["TEST_TIMEOUT"];
  const sec = raw === undefined || raw === "" ? 600 : Math.floor(Number(raw));
  return (Number.isFinite(sec) && sec > 0 ? sec : 600) * 1000;
}

function printFailures(report) {
  for (const sec of Object.values(report.sections ?? {})) {
    for (const t of sec.tests ?? []) {
      if (!t.pass) {
        process.stderr.write(`  ${t.error ?? t.detail ?? t.name} [${t.name}]\n`);
      }
    }
  }
}

async function main() {
  const maxMs = suiteTimeoutMs();
  process.stderr.write(
    `==> Actor suite (Node): ${baseUrl} (suite cap ${maxMs}ms, per-test ${process.env["ACTOR_TEST_TIMEOUT_MS"] ?? "120000"}ms)\n`,
  );

  let report;
  let timedOut;
  try {
    ({ report, timedOut } = await Promise.race([
      runActorTestSuite(baseUrl),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`suite timeout after ${maxMs}ms`)), maxMs);
      }),
    ]));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`ERROR: ${msg}\n`);
    process.exit(1);
  }

  const json = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);

  if (timedOut.length > 0) {
    process.stderr.write(`ERROR: ${timedOut.length} test(s) timed out:\n`);
    for (const t of timedOut) process.stderr.write(`  - ${t}\n`);
    process.exit(1);
  }

  if (!report.summary?.healthy) {
    process.stderr.write(
      `ERROR: actor tests unhealthy (${report.summary?.total_failed ?? "?"} failed)\n`,
    );
    printFailures(report);
    process.exit(1);
  }
}

main();
