#!/usr/bin/env bash

set -euo pipefail

PACKAGE_NAME="com.gamelovers.mcp-unity"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FORCE=0
UPDATE_GITIGNORE=1

usage() {
  cat <<'EOF'
Usage:
  scripts/link-package-to-project.sh [--force] [--skip-gitignore] <unity-project-path>

Description:
  Creates a development symlink from the current mcp-unity source repository into
  the target Unity project's Packages/ directory.

Options:
  --force           Replace an existing package directory or symlink at the target path.
  --skip-gitignore  Do not update the target project's .gitignore.
EOF
}

ensure_gitignore_entry() {
  local project_root="$1"
  local gitignore_path="${project_root}/.gitignore"
  local marker="# Local MCP Unity package"
  local entry="/Packages/${PACKAGE_NAME}"

  if [[ ! -f "${gitignore_path}" ]]; then
    printf "%s\n%s\n" "${marker}" "${entry}" > "${gitignore_path}"
    return
  fi

  if grep -Fqx "${entry}" "${gitignore_path}"; then
    return
  fi

  {
    printf "\n%s\n" "${marker}"
    printf "%s\n" "${entry}"
  } >> "${gitignore_path}"
}

TARGET_PROJECT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --skip-gitignore)
      UPDATE_GITIGNORE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "${TARGET_PROJECT}" ]]; then
        echo "error: only one Unity project path can be provided" >&2
        usage >&2
        exit 1
      fi
      TARGET_PROJECT="$1"
      shift
      ;;
  esac
done

if [[ -z "${TARGET_PROJECT}" ]]; then
  usage >&2
  exit 1
fi

TARGET_PROJECT="$(cd "${TARGET_PROJECT}" && pwd)"
PACKAGES_DIR="${TARGET_PROJECT}/Packages"
TARGET_PATH="${PACKAGES_DIR}/${PACKAGE_NAME}"

if [[ ! -d "${PACKAGES_DIR}" ]]; then
  echo "error: target Unity project does not contain a Packages directory: ${PACKAGES_DIR}" >&2
  exit 1
fi

if [[ ! -f "${SOURCE_ROOT}/package.json" ]]; then
  echo "error: source repository does not look like mcp-unity: ${SOURCE_ROOT}" >&2
  exit 1
fi

if [[ -e "${TARGET_PATH}" || -L "${TARGET_PATH}" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    echo "error: target path already exists: ${TARGET_PATH}" >&2
    echo "rerun with --force to replace it" >&2
    exit 1
  fi

  rm -rf "${TARGET_PATH}"
fi

ln -s "${SOURCE_ROOT}" "${TARGET_PATH}"

if [[ "${UPDATE_GITIGNORE}" -eq 1 ]]; then
  ensure_gitignore_entry "${TARGET_PROJECT}"
fi

cat <<EOF
Linked development package:
  source: ${SOURCE_ROOT}
  target: ${TARGET_PATH}

Next steps:
  1. Open the Unity project so it recompiles the embedded package.
  2. In another terminal, run:
       cd ${SOURCE_ROOT}/Server~
       npm install
       npm run watch
EOF
