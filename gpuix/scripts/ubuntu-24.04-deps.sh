#!/usr/bin/env bash
# Runtime libraries for the GPUIX client on Ubuntu 24.04 LTS (Noble).
# GPUI paints with Vulkan on Linux. This does not replace the Windows DirectX path.
set -euo pipefail

if [[ ! -r /etc/os-release ]]; then
  echo "Need Linux with /etc/os-release." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${VERSION_CODENAME:-}" != "noble" && "${VERSION_ID:-}" != "24.04" ]]; then
  echo "This script targets Ubuntu 24.04 LTS (Noble). Found ${PRETTY_NAME:-unknown}." >&2
  echo "Install libvulkan1, a Vulkan ICD, and python3 from your distro, or continue at your own risk." >&2
  if [[ "${ONETOOL_FORCE_DEPS:-}" != "1" ]]; then
    exit 1
  fi
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Re-run with sudo: sudo bash gpuix/scripts/ubuntu-24.04-deps.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Loader + ICD + windowing. mesa-vulkan-drivers covers Intel/AMD and llvmpipe.
# NVIDIA users should also have their proprietary driver (provides a Vulkan ICD).
apt-get install -y --no-install-recommends \
  python3 \
  libvulkan1 \
  mesa-vulkan-drivers \
  vulkan-tools \
  libwayland-client0 \
  libxkbcommon0 \
  libxkbcommon-x11-0 \
  libfontconfig1 \
  libx11-xcb1 \
  libxcb1 \
  libzstd1 \
  libssl3t64

echo
echo "Ubuntu 24.04 GPUIX runtime packages installed."
echo "Check Vulkan: vulkaninfo --summary"
echo "Run the client:  cd gpuix && bun install && bun run dev"
echo "Windows users: skip this script. DirectX path is documented in gpuix/PLATFORMS.md."
