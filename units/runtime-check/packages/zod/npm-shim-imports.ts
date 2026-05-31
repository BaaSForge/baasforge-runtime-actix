// @ts-nocheck — side-effect imports for QuickJS shim bundling only.
//
// Every npm subpath that must load on the platform MUST be listed here as a bare import:
//   import "zod/v4/mini";
// scripts/build.mjs scans this file and bundles each specifier into dist/ + npm_shims_gen.rs.
// Subpaths used only in LLM/unit code (not imported from packages/<name>/index.ts) still need
// a line here — otherwise they are not shimmed at runtime.
//
/** Public zod package.json exports (skip v3, v4-mini, zod/locales alias). */
import "zod/v4";
import "zod/v4/core";
import "zod/v4/mini";
import "zod/v4/locales";
import "zod/v4/locales/ar";
import "zod/v4/locales/az";
import "zod/v4/locales/be";
import "zod/v4/locales/bg";
import "zod/v4/locales/ca";
import "zod/v4/locales/cs";
import "zod/v4/locales/da";
import "zod/v4/locales/de";
import "zod/v4/locales/el";
import "zod/v4/locales/en";
import "zod/v4/locales/eo";
import "zod/v4/locales/es";
import "zod/v4/locales/fa";
import "zod/v4/locales/fi";
import "zod/v4/locales/fr";
import "zod/v4/locales/fr-CA";
import "zod/v4/locales/he";
import "zod/v4/locales/hr";
import "zod/v4/locales/hu";
import "zod/v4/locales/hy";
import "zod/v4/locales/id";
import "zod/v4/locales/is";
import "zod/v4/locales/it";
import "zod/v4/locales/ja";
import "zod/v4/locales/ka";
import "zod/v4/locales/kh";
import "zod/v4/locales/km";
import "zod/v4/locales/ko";
import "zod/v4/locales/lt";
import "zod/v4/locales/mk";
import "zod/v4/locales/ms";
import "zod/v4/locales/nl";
import "zod/v4/locales/no";
import "zod/v4/locales/ota";
import "zod/v4/locales/pl";
import "zod/v4/locales/ps";
import "zod/v4/locales/pt";
import "zod/v4/locales/ro";
import "zod/v4/locales/ru";
import "zod/v4/locales/sl";
import "zod/v4/locales/sv";
import "zod/v4/locales/ta";
import "zod/v4/locales/th";
import "zod/v4/locales/tr";
import "zod/v4/locales/ua";
import "zod/v4/locales/uk";
import "zod/v4/locales/ur";
import "zod/v4/locales/uz";
import "zod/v4/locales/vi";
import "zod/v4/locales/yo";
import "zod/v4/locales/zh-CN";
import "zod/v4/locales/zh-TW";
