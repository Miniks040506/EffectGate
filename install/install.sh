#!/usr/bin/env sh
set -eu

version="1.0.0"
check="false"
for argument in "$@"; do
  case "$argument" in
    --check) check="true" ;;
    1.0.0) version="$argument" ;;
    *) echo "Usage: install.sh [1.0.0] [--check]" >&2; exit 2 ;;
  esac
done

expected_sha256="44aa32776701e22d8dab8e76307ea9013fd528a39493a63419545a3aed4f9c20"
package_name="effectgate-preview-$version.tgz"
package_url="https://github.com/Miniks040506/EffectGate/releases/download/v$version/$package_name"

command -v node >/dev/null 2>&1 || { echo "Node.js 24 or newer is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required to install EffectGate." >&2; exit 1; }
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge 24 ] || { echo "EffectGate requires Node.js 24 or newer." >&2; exit 1; }

if [ "$check" = "true" ]; then
  printf '{"version":"%s","package_url":"%s","sha256":"%s","node_major":%s}\n' \
    "$version" "$package_url" "$expected_sha256" "$node_major"
  exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required to download EffectGate." >&2; exit 1; }
temporary_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
work=$(mktemp -d "$temporary_root/effectgate-install.XXXXXX")
case "$work" in
  "$temporary_root"/effectgate-install.*) ;;
  *) echo "Unsafe temporary installer path." >&2; exit 1 ;;
esac
cleanup() {
  case "$work" in
    "$temporary_root"/effectgate-install.*) rm -rf -- "$work" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

package="$work/$package_name"
curl --fail --location --silent --show-error "$package_url" --output "$package"
actual_sha256=$(node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$package")
[ "$actual_sha256" = "$expected_sha256" ] || { echo "EffectGate package checksum mismatch." >&2; exit 1; }

npm install --global --ignore-scripts --no-audit --no-fund "$package"
installed_version=$(effectgate --version)
[ "$installed_version" = "$version" ] || { echo "Installed EffectGate version verification failed." >&2; exit 1; }
printf 'EffectGate %s installed and verified.\n' "$installed_version"
