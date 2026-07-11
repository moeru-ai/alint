#!/bin/sh

set -u

BASE_URL="${BASE_URL:-https://github.com/alint-js/alint/releases}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
VERSION="${VERSION:-latest}"
SUPPORTED_TARGETS="aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu aarch64-unknown-linux-musl x86_64-unknown-linux-musl x86_64-pc-windows-msvc"

error() {
	printf 'error: %s\n' "$*" >&2
}

info() {
	printf '%s\n' "$*" >&2
}

has() {
	command -v "$1" >/dev/null 2>&1
}

usage() {
	cat <<EOF
Install alint from GitHub release artifacts.

Usage:
  install.sh [options]

Options:
  -a, --arch <arch>       Override detected arch: aarch64, x86_64
  -b, --bin-dir <dir>     Install directory [default: ${BIN_DIR}]
  -B, --base-url <url>    Release base URL [default: ${BASE_URL}]
  -f, -y, --yes           Skip confirmation prompt
  -l, --libc <libc>       Override Linux libc: gnu, musl
  -p, --platform <name>   Override detected platform: apple-darwin, unknown-linux, pc-windows-msvc
  -v, --version <version> Install version, e.g. v0.1.0 or latest [default: ${VERSION}]
  -h, --help              Show this help
EOF
}

detect_arch() {
	arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

	case "$arch" in
	arm64 | aarch64)
		printf 'aarch64'
		;;
	x86_64 | amd64)
		printf 'x86_64'
		;;
	*)
		error "Unsupported architecture: $arch"
		exit 1
		;;
	esac
}

detect_platform() {
	platform="$(uname -s | tr '[:upper:]' '[:lower:]')"

	case "$platform" in
	darwin)
		printf 'apple-darwin'
		;;
	linux)
		printf 'unknown-linux'
		;;
	msys* | mingw* | cygwin* | windows_nt)
		printf 'pc-windows-msvc'
		;;
	*)
		error "Unsupported platform: $platform"
		exit 1
		;;
	esac
}

detect_libc() {
	if [ "${PLATFORM}" != "unknown-linux" ]; then
		printf ''
		return
	fi

	if has ldd && ldd --version 2>&1 | grep -qi musl; then
		printf 'musl'
		return
	fi

	printf 'gnu'
}

target_from_parts() {
	if [ "$2" = "unknown-linux" ]; then
		printf '%s-%s-%s' "$1" "$2" "$3"
		return
	fi

	printf '%s-%s' "$1" "$2"
}

archive_ext_for_target() {
	case "$1" in
	*-pc-windows-msvc)
		printf 'zip'
		;;
	*)
		printf 'tar.gz'
		;;
	esac
}

is_supported_target() {
	target="$1"

	for supported in $SUPPORTED_TARGETS; do
		if [ "$supported" = "$target" ]; then
			return 0
		fi
	done

	return 1
}

download() {
	output="$1"
	url="$2"

	if has curl; then
		curl -fsSL "$url" -o "$output"
	elif has wget; then
		wget -q "$url" -O "$output"
	elif has fetch; then
		fetch --quiet --output="$output" "$url"
	else
		error 'No HTTP downloader found. Install curl, wget, or fetch.'
		return 1
	fi
}

checksum() {
	file="$1"

	if has sha256sum; then
		sha256sum "$file" | awk '{ print $1 }'
	elif has shasum; then
		shasum -a 256 "$file" | awk '{ print $1 }'
	else
		error 'No SHA-256 tool found. Install sha256sum or shasum.'
		return 1
	fi
}

verify_checksum() {
	file="$1"
	checksum_file="$2"
	expected="$(awk '{ print $1 }' "$checksum_file")"
	actual="$(checksum "$file")"

	if [ "$expected" != "$actual" ]; then
		error "Checksum mismatch for $file"
		error "expected: $expected"
		error "actual:   $actual"
		return 1
	fi
}

unpack() {
	archive="$1"
	destination="$2"

	case "$archive" in
	*.tar.gz)
		tar -xzf "$archive" -C "$destination"
		;;
	*.zip)
		if ! has unzip; then
			error 'unzip is required to unpack Windows release artifacts.'
			return 1
		fi
		unzip -q -o "$archive" -d "$destination"
		;;
	*)
		error "Unsupported archive format: $archive"
		return 1
		;;
	esac
}

install_executable() {
	source="$1"
	destination="$2"
	destination_dir="$(dirname "$destination")"

	if [ -d "$destination_dir" ] && [ -w "$destination_dir" ]; then
		mv "$source" "$destination"
		chmod +x "$destination"
		return
	fi

	if ! has sudo; then
		error "Install directory is not writable and sudo is unavailable: $destination_dir"
		return 1
	fi

	sudo mkdir -p "$destination_dir"
	sudo mv "$source" "$destination"
	sudo chmod +x "$destination"
}

tmpdir() {
	if has mktemp; then
		mktemp -d 2>/dev/null || mktemp -d -t alint
	else
		printf '/tmp/alint-install.%s' "$$"
	fi
}

confirm() {
	if [ -n "${YES:-}" ]; then
		return 0
	fi

	printf 'Install alint %s for %s into %s? [y/N] ' "$VERSION" "$TARGET" "$BIN_DIR" >&2
	read -r response

	case "$response" in
	y | Y | yes | YES)
		return 0
		;;
	*)
		return 1
		;;
	esac
}

while [ "$#" -gt 0 ]; do
	case "$1" in
	-a | --arch)
		ARCH="$2"
		shift 2
		;;
	-b | --bin-dir)
		BIN_DIR="$2"
		shift 2
		;;
	-B | --base-url)
		BASE_URL="$2"
		shift 2
		;;
	-f | -y | --force | --yes)
		YES=1
		shift
		;;
	-l | --libc)
		LIBC="$2"
		shift 2
		;;
	-p | --platform)
		PLATFORM="$2"
		shift 2
		;;
	-v | --version)
		VERSION="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		error "Unknown option: $1"
		usage
		exit 1
		;;
	esac
done

ARCH="${ARCH:-$(detect_arch)}"
PLATFORM="${PLATFORM:-$(detect_platform)}"
LIBC="${LIBC:-$(detect_libc)}"
TARGET="$(target_from_parts "$ARCH" "$PLATFORM" "$LIBC")"

if ! is_supported_target "$TARGET"; then
	error "No release artifact is configured for target: $TARGET"
	exit 1
fi

ARCHIVE="alint-${TARGET}.$(archive_ext_for_target "$TARGET")"
CHECKSUM_FILE="${ARCHIVE}.sha256"
if [ "$VERSION" = "latest" ]; then
	URL="${BASE_URL}/latest/download/${ARCHIVE}"
	CHECKSUM_URL="${BASE_URL}/latest/download/${CHECKSUM_FILE}"
else
	URL="${BASE_URL}/download/${VERSION}/${ARCHIVE}"
	CHECKSUM_URL="${BASE_URL}/download/${VERSION}/${CHECKSUM_FILE}"
fi

if ! confirm; then
	info 'Installation cancelled.'
	exit 0
fi

WORK_DIR="$(tmpdir)"
ARCHIVE_PATH="${WORK_DIR}/${ARCHIVE}"
CHECKSUM_PATH="${WORK_DIR}/${CHECKSUM_FILE}"

cleanup() {
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK_DIR"
info "Downloading ${URL}"
download "$ARCHIVE_PATH" "$URL"
download "$CHECKSUM_PATH" "$CHECKSUM_URL"
verify_checksum "$ARCHIVE_PATH" "$CHECKSUM_PATH"
unpack "$ARCHIVE_PATH" "$WORK_DIR"

EXE_NAME="alint"
if [ "$PLATFORM" = "pc-windows-msvc" ]; then
	EXE_NAME="alint.exe"
fi

if [ ! -f "${WORK_DIR}/${EXE_NAME}" ]; then
	error "Archive did not contain ${EXE_NAME}"
	exit 1
fi

install_executable "${WORK_DIR}/${EXE_NAME}" "${BIN_DIR}/${EXE_NAME}"
info "Installed ${BIN_DIR}/${EXE_NAME}"
