#!/bin/bash
set -euo pipefail
export CARGO_BUILD_RUSTC_WRAPPER=
# CARGO_INCREMENTAL=1 cargo watch -w src -s "cargo run --bin runtime_cache_listener"
CARGO_INCREMENTAL=1 cargo run --bin runtime_cache_listener
