#!/usr/bin/env bash
# Cut a MaD Control release.
#
# Source of truth: Software/Control/package.json "version".
# Git tag:         madcontrol-v$version  (must match package.json on that commit)
#
# Usage (from repo root or Software/Control):
#   scripts/release.sh patch|minor|major|<x.y.z> [--no-tag] [--push]
#   scripts/release.sh --publish          # tag origin/main at its package.json version
#   scripts/release.sh --check            # CI: fail if a madcontrol-v* tag != package.json
#
# Protected `main`: bump on a branch with --no-tag, merge the PR, then --publish.
# Admin shortcut (bypass): on main, `scripts/release.sh patch --push`.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONTROL_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ROOT=$(git -C "$CONTROL_DIR" rev-parse --show-toplevel)
cd "$ROOT"

PREFIX=madcontrol-v
PKG="$CONTROL_DIR/package.json"
LOCK="$CONTROL_DIR/package-lock.json"

usage() {
  cat <<'EOF'
Cut a MaD Control release.

Source of truth: Software/Control/package.json "version".
Git tag:         madcontrol-v$version  (must match package.json on that commit)

Usage (from repo root or Software/Control):
  scripts/release.sh patch|minor|major|<x.y.z> [--no-tag] [--push]
  scripts/release.sh --publish          # tag origin/main at its package.json version
  scripts/release.sh --check            # CI: fail if a madcontrol-v* tag != package.json

Protected main: bump on a branch with --no-tag, merge the PR, then --publish.
Admin shortcut (bypass): on main, scripts/release.sh patch --push.
EOF
}

pkg_version() {
  node -p "require('$PKG').version"
}

pkg_version_at() {
  local ref=$1
  git show "${ref}:Software/Control/package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version))"
}

require_clean() {
  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    echo "error: working tree is dirty. Commit or stash first." >&2
    exit 1
  fi
}

tag_name() {
  echo "${PREFIX}$1"
}

# True if this semver already shipped as madcontrol-v* or the retired webapp-v*.
version_already_shipped() {
  local version=$1
  git fetch origin --tags --quiet 2>/dev/null || true
  if git rev-parse "refs/tags/${PREFIX}${version}" >/dev/null 2>&1; then
    return 0
  fi
  if git rev-parse "refs/tags/webapp-v${version}" >/dev/null 2>&1; then
    return 0
  fi
  if git ls-remote --tags origin "refs/tags/${PREFIX}${version}" "refs/tags/webapp-v${version}" 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# Exit 0 when this ref is not a MaD Control release tag.
# Exit 1 when it is, and package.json disagrees.
check() {
  local tag_version=""
  if [[ "${GITHUB_REF:-}" == refs/tags/${PREFIX}* ]]; then
    tag_version="${GITHUB_REF#refs/tags/${PREFIX}}"
  else
    local exact
    exact=$(git describe --tags --exact-match 2>/dev/null || true)
    if [[ "$exact" == ${PREFIX}* ]]; then
      tag_version="${exact#${PREFIX}}"
    fi
  fi

  if [[ -z "$tag_version" ]]; then
    echo "Not a ${PREFIX}* tag; nothing to check."
    echo "package.json version: $(pkg_version)"
    return 0
  fi

  local pkg
  pkg=$(pkg_version)
  echo "tag=${PREFIX}${tag_version}  package.json=${pkg}"
  if [[ "$tag_version" != "$pkg" ]]; then
    echo "error: MaD Control tag ${PREFIX}${tag_version} does not match Software/Control/package.json version ${pkg}." >&2
    echo "Bump package.json in the same commit you tag. Use Software/Control/scripts/release.sh — do not tag by hand." >&2
    exit 1
  fi
  echo "MaD Control ${pkg} matches tag ${PREFIX}${tag_version}"
}

publish() {
  git fetch origin main --tags --quiet
  local version
  version=$(pkg_version_at origin/main)
  local tag
  tag=$(tag_name "$version")
  local commit
  commit=$(git rev-parse origin/main)

  if version_already_shipped "$version"; then
    echo "error: ${version} already shipped (madcontrol-v${version} or webapp-v${version} exists)." >&2
    echo "Bump first: $0 patch --no-tag" >&2
    exit 1
  fi

  if git rev-parse "$tag" >/dev/null 2>&1; then
    local existing
    existing=$(git rev-parse "$tag^{commit}")
    if [[ "$existing" != "$commit" ]]; then
      echo "error: local tag ${tag} points at ${existing}, origin/main is ${commit}." >&2
      echo "Delete the local tag (git tag -d ${tag}) if you intend to retarget origin/main." >&2
      exit 1
    fi
  else
    git tag -a "$tag" "$commit" -m "MaD Control ${version}"
  fi

  git push origin "$tag"
  echo "Published ${tag} at origin/main (${commit:0:12})."
  echo "Pages will deploy MaD Control ${version} and a GitHub Release will be created."
}

bump() {
  local spec=$1
  local no_tag=$2
  local do_push=$3

  case "$spec" in
    patch|minor|major) ;;
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
      echo "error: version must be patch, minor, major, or x.y.z (got ${spec})" >&2
      exit 1
      ;;
  esac

  require_clean

  if [[ -n $(git tag --list "$(tag_name "$spec")") && "$spec" != patch && "$spec" != minor && "$spec" != major ]]; then
    echo "error: tag $(tag_name "$spec") already exists locally." >&2
    exit 1
  fi

  local old
  old=$(pkg_version)

  # npm version updates package.json + package-lock.json. --no-git-tag-version
  # leaves the git commit/tag to us so the prefix and message stay consistent
  # when this is run from a subdirectory of the monorepo.
  (
    cd "$CONTROL_DIR"
    npm version "$spec" --no-git-tag-version >/dev/null
  )
  local version
  version=$(pkg_version)
  local tag
  tag=$(tag_name "$version")

  if version_already_shipped "$version" || git rev-parse "$tag" >/dev/null 2>&1; then
    echo "error: ${version} already shipped (tag ${tag} or webapp-v${version} exists)." >&2
    git checkout -- "$PKG" "$LOCK"
    exit 1
  fi

  git add "$PKG" "$LOCK"
  git commit -m "chore(control): release MaD Control ${version}"

  if [[ "$no_tag" -eq 0 ]]; then
    git tag -a "$tag" -m "MaD Control ${version}"
  fi

  echo "MaD Control ${old} → ${version}"
  if [[ "$no_tag" -eq 1 ]]; then
    echo "Committed version bump (no tag)."
    echo "Next: push this branch, merge to main, then: $0 --publish"
  else
    echo "Tagged ${tag}."
    echo "Next: git push origin HEAD && git push origin ${tag}"
    echo "Or, if main is protected: push this branch, merge, then: $0 --publish"
  fi

  if [[ "$do_push" -eq 1 ]]; then
    git push -u origin HEAD
    if [[ "$no_tag" -eq 0 ]]; then
      git push origin "$tag"
    fi
  fi
}

NO_TAG=0
DO_PUSH=0
SPEC=""
MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --check)
      MODE=check
      shift
      ;;
    --publish)
      MODE=publish
      shift
      ;;
    --no-tag)
      NO_TAG=1
      shift
      ;;
    --push)
      DO_PUSH=1
      shift
      ;;
    patch|minor|major|[0-9]*.[0-9]*.[0-9]*)
      if [[ -n "$SPEC" ]]; then
        echo "error: extra argument $1" >&2
        exit 1
      fi
      SPEC=$1
      MODE=bump
      shift
      ;;
    *)
      echo "error: unknown argument $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "${MODE:-}" in
  check) check ;;
  publish) publish ;;
  bump) bump "$SPEC" "$NO_TAG" "$DO_PUSH" ;;
  *)
    echo "error: pass patch|minor|major|x.y.z, --publish, or --check" >&2
    usage >&2
    exit 1
    ;;
esac
