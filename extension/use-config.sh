#!/bin/bash
ENV=${1:-dev}
SRC="config-${ENV}.js"
if [ ! -f "$SRC" ]; then
  echo "Error: $SRC not found" >&2
  exit 1
fi
cp "$SRC" config.js
echo "config.js ← $SRC"
