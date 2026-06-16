#!/usr/bin/env bash
set -euo pipefail

repo="longyijdos/kana"
install_dir="${KANA_INSTALL_DIR:-"$HOME/.local/bin"}"
bin_name="${KANA_BIN_NAME:-kana}"
version="${KANA_VERSION:-latest}"
target="$install_dir/$bin_name"
tmp_dir=""

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    return
  fi

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
  require_command git

  tmp_dir="$(mktemp -d)"
  trap cleanup EXIT

  local tmp_bin="$tmp_dir/$bin_name"
  echo "Building Kana from source..."
  bun build --compile --outfile="$tmp_bin" src/main.ts

  install -m 0755 "$tmp_bin" "$target"
  echo "Installed Kana to $target"
  warn_if_install_dir_not_on_path

  "$target" install --force --skills
}

install_from_release() {
  local platform asset
  platform="$(detect_platform)"
  asset="kana-$platform"

  if [[ "$platform" == unsupported-* ]]; then
    cat >&2 <<EOF
Unsupported platform: ${platform#unsupported-}

Build from source instead:
  git clone https://github.com/$repo.git
  cd kana
  bun install
  ./scripts/install.sh
EOF
    exit 1
  fi

  require_command curl
  require_command git

  tmp_dir="$(mktemp -d)"
  trap cleanup EXIT

  local tmp_bin="$tmp_dir/$bin_name"
  local tmp_checksum="$tmp_dir/$asset.sha256"
  local url
  if [[ "$version" == "latest" ]]; then
    url="https://github.com/$repo/releases/latest/download/$asset"
  else
    url="https://github.com/$repo/releases/download/$version/$asset"
  fi

  echo "Downloading Kana $version for $platform..."
  curl --fail --location --show-error --silent "$url" --output "$tmp_bin"
  curl --fail --location --show-error --silent "$url.sha256" --output "$tmp_checksum"
  verify_checksum "$tmp_bin" "$tmp_checksum"

  install -m 0755 "$tmp_bin" "$target"
  echo "Installed Kana to $target"
  warn_if_install_dir_not_on_path

  "$target" install --force --skills
}

usage() {
  cat <<EOF
Kana installer

Environment:
  KANA_INSTALL_DIR   Install directory. Defaults to $HOME/.local/bin.
  KANA_BIN_NAME      Installed binary name. Defaults to kana.
  KANA_VERSION       Release tag to install. Defaults to latest.
EOF
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

verify_checksum() {
  local file checksum_file expected actual
  file="$1"
  checksum_file="$2"
  expected="$(awk '{print $1}' "$checksum_file")"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "Missing required command: sha256sum or shasum" >&2
    exit 1
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum verification failed for downloaded Kana binary." >&2
    exit 1
  fi
}

warn_if_install_dir_not_on_path() {
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      cat >&2 <<EOF
Warning: $install_dir is not on PATH.
Add it to PATH or run Kana with:
  $target
EOF
      ;;
  esac
}

cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}

main "$@"
