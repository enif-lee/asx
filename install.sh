#!/usr/bin/env sh
set -eu

REPO="${ASX_REPO:-enif-lee/asx}"
VERSION="${ASX_VERSION:-latest}"
MIN_NODE_MAJOR=20

log() { printf '%s\n' "$*"; }
die() { printf 'asx install error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi
}

node_ok() {
  has node && node -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" >/dev/null 2>&1
}

has_package_manager() {
  has npm || has pnpm
}

install_node_lts() {
  has curl || die "curl is required to install Node.js LTS."
  has bash || die "bash is required to install Node.js LTS with nvm."
  log "Installing Node.js LTS with nvm..."

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  load_nvm
  has nvm || die "nvm installation failed. Open a new shell and retry, or install Node.js LTS manually."
  nvm install --lts
  nvm use --lts
}

pick_package_manager() {
  if has npm; then
    printf 'npm\n'
  elif has pnpm; then
    printf 'pnpm\n'
  else
    return 1
  fi
}

download_release_package() {
  has curl || die "curl is required to download ASX."

  tmp_dir="${TMPDIR:-/tmp}/asx-install-$$"
  mkdir -p "$tmp_dir"
  release_json="$tmp_dir/release.json"
  package_path="$tmp_dir/asx.tgz"

  if [ "$VERSION" = "latest" ]; then
    api_url="https://api.github.com/repos/$REPO/releases/latest"
  else
    api_url="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  fi

  curl -fsSL "$api_url" -o "$release_json" || die "failed to read GitHub release metadata from $api_url"

  asset_url="$(ASX_RELEASE_JSON="$release_json" node <<'NODE'
const fs = require('node:fs');
const release = JSON.parse(fs.readFileSync(process.env.ASX_RELEASE_JSON, 'utf8'));
const assets = Array.isArray(release.assets) ? release.assets : [];
const asset = assets.find((x) => /^asx-.*\.tgz$/i.test(x.name)) || assets.find((x) => /\.tgz$/i.test(x.name));
if (!asset || !asset.browser_download_url) {
  const tag = release.tag_name || 'latest';
  console.error(`No asx .tgz release asset found for ${tag}.`);
  process.exit(1);
}
console.log(asset.browser_download_url);
NODE
)" || die "failed to find ASX release artifact"

  curl -fL "$asset_url" -o "$package_path" || die "failed to download $asset_url"
  printf '%s\n' "$package_path"
}

install_package() {
  package_path="$1"
  pm="$2"

  if [ "$pm" = "npm" ]; then
    npm install -g "$package_path"
  else
    pnpm add -g "$package_path"
  fi
}

load_nvm
if ! node_ok || ! has_package_manager; then
  install_node_lts
fi

node_ok || die "Node.js >= $MIN_NODE_MAJOR is required."
pm="$(pick_package_manager)" || die "npm or pnpm is required."

if [ -n "${ASX_INSTALL_TARGET:-}" ]; then
  if [ -f "$ASX_INSTALL_TARGET" ]; then
    case "$ASX_INSTALL_TARGET" in
      /*) package_path="$ASX_INSTALL_TARGET" ;;
      *) package_path="$(pwd)/$ASX_INSTALL_TARGET" ;;
    esac
  else
    package_path="$ASX_INSTALL_TARGET"
  fi
else
  package_path="$(download_release_package)"
fi

log "Installing ASX with $pm..."
install_package "$package_path" "$pm"

has asx || die "ASX installed, but 'asx' is not on PATH."
log "ASX installed: $(asx --version)"
