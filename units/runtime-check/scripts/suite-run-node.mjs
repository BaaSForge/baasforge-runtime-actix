/**
 * Run a runtime-check library suite via handleRequest + minimal req/res mocks.
 *
 * Usage: node scripts/suite-run-node.mjs <suite>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { presentReport } from "./suite-report.mjs";

const suite = process.argv[2];
if (!suite) {
  console.error("usage: node scripts/suite-run-node.mjs <suite>");
  process.exit(1);
}

const runtimeCheckRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(runtimeCheckRoot, "dist", "packages", suite, "index.js");
let handleRequest;
try {
  ({ handleRequest } = await import(distIndex));
} catch (e) {
  console.error(`Cannot load ${distIndex} — run npm run build in units/runtime-check first.`);
  console.error(e);
  process.exit(1);
}

const chunks = [];
const mockReq = { headers: {} };
const mockRes = {
  writeHead() {},
  end(chunk) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  },
};

await handleRequest(mockReq, mockRes);
const body = chunks.join("");
let report;
try {
  report = JSON.parse(body);
} catch {
  console.error("handleRequest did not return JSON:");
  console.error(body);
  process.exit(1);
}

const { healthy } = presentReport(suite, report, "node");
if (!healthy) process.exit(1);
