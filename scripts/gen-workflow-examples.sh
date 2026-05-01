#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node "$SCRIPT_DIR/gen-code-examples.cjs" \
  --marker "WORKFLOW LLM PROMPT EXAMPLE" \
  --dir    "units/workflow-tests" \
  --output "src/libs/unit_js/unit_prompts/workflow.rs" \
  --var    "CODE_EXAMPLES"
