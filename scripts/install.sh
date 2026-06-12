#!/usr/bin/env bash
set -euo pipefail

repo="longyijdos/kana"
install_dir="${KANA_INSTALL_DIR:-"$HOME/.local/bin"}"
bin_name="${KANA_BIN_NAME:-kana}"
target="$install_dir/$bin_name"
tmp_dir=""

main() {
  mkdir -p "$install_dir"

  if is_project_root; then
    install_from_source
    return
  fi

  install_from_release
}

is_project_root() {
  [[ -f "package.json" && -f "src/main.ts" && -f "bun.lock" ]]
}

install_from_source() {
  require_command bun

  tmp_dir="$(mktemp -d)"
  trap cleanup EXIT

  local tmp_bin="$tmp_dir/$bin_name"
  echo "Building Kana from source..."
  bun build --compile --outfile="$tmp_bin" src/main.ts

  install -m 0755 "$tmp_bin" "$target"
  echo "Installed Kana to $target"

  "$target" install --force
}

install_from_release() {
  local platform asset
  platform="$(detect_platform)"
  asset="kana-$platform"

  cat >&2 <<EOF
GitHub Release installation is not available yet.

Expected future asset: $asset
Expected future source: https://github.com/$repo/releases/latest/download/$asset

For now, run this script from the Kana project root so it can build locally:
  ./scripts/install.sh
EOF
  exit 1
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "unsupported-$os-$arch"
      return
      ;;
  esac

  case "$arch" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x64" ;;
    *)
      echo "unsupported-$os-$arch"
      return
      ;;
  esac

  echo "$os-$arch"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}

main "$@"
