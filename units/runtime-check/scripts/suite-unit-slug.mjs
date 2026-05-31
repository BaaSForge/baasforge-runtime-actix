/**
 * Maps a runtime-check package folder name to project_units.unit_name_slug
 * (same rules as src/libs/unit_slug.rs normalize_filename_stem_to_slug).
 *
 * Usage: node scripts/suite-unit-slug.mjs <package-folder-name>
 */
import { fileURLToPath } from "node:url";
const DIGIT_WORD = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];
const SLUG_RE = /^[a-z]+(-[a-z]+)*$/;

/** @param {string} stem */
export function normalizePackageNameToUnitSlug(stem) {
  const parts = [];
  let letters = "";
  let digits = "";

  const flushLetters = () => {
    if (letters) {
      parts.push(letters);
      letters = "";
    }
  };
  const flushDigits = () => {
    if (!digits) return;
    for (const ch of digits) {
      parts.push(DIGIT_WORD[ch.charCodeAt(0) - 48]);
    }
    digits = "";
  };

  for (const c of stem.toLowerCase()) {
    if (c >= "a" && c <= "z") {
      flushDigits();
      letters += c;
    } else if (c >= "0" && c <= "9") {
      flushLetters();
      digits += c;
    } else if (c === "_" || c === "-" || c === " " || c === ".") {
      flushDigits();
      flushLetters();
    } else {
      flushDigits();
      flushLetters();
    }
  }
  flushDigits();
  flushLetters();

  if (parts.length === 0) return null;
  const out = parts.join("-");
  return SLUG_RE.test(out) ? out : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stem = process.argv[2];
  if (!stem) {
    console.error("usage: node scripts/suite-unit-slug.mjs <package-folder-name>");
    process.exit(1);
  }
  const slug = normalizePackageNameToUnitSlug(stem);
  if (!slug) {
    console.error(`cannot map package name to unit_name_slug: ${stem}`);
    process.exit(1);
  }
  process.stdout.write(slug);
}
