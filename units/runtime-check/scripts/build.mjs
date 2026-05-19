/**
 * Single TypeScript process: type-checks all runtime-check tests, emits dist/, and
 * records every node_modules type file the compiler host loads into runtime-project-tsc-type-deps.json.
 *
 * Recording happens during the same check (readFile / getSourceFile), so the report
 * cannot drift from what tsc actually used — nothing loaded at check time should be
 * missing from the export.
 *
 * src/tsgo on the backend project consumes that report to decide which node_modules
 * types to include when type-checking LLM-written code. A gap here breaks tsgo.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectDir, "tsconfig.json");
const outJson = join(projectDir, "runtime-project-tsc-type-deps.json");

const GENERATED_NOTICE = [
  "AUTO-GENERATED — do not edit manually.",
  "Regenerate by running: ./units/runtime-check/test.sh",
  "Used by src/tsgo on the backend project to type-check LLM-generated code.",
].join(" ");

const formatHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n",
};

function npmPackageFromPath(filePath) {
  const marker = `${join("", "node_modules")}/`;
  const idx = filePath.indexOf(marker);
  if (idx === -1) return null;
  const rest = filePath.slice(idx + marker.length);
  if (rest.startsWith("@")) {
    const [scope, name] = rest.split("/");
    return `${scope}/${name}`;
  }
  return rest.split("/")[0];
}

function createRecordingCompilerHost(options) {
  const usedNodeModulesFiles = new Set();
  const host = ts.createCompilerHost(options, true);

  const record = (fileName) => {
    if (typeof fileName !== "string" || !fileName.includes("node_modules")) {
      return;
    }
    const normalized = ts.normalizePath(fileName);
    if (
      normalized.includes("/node_modules/typescript/") ||
      normalized.endsWith(".json")
    ) {
      return;
    }
    usedNodeModulesFiles.add(normalized);
  };

  const wrap =
    (original) =>
    (...args) => {
      record(args[0]);
      return original(...args);
    };

  host.readFile = wrap(host.readFile.bind(host));
  host.getSourceFile = wrap(host.getSourceFile.bind(host));

  return { host, usedNodeModulesFiles };
}

function writeTypeDepsReport(usedNodeModulesFiles, parsed) {
  const files = [...usedNodeModulesFiles]
    .sort()
    .map((f) => relative(projectDir, f));
  const byPackage = {};
  for (const file of files) {
    const pkg = npmPackageFromPath(file) ?? "(unknown)";
    (byPackage[pkg] ??= []).push(file);
  }

  const report = {
    generatedNotice: GENERATED_NOTICE,
    method:
      "Recorded from the TypeScript compiler host while type-checking (readFile, getSourceFile) — only files the checker actually loaded. Excludes the typescript built-in lib and .json files (e.g. package.json). Packages in node_modules that are never imported (and not in tsconfig types) do not appear.",
    compilerOptionsLib: parsed.options.lib ?? [],
    fileCount: files.length,
    packages: Object.fromEntries(
      Object.entries(byPackage)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pkg, paths]) => [pkg, { fileCount: paths.length, files: paths }]),
    ),
    files,
  };

  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Wrote ${files.length} type deps loaded during check:`);
  console.log(`  ${relative(projectDir, outJson)}`);
  for (const [pkg, { fileCount }] of Object.entries(report.packages)) {
    console.log(`  ${pkg}: ${fileCount}`);
  }
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.formatDiagnostic(configFile.error, formatHost));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  projectDir,
);

const configDiagnostics = [...parsed.errors];
if (configDiagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) {
  for (const d of configDiagnostics) {
    console.error(ts.formatDiagnostic(d, formatHost));
  }
  process.exit(1);
}

const compilerOptions = {
  ...parsed.options,
  noEmit: false,
  outDir: join(projectDir, "dist"),
  sourceMap: false,
  declaration: false,
  noUnusedLocals: false,
  noUnusedParameters: false,
};

const { host, usedNodeModulesFiles } = createRecordingCompilerHost(compilerOptions);
const program = ts.createProgram(parsed.fileNames, compilerOptions, host);

const checkDiagnostics = ts.getPreEmitDiagnostics(program);
const emitResult = program.emit();
const diagnostics = [...checkDiagnostics, ...emitResult.diagnostics];

if (diagnostics.length) {
  for (const d of diagnostics) {
    console.error(ts.formatDiagnostic(d, formatHost));
  }
}

if (
  emitResult.emitSkipped ||
  diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)
) {
  process.exit(1);
}

writeTypeDepsReport(usedNodeModulesFiles, parsed);
console.log(`Emitted JS to ${relative(projectDir, compilerOptions.outDir)}/`);
