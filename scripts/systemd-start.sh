#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "${NODE_BIN:-node}" "$PROJECT_DIR/dist/src/index.js"
