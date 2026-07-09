#!/usr/bin/env sh
set -eu

REPO="${ASX_REPO:-enif-lee/asx}"
VERSION="${ASX_VERSION:-latest}"
MIN_NODE_MAJOR=20
GITHUB_AUTH_TOKEN="${GH_TOKEN:-}"
if [ -z "$GITHUB_AUTH_TOKEN" ]; then
  GITHUB_AUTH_TOKEN="${GITHUB_TOKEN:-}"
fi

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

validate_package() {
  package_path="$1"
  has tar || die "tar is required to verify ASX package artifacts."
  tar -tzf "$package_path" | grep -qx 'package/dist/cli.js' || die "downloaded ASX package is missing dist/cli.js. The release artifact is incomplete."
}

build_source_package() {
  source_path="$1"
  build_dir="$2/source"
  pack_dir="$2/pack"

  has tar || die "tar is required to install ASX from a source release."
  has npm || die "npm is required to build ASX from a source release."

  mkdir -p "$build_dir" "$pack_dir"
  tar -xzf "$source_path" -C "$build_dir"
  source_dir="$(find "$build_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$source_dir" ] || die "failed to unpack ASX source release."

  printf '%s\n' "No release package asset found; building ASX from source..." >&2
  (
    cd "$source_dir"
    if [ -f package-lock.json ]; then
      npm ci
    else
      npm install
    fi
    npm run build
    npm pack --pack-destination "$pack_dir" --ignore-scripts >/dev/null
  ) >&2

  built_package="$(find "$pack_dir" -mindepth 1 -maxdepth 1 -name 'asx-*.tgz' -type f | head -n 1)"
  [ -n "$built_package" ] || die "failed to build ASX package from source."
  validate_package "$built_package"
  printf '%s\n' "$built_package"
}

download_release_package() {
  has curl || die "curl is required to download ASX."

  tmp_dir="${TMPDIR:-/tmp}/asx-install-$$"
  mkdir -p "$tmp_dir"
  release_json="$tmp_dir/release.json"
  package_path="$tmp_dir/asx.tgz"
  source_path="$tmp_dir/asx-source.tgz"

  if [ "$VERSION" = "latest" ]; then
    api_url="https://api.github.com/repos/$REPO/releases/latest"
  else
    api_url="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  fi

  if [ -n "$GITHUB_AUTH_TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_AUTH_TOKEN" -H "Accept: application/vnd.github+json" "$api_url" -o "$release_json" || die "failed to read GitHub release metadata from $api_url"
  else
    curl -fsSL "$api_url" -o "$release_json" || die "failed to read GitHub release metadata from $api_url"
  fi

  download_spec="$(ASX_RELEASE_JSON="$release_json" GITHUB_AUTH_TOKEN="$GITHUB_AUTH_TOKEN" node <<'NODE'
const fs = require('node:fs');
const release = JSON.parse(fs.readFileSync(process.env.ASX_RELEASE_JSON, 'utf8'));
const assets = Array.isArray(release.assets) ? release.assets : [];
const asset = assets.find((x) => /^asx-.*\.tgz$/i.test(x.name)) || assets.find((x) => /\.tgz$/i.test(x.name));
if (asset && asset.browser_download_url) {
  console.log(['asset', process.env.GITHUB_AUTH_TOKEN ? asset.url : asset.browser_download_url].join('\t'));
} else if (release.tarball_url) {
  console.log(['source', release.tarball_url].join('\t'));
} else {
  console.error(`No ASX package asset or source archive found for ${release.tag_name || 'latest'}.`);
  process.exit(1);
}
NODE
)" || die "failed to find ASX release artifact"

  download_kind="$(printf '%s' "$download_spec" | cut -f 1)"
  download_url="$(printf '%s' "$download_spec" | cut -f 2-)"

  if [ -n "$GITHUB_AUTH_TOKEN" ]; then
    curl -fL -H "Authorization: Bearer $GITHUB_AUTH_TOKEN" -H "Accept: application/octet-stream" "$download_url" -o "$package_path" || die "failed to download $download_url"
  else
    curl -fL "$download_url" -o "$package_path" || die "failed to download $download_url"
  fi

  if [ "$download_kind" = "source" ]; then
    mv "$package_path" "$source_path"
    build_source_package "$source_path" "$tmp_dir"
    return
  fi

  validate_package "$package_path"
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
