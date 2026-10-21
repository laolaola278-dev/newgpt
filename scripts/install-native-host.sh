#!/usr/bin/env bash
# GPT++ Native Host installer for macOS and Linux (development).
#
# Usage:
#   ./scripts/install-native-host.sh <32-char-extension-id>

set -euo pipefail

EXT_ID="${1:-}"
if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: $0 <32-char-chrome-extension-id>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_PROJECT="$REPO_ROOT/native-host"
HOST_NAME="com.gptpp.native"
INSTALL_DIR="${GPTPP_INSTALL_DIR:-$HOME/.local/share/gptpp/native-host}"

echo "==> cargo build --release"
cargo build --release --manifest-path "$HOST_PROJECT/Cargo.toml"

BIN_SRC="$HOST_PROJECT/target/release/gptpp-native"
if [[ ! -f "$BIN_SRC" ]]; then
  echo "error: built binary not found at $BIN_SRC" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
BIN_DEST="$INSTALL_DIR/gptpp-native"
cp "$BIN_SRC" "$BIN_DEST"
chmod 755 "$BIN_DEST"

TEMPLATE_PATH="$HOST_PROJECT/manifest/$HOST_NAME.template.json"
MANIFEST_CONTENT="$(python3 -c '
import sys
tpl, bin_path, ext_id = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(tpl, encoding="utf-8").read()
text = text.replace("__NATIVE_HOST_PATH__", bin_path).replace("__EXTENSION_ID__", ext_id)
print(text, end="")
' "$TEMPLATE_PATH" "$BIN_DEST" "$EXT_ID")"

case "$(uname -s)" in
  Darwin)
    TARGET_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGET_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    )
    ;;
  *)
    echo "error: unsupported platform $(uname -s); use scripts/install-native-host.ps1 on Windows" >&2
    exit 1
    ;;
esac

for dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "$dir"
  printf '%s' "$MANIFEST_CONTENT" > "$dir/$HOST_NAME.json"
  echo "  registered: $dir/$HOST_NAME.json"
done

echo ""
echo "GPT++ native host installed:"
echo "  host   : $HOST_NAME"
echo "  binary : $BIN_DEST"
echo "  origin : chrome-extension://$EXT_ID/"
