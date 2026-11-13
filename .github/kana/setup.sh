#!/usr/bin/env bash
set -euo pipefail

npm install --global bun@1.4.4
bun install --frozen-lockfile
