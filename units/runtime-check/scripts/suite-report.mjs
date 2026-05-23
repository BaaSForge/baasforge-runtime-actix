/**
 * Format runtime-check library suite JSON reports for the terminal.
 * Saves pretty JSON to `packages/<suite>/.last-report.<mode>.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeCheckRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(runtimeCheckRoot, "packages");

/** @typedef {"node" | "platform"} SuiteRunMode */

export function suiteDir(suite) {
  return join(packagesRoot, suite);
}

/** @param {SuiteRunMode} mode */
export function lastReportPath(suite, mode) {
  return join(suiteDir(suite), `.last-report.${mode}.json`);
}

/** @param {SuiteRunMode} mode */
export function lastTerminalPath(suite, mode) {
  return join(suiteDir(suite), `.last-terminal.${mode}.txt`);
}

export function prettyJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** @param {SuiteRunMode} mode */
export function saveLastReport(suite, report, mode) {
  const path = lastReportPath(suite, mode);
  writeFileSync(path, prettyJson(report), "utf8");
  return path;
}

export function formatReportText(suite, report) {
  const lines = [];
  const summary = report?.summary;
  const healthy = summary?.healthy === true;
  const passed = summary?.total_passed ?? "?";
  const total = summary?.total_tests ?? "?";
  const failed = summary?.total_failed ?? "?";

  lines.push(`=== ${suite} ===`);
  lines.push(`Status: ${healthy ? "healthy" : "FAILED"}`);
  lines.push(`Tests:  ${passed}/${total} passed, ${failed} failed`);
  lines.push("");

  const sections = report?.sections ?? {};
  for (const [sectionName, section] of Object.entries(sections)) {
    const tests = section?.tests ?? [];
    if (tests.length === 0) continue;
    lines.push(`[${sectionName}]`);
    for (const t of tests) {
      const mark = t.pass ? "PASS" : "FAIL";
      lines.push(`  ${mark}  ${t.name}`);
      if (t.detail) lines.push(`        ${t.detail}`);
      if (t.error) lines.push(`        ${t.error}`);
    }
    lines.push("");
  }

  const flat = report?.tests;
  if (Array.isArray(flat) && flat.length > 0 && Object.keys(sections).length === 0) {
    lines.push("[tests]");
    for (const t of flat) {
      const mark = t.pass ? "PASS" : "FAIL";
      lines.push(`  ${mark}  ${t.name}`);
      if (t.detail) lines.push(`        ${t.detail}`);
      if (t.error) lines.push(`        ${t.error}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function isHealthy(report) {
  return report?.summary?.healthy === true;
}

/** @param {SuiteRunMode} mode */
export function presentReport(suite, report, mode) {
  const jsonPath = saveLastReport(suite, report, mode);
  const lines = [
    formatReportText(suite, report),
    "",
    `JSON saved: ${jsonPath}`,
    `Terminal log: ${lastTerminalPath(suite, mode)}`,
  ];
  const output = `${lines.join("\n")}\n`;
  process.stdout.write(output);
  return { jsonPath, healthy: isHealthy(report) };
}

function loadReportFromFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error("empty report file");
  return JSON.parse(raw);
}

/** @returns {SuiteRunMode} */
function parseRunMode(value) {
  if (value === "node" || value === "platform") return value;
  throw new Error(`invalid run mode: ${value} (expected node or platform)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const suite = process.argv[2];
  const rawPath = process.argv[3];
  const modeArg = process.argv[4] ?? "platform";
  if (!suite || !rawPath) {
    console.error("usage: node scripts/suite-report.mjs <suite> <raw-report.json> [node|platform]");
    process.exit(1);
  }
  let mode;
  try {
    mode = parseRunMode(modeArg);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  let report;
  try {
    report = loadReportFromFile(rawPath);
  } catch (e) {
    console.error(`Cannot read report: ${rawPath}`);
    console.error(e);
    process.exit(1);
  }
  const { healthy } = presentReport(suite, report, mode);
  if (!healthy) process.exit(1);
}
