#!/usr/bin/env bash
set -euo pipefail

npm install --global bun@1.3.14
bun install --frozen-lockfile
