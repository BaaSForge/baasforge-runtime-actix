#!/usr/bin/env bash
export SUITE_THROW_QUERY='?mode=throw'
export SUITE_THROW_EXPECT='Forbidden'
exec "$(cd "$(dirname "$0")/../.." && pwd)/scripts/suite-test.sh" http-errors
