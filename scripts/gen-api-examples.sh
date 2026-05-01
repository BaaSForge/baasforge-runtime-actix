#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node "$SCRIPT_DIR/gen-code-examples.cjs" \
  --marker "API LLM PROMPT EXAMPLE" \
  --dir    "units/api-tests" \
  --output "src/libs/unit_js/unit_prompts/api.rs" \
  --var    "CODE_EXAMPLES"
