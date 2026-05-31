/**
 * Aggregate per-package `.last-report.<mode>.json` files into one terminal summary.
 *
 * Usage: node scripts/suite-packages-summary.mjs <platform|node> <suite> [...]
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lastReportPath } from "./suite-report.mjs";

/** @typedef {"node" | "platform"} SuiteRunMode */

/** @param {string} value */
function parseRunMode(value) {
  if (value === "node" || value === "platform") return /** @type {SuiteRunMode} */ (value);
  throw new Error(`invalid run mode: ${value} (expected node or platform)`);
}

/** @param {unknown} report */
function failedTestNames(report) {
  /** @type {string[]} */
  const names = [];
  const sections = report?.sections ?? {};
  for (const sec of Object.values(sections)) {
    for (const t of sec?.tests ?? []) {
      if (!t.pass) names.push(t.name);
    }
  }
  const flat = report?.tests;
  if (Array.isArray(flat) && Object.keys(sections).length === 0) {
    for (const t of flat) {
      if (!t.pass) names.push(t.name);
    }
  }
  return names;
}

/** @param {string} suite @param {SuiteRunMode} mode */
function loadSuiteReport(suite, mode) {
  const path = lastReportPath(suite, mode);
  if (!existsSync(path)) return { suite, path, report: null };
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    return { suite, path, report };
  } catch {
    return { suite, path, report: null };
  }
}

/** @param {string[]} suites @param {SuiteRunMode} mode */
export function formatPackagesSummary(suites, mode) {
  const rows = suites.map((suite) => loadSuiteReport(suite, mode));
  let suitesOk = 0;
  let suitesFail = 0;
  let suitesError = 0;
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  const lines = [];
  const label = mode === "node" ? "node" : "platform";

  for (const { suite, report } of rows) {
    if (!report?.summary) {
      suitesError += 1;
      lines.push(`  ERROR  ${suite.padEnd(18)} (no report)`);
      continue;
    }
    const s = report.summary;
    const passed = s.total_passed ?? 0;
    const total = s.total_tests ?? 0;
    const failed = s.total_failed ?? 0;
    totalTests += total;
    totalPassed += passed;
    totalFailed += failed;

    if (s.healthy === true) {
      suitesOk += 1;
      lines.push(`  PASS   ${suite.padEnd(18)} ${passed}/${total}`);
    } else {
      suitesFail += 1;
      lines.push(`  FAIL   ${suite.padEnd(18)} ${passed}/${total}`);
      for (const name of failedTestNames(report)) {
        lines.push(`         ✗ ${name}`);
      }
    }
  }

  const suiteCount = suites.length;
  const header = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Package summary (${label}) — ${suiteCount} suite(s): ${suitesOk} passed, ${suitesFail} failed, ${suitesError} error(s)`,
    `Tests: ${totalPassed}/${totalTests} passed, ${totalFailed} failed`,
    "",
    ...lines,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ];

  return {
    text: `${header.join("\n")}\n`,
    healthy: suitesFail === 0 && suitesError === 0,
    suitesOk,
    suitesFail,
    suitesError,
    totalTests,
    totalPassed,
    totalFailed,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modeArg = process.argv[2];
  const suites = process.argv.slice(3);
  if (!modeArg || suites.length === 0) {
    console.error("usage: node scripts/suite-packages-summary.mjs <platform|node> <suite> [...]");
    process.exit(1);
  }
  let mode;
  try {
    mode = parseRunMode(modeArg);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  const { text } = formatPackagesSummary(suites, mode);
  process.stdout.write(text);
}
