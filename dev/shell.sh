#!/usr/bin/env bash
# Run the fork in a throwaway GNOME Shell that cannot touch the real session:
# it gets its own D-Bus session and its own dconf database (kothalipi_dev).
#
#   dev/shell.sh check        headless: load the extension, report its state and JS errors
#   dev/shell.sh shots DIR    headless: play the pill through every state, save PNGs to DIR
#   dev/shell.sh dev          windowed shell for trying the UI (needs: sudo apt install mutter-dev-bin)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-check}"
UUID="$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$REPO/src/metadata.json")"
LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"
SHOTS_UUID="kothalipi-shots@dev.local"

if [ "$(readlink -f "$LINK" 2>/dev/null)" != "$REPO/src" ]; then
    echo "Extension is not linked at $LINK. Run: make install" >&2
    exit 1
fi

if [ -z "${KOTHALIPI_INNER:-}" ]; then
    LOG="$(mktemp -t kothalipi-dev.XXXXXX.log)"
    export KOTHALIPI_INNER=1 KOTHALIPI_LOG="$LOG"
    if [ "$MODE" = "dev" ]; then
        exec dbus-run-session -- "$0" "$@"
    fi
    # The private bus and its services are chatty; keep them in the log and
    # report on fd 3.
    exec dbus-run-session -- "$0" "$@" 3>&1 >>"$LOG" 2>&1
fi

export DCONF_PROFILE="$REPO/dev/dconf-profile"
glib-compile-schemas "$REPO/src/schemas"
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"

start_headless() {
    # Nothing in a headless run may record: point PulseAudio clients (ffmpeg
    # in the service) at a socket that does not exist.
    export PULSE_SERVER="unix:/nonexistent/kothalipi-dev-no-audio"
    gnome-shell --headless --no-x11 --wayland-display "kothalipi-dev-$$" \
        --virtual-monitor 1280x720 >>"$KOTHALIPI_LOG" 2>&1 &
    SHELL_PID=$!
    trap 'kill $SHELL_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 30); do
        gnome-extensions list >/dev/null 2>&1 && break
        sleep 1
    done
}

# Prints the extension's state and any JS errors; fails unless it is ACTIVE
# and error-free.
report() {
    local info errors
    info="$(gnome-extensions info "$UUID" 2>&1 || true)"
    errors="$(grep -E "JS ERROR|$UUID|kothalipi-shots|shots:" "$KOTHALIPI_LOG" | grep -v "Activating service" || true)"
    {
        echo "$info" | grep -E "Name:|Version:|State:|Error:" || echo "$info"
        if [ -n "$errors" ]; then
            echo "--- shell log ---"
            echo "$errors"
        fi
        echo "Full log: $KOTHALIPI_LOG"
    } >&3
    echo "$info" | grep -q "State: ACTIVE" && ! echo "$errors" | grep -qE "JS ERROR|CRITICAL"
}

case "$MODE" in
check)
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
    start_headless
    sleep 3
    report
    ;;
shots)
    OUT="$(mkdir -p "${2:?usage: shell.sh shots DIR}" && cd "$2" && pwd)"
    rm -f "$OUT"/*.png "$OUT"/*.txt "$OUT"/*.ready "$OUT"/finished
    export XDG_DATA_DIRS="$REPO/dev/data:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    export KOTHALIPI_SHOTS_DIR="$OUT" KOTHALIPI_TARGET_UUID="$UUID"
    # The harness opens a test text field inside the headless shell only.
    export KOTHALIPI_WAYLAND_DISPLAY="kothalipi-dev-$$" KOTHALIPI_TEXTFIELD="$REPO/dev/textfield.js" \
        KOTHALIPI_TERMFIELD="$REPO/dev/termfield.js"
    # Match the real desktop: Ubuntu's font and an auto-hiding bottom dock.
    dconf write /org/gnome/desktop/interface/font-name "'Ubuntu Sans 11'"
    dconf write /org/gnome/shell/extensions/dash-to-dock/dock-position "'BOTTOM'"
    dconf write /org/gnome/shell/extensions/dash-to-dock/dock-fixed false
    dconf write /org/gnome/shell/extensions/dash-to-dock/extend-height false
    dconf write /org/gnome/shell/enabled-extensions \
        "['$UUID', '$SHOTS_UUID', 'ubuntu-dock@ubuntu.com']"
    start_headless
    for _ in $(seq 1 150); do
        [ -e "$OUT/finished" ] && break
        sleep 1
    done
    status=0
    report || status=1
    {
        echo "Harness: $(cat "$OUT/finished" 2>/dev/null || echo "did not finish")"
        echo "Screenshots: $(find "$OUT" -name '*.png' | wc -l) in $OUT"
    } >&3
    [ "$(cat "$OUT/finished" 2>/dev/null)" = "ok" ] || status=1
    exit $status
    ;;
dev)
    if [ ! -x /usr/libexec/mutter-devkit ]; then
        echo "The GNOME development window is not installed. Run: sudo apt install mutter-dev-bin" >&2
        exit 1
    fi
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
    exec gnome-shell --devkit --wayland-display "kothalipi-dev-$$"
    ;;
*)
    echo "Usage: $0 check|shots DIR|dev" >&2
    exit 2
    ;;
esac
