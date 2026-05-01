#!/usr/bin/env node
/**
 * gen-code-examples.cjs
 *
 * Collects TypeScript unit files annotated with `@active <MARKER>` from a
 * given directory, strips internal doc annotations (@active, @important),
 * and writes them as a static Rust `pub const` raw-string literal.
 *
 * Designed to be reusable across unit types (workflows, actors, queue workers, etc.).
 *
 * Usage:
 *   node gen-code-examples.cjs \
 *     --marker "WORKFLOW LLM PROMPT EXAMPLE" \
 *     --dir    "units/workflow-tests" \
 *     --output "src/libs/unit_js/unit_prompts/workflow.rs" \
 *     --var    "CODE_EXAMPLES"
 *
 * Files marked `@skipped <MARKER>` are excluded from discovery (not copied into
 * the prompt). Put `@covers` and `@important` on contiguous lines without a
 * blank line between them so the emitted JSDoc does not retain a bare ` *`
 * line after `@important` is stripped.
 *
 * DO NOT add `@skipped <MARKER>` to file discovery (the `.filter` that builds
 * `files`). Skipped examples may live next to active tests for humans or CI,
 * but they must never be embedded in LLM prompt literals. Regression: discovery
 * briefly OR'd `@skipped` and pulled skipped units into prompts — keep discovery
 * strictly `@active` only.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkTs(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walkTs(full);
      for (const n of nested) results.push(n);
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strip annotation lines from file content, then clean up resulting blank
 * JSDoc lines so the output is tidy.
 *
 * Removed:
 *  - Lines that contain `@active <marker>` (the discovery marker)
 *  - Lines that match `* @important ...` (internal maintenance notes)
 *
 * Collapsed:
 *  - Consecutive blank JSDoc lines (bare ` *`) -> one blank line
 *  - A blank JSDoc line immediately after start of JSDoc block -> removed
 *  - A blank JSDoc line immediately before end of JSDoc block -> removed
 */
function cleanContent(content, marker) {
  const activeTag = "@active " + marker;

  const lines = content.split("\n");

  const filtered = lines.filter(function (line) {
    if (line.indexOf("@active") !== -1 && line.indexOf(activeTag) !== -1) return false;
    if (/\*\s*@important/.test(line)) return false;
    return true;
  });

  // Collapse consecutive blank JSDoc lines (lines that are just " *")
  const collapsed = [];
  let prevBlankJsDoc = false;
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i];
    const isBlankJsDoc = /^\s*\*\s*$/.test(line);
    if (isBlankJsDoc && prevBlankJsDoc) continue;
    prevBlankJsDoc = isBlankJsDoc;
    collapsed.push(line);
  }

  return collapsed
    .join("\n")
    // Remove blank JSDoc line immediately after /**
    .replace(/^(\/\*\*)\n \*\n/, "$1\n")
    // Remove blank JSDoc line immediately before */
    .replace(/\n \*\n( \*\/)$/, "\n$1")
    .trim();
}

// ---------------------------------------------------------------------------
// CLI arg parsing  (--key value pairs)
// ---------------------------------------------------------------------------

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  args[key] = process.argv[i + 1];
}

const marker = args["marker"];
const dir = args["dir"];
const output = args["output"];
const varName = args["var"];

if (!marker || !dir || !output || !varName) {
  process.stderr.write(
    "Usage: node gen-code-examples.cjs" +
      " --marker <MARKER>" +
      " --dir <DIR>" +
      " --output <RUST_FILE>" +
      " --var <CONST_NAME>\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Discover files
// ---------------------------------------------------------------------------
// Discovery MUST stay `@active` only. Do not OR in `@skipped` here — skipped
// examples are intentionally absent from prompt literals (see file header).

const root = process.cwd();
const absDir = path.join(root, dir);
const absOutput = path.join(root, output);

const activeTag = "@active " + marker;

const files = walkTs(absDir)
  .filter(function (f) {
    const content = fs.readFileSync(f, "utf8");
    return content.indexOf(activeTag) !== -1;
  })
  .sort(function (a, b) {
    return path.relative(absDir, a).localeCompare(path.relative(absDir, b));
  });

if (files.length === 0) {
  process.stderr.write("No files found matching " + activeTag + " in " + dir + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build combined content
// ---------------------------------------------------------------------------

const sections = files.map(function (f) {
  const content = fs.readFileSync(f, "utf8");
  const rel = path.relative(absDir, f);
  const cleaned = cleanContent(content, marker);
  return "// " + rel + "\n" + cleaned;
});

const combined = sections.join("\n\n");

// ---------------------------------------------------------------------------
// Update the Rust file in-place
// ---------------------------------------------------------------------------
//
// We search for:
//   pub const CODE_EXAMPLES: &str = r#"
//   ...anything...
//   "#;
//
// The Rust raw-string delimiters r#" and "# are unique enough that they
// won't appear in TypeScript source, so a simple indexOf-based replacement
// is safer than a regex here.

const rust = fs.readFileSync(absOutput, "utf8");

const declStart = 'pub const ' + varName + ': &str = r#"';
const declEnd   = '"#;';

const startIdx = rust.indexOf(declStart);
if (startIdx === -1) {
  process.stderr.write('Could not find "pub const ' + varName + '" in ' + output + "\n");
  process.exit(1);
}

const afterOpen = startIdx + declStart.length;
const endIdx = rust.indexOf(declEnd, afterOpen);
if (endIdx === -1) {
  process.stderr.write('Could not find closing "#; for ' + varName + ' in ' + output + "\n");
  process.exit(1);
}

const before  = rust.slice(0, afterOpen);
const after   = rust.slice(endIdx);
const updated = before + "\n" + combined + "\n" + after;

fs.writeFileSync(absOutput, updated, "utf8");

process.stdout.write(
  "Updated " + varName + " in " + output + " -- " + files.length + " example(s):\n"
);
files.forEach(function (f) {
  process.stdout.write("  " + path.relative(absDir, f) + "\n");
});
