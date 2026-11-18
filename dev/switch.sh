#!/usr/bin/env bash
# Choose which copy runs in the real desktop session. Only one may be enabled:
# Kothalipi and the upstream extension bind the same keyboard shortcut.
#
#   dev/switch.sh fork|original [--dry-run]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK="$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$REPO/src/metadata.json")"
ORIGINAL="gnome-speech2text@kaveh.page"

case "${1:-}" in
fork) ON="$FORK" OFF="$ORIGINAL" ;;
original) ON="$ORIGINAL" OFF="$FORK" ;;
*) echo "Usage: $0 fork|original [--dry-run]" >&2; exit 2 ;;
esac

CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
NEW="$(python3 -I -c '
import ast, sys
cur, on, off = sys.argv[1:4]
items = ast.literal_eval(cur.removeprefix("@as "))
print([on] + [u for u in items if u not in (on, off)])
' "$CURRENT" "$ON" "$OFF")"

if [ "${2:-}" = "--dry-run" ]; then
    echo "$NEW"
    exit 0
fi

gsettings set org.gnome.shell enabled-extensions "$NEW"
echo "Enabled:  $ON"
echo "Disabled: $OFF"
if ! gnome-extensions list | grep -qx "$ON"; then
    echo "This session has not loaded $ON yet. Log out and back in to start it."
fi
