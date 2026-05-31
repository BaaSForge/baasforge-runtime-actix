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
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import ts from "typescript";

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(projectDir, "../..");
const npmShimsGenRs = join(repoRoot, "src/libs/unit_js/npm_shims_gen.rs");
const projectRequire = createRequire(join(projectDir, "package.json"));

function rootPackageFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length <= 2 ? specifier : `${parts[0]}/${parts[1]}`;
  }
  return specifier.split("/")[0];
}

function isRootSpecifier(specifier) {
  return specifier === rootPackageFromSpecifier(specifier);
}

function distRelForSpecifier(specifier) {
  if (isRootSpecifier(specifier)) {
    return `${specifier}/node_module.js`;
  }
  if (specifier.endsWith(".js")) {
    return specifier;
  }
  return `${specifier}.js`;
}

function specifierForVendorBundle(specifier) {
  try {
    projectRequire.resolve(specifier);
    return specifier;
  } catch {
    const withJs = `${specifier}.js`;
    projectRequire.resolve(withJs);
    return withJs;
  }
}

async function loadNpmModuleNamespace(specifier) {
  const resolved = specifierForVendorBundle(specifier);
  try {
    return await import(resolved);
  } catch {
    const resolvedPath = projectRequire.resolve(resolved);
    return import(pathToFileURL(resolvedPath).href);
  }
}

const VALID_EXPORT_IDENT = /^[a-zA-Z_$][\w$]*$/;
const RESERVED_EXPORT_NAMES = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
  "while", "with", "yield", "let", "static", "await",
]);

async function npmModuleExportInfo(specifier) {
  const mod = await loadNpmModuleNamespace(specifier);
  const keys = Object.keys(mod).filter((k) => VALID_EXPORT_IDENT.test(k));
  const hasDefault = keys.includes("default");
  return { keys, hasDefault };
}

function vendorEntryForPackage(pkg, { keys, hasDefault }) {
  const lines = [`import * as __mod from ${JSON.stringify(pkg)};`];
  for (const k of keys) {
    if (k === "default") {
      if (hasDefault) lines.push("export default __mod.default;");
    } else if (RESERVED_EXPORT_NAMES.has(k)) {
      const alias = `__export_${k}`;
      lines.push(`const ${alias} = __mod[${JSON.stringify(k)}];`);
      lines.push(`export { ${alias} as ${k} };`);
    } else {
      lines.push(`export const ${k} = __mod.${k};`);
    }
  }
  return lines.join("\n");
}
const packagesDir = join(projectDir, "packages");

function readNpmShimImportSpecifiers(packageName) {
  const shimPath = join(packagesDir, packageName, "npm-shim-imports.ts");
  if (!existsSync(shimPath)) return [];
  const text = readFileSync(shimPath, "utf8");
  const specs = [];
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']\s*;/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

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

function packageJsonRelativePath(pkgName) {
  return ["node_modules", ...pkgName.split("/"), "package.json"].join("/");
}

function withNpmPackageJsonFiles(relativeFiles) {
  const packages = new Set();
  for (const file of relativeFiles) {
    const pkg = npmPackageFromPath(file);
    if (pkg) packages.add(pkg);
  }
  const out = new Set(relativeFiles);
  for (const pkg of packages) {
    const rel = packageJsonRelativePath(pkg);
    if (existsSync(join(projectDir, rel))) out.add(rel);
  }
  return [...out].sort();
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
  const files = withNpmPackageJsonFiles(
    [...usedNodeModulesFiles].sort().map((f) => relative(projectDir, f)),
  );
  const byPackage = {};
  for (const file of files) {
    const pkg = npmPackageFromPath(file) ?? "(unknown)";
    (byPackage[pkg] ??= []).push(file);
  }

  const report = {
    generatedNotice: GENERATED_NOTICE,
    method:
      "Recorded from the TypeScript compiler host while type-checking (readFile, getSourceFile) — only .d.ts files the checker actually loaded, plus each involved npm package's package.json (needed when types resolve via package.json \"types\" / \"exports\"). Excludes the typescript built-in lib. Packages in node_modules that are never imported (and not in tsconfig types) do not appear.",
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

const packageNames = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const externalizeNodeBuiltinPlugin = {
  name: "externalize-node-builtin",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

function createMimeTypesNodePathPlugin() {
  return {
    name: "mime-types-node-path",
    setup(build) {
      build.onResolve({ filter: /^path$/ }, () => ({
        path: "node:path",
        external: true,
      }));
    },
  };
}

function createExternalizeNpmPlugin(npmSpecifiers) {
  const pluginDataKey = "externalize-npm-resolve";
  return {
    name: "externalize-npm",
    setup(build) {
      externalizeNodeBuiltinPlugin.setup(build);

      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.[pluginDataKey]) return;
        let resolved;
        try {
          resolved = await build.resolve(args.path, {
            resolveDir: args.resolveDir,
            kind: args.kind,
            pluginData: { [pluginDataKey]: true },
          });
        } catch {
          return { path: args.path, external: true };
        }
        if (!resolved.path.includes("node_modules")) {
          return { path: args.path, external: true };
        }
        npmSpecifiers.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}

const browserBundle = {
  absWorkingDir: projectDir,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2023",
  logLevel: "silent",
};

async function bundleVendorSpecifier(specifier, suiteName) {
  const distRel = distRelForSpecifier(specifier);
  const outfile = join(compilerOptions.outDir, distRel);
  mkdirSync(dirname(outfile), { recursive: true });
  const bundleSpec = specifierForVendorBundle(specifier);
  const info = await npmModuleExportInfo(bundleSpec);
  const vendorEntry = vendorEntryForPackage(bundleSpec, info);
  const vendorEntryPath = join(
    projectDir,
    `.esbuild-vendor-entry-${suiteName}-${distRel.replaceAll("/", "_")}.mjs`,
  );
  writeFileSync(vendorEntryPath, vendorEntry);
  try {
    const vendorPlugins = [externalizeNodeBuiltinPlugin];
    if (rootPackageFromSpecifier(specifier) === "mime-types") {
      vendorPlugins.push(createMimeTypesNodePathPlugin());
    }
    await esbuild.build({
      ...browserBundle,
      entryPoints: [vendorEntryPath],
      outfile,
      plugins: vendorPlugins,
    });
  } finally {
    unlinkSync(vendorEntryPath);
  }
  console.log(
    `Bundled npm shim → ${relative(projectDir, outfile)} (${specifier}, exports: ${info.keys.join(", ") || "(none)"})`,
  );
}

function writeNpmShimsGen(specifiers) {
  const distRoot = "../../../units/runtime-check/dist";
  const lines = [
    "// AUTO-GENERATED by units/runtime-check/scripts/build.mjs — do not edit.",
    "",
    "pub fn npm_package_shim(name: &str) -> Option<&'static str> {",
    "    match name {",
  ];
  for (const spec of [...specifiers].sort()) {
    const distRel = distRelForSpecifier(spec);
    lines.push(
      `        ${JSON.stringify(spec)} => Some(include_str!("${distRoot}/${distRel}")),`,
    );
  }
  lines.push("        _ => None,");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  writeFileSync(npmShimsGenRs, `${lines.join("\n")}`);
  console.log(
    `Wrote npm QuickJS shims (${specifiers.size} modules): ${relative(repoRoot, npmShimsGenRs)}`,
  );
}

async function bundlePackageUnit(name, allNpmSpecifiers) {
  const entry = join(packagesDir, name, "index.ts");
  const outDir = join(compilerOptions.outDir, "packages", name);
  const indexOutfile = join(outDir, "index.js");
  const npmSpecifiers = new Set(readNpmShimImportSpecifiers(name));
  const externalizeNpm = createExternalizeNpmPlugin(npmSpecifiers);

  await esbuild.build({
    ...browserBundle,
    entryPoints: [entry],
    outfile: indexOutfile,
    plugins: [externalizeNpm],
    write: false,
  });

  if (npmSpecifiers.size > 0) {
    const sorted = [...npmSpecifiers].sort();
    for (const spec of sorted) {
      if (!allNpmSpecifiers.has(spec)) {
        await bundleVendorSpecifier(spec, name);
        allNpmSpecifiers.add(spec);
      }
    }
    console.log(`  [${name}] npm specifiers: ${sorted.join(", ")}`);
  }

  await esbuild.build({
    ...browserBundle,
    entryPoints: [entry],
    outfile: indexOutfile,
    plugins: [externalizeNpm],
  });
  console.log(`Bundled package unit → ${relative(projectDir, indexOutfile)}`);
}

const allNpmSpecifiers = new Set();
for (const name of packageNames) {
  await bundlePackageUnit(name, allNpmSpecifiers);
}
writeNpmShimsGen(allNpmSpecifiers);
