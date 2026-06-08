#!/usr/bin/env bash
# Resolve host/container paths for overriding a repo file in the integration-test image.
set -euo pipefail

override_host_dir() {
  echo "/tmp/baal-repo-file-override-$1"
}

host_file_path() {
  echo "$(override_host_dir "$1")/$2"
}

container_file_path() {
  echo "/app/$1"
}

usage() {
  cat >&2 <<'EOF'
usage: repo-file-override.sh <command> [args]

commands:
  override-host-dir <run_id>
  host-file-path <run_id> <repo_rel_path>
  container-file-path <repo_rel_path>
EOF
  exit 1
}

cmd="${1:-}"
shift || usage

case "$cmd" in
  override-host-dir)
    [ $# -eq 1 ] || usage
    override_host_dir "$1"
    ;;
  host-file-path)
    [ $# -eq 2 ] || usage
    host_file_path "$1" "$2"
    ;;
  container-file-path)
    [ $# -eq 1 ] || usage
    container_file_path "$1"
    ;;
  *)
    usage
    ;;
esac
