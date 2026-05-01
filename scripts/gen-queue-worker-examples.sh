#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node "$SCRIPT_DIR/gen-code-examples.cjs" \
  --marker "QUEUE WORKER LLM PROMPT EXAMPLE" \
  --dir    "units/queue-worker-tests" \
  --output "src/libs/unit_js/unit_prompts/queue_worker.rs" \
  --var    "CODE_EXAMPLES"
