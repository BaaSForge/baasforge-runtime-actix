#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node "$SCRIPT_DIR/gen-code-examples.cjs" \
  --marker "ACTOR LLM PROMPT EXAMPLE" \
  --dir    "units/actor-tests" \
  --output "src/libs/unit_js/unit_prompts/actor.rs" \
  --var    "CODE_EXAMPLES"
