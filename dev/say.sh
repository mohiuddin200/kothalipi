#!/usr/bin/env bash
# Ask the installed service to read text aloud, without going through the
# extension. Plays on your speakers.
#
#   dev/say.sh                      a sample sentence
#   dev/say.sh "Some text" [voice] [speed]
#   dev/say.sh --stop
set -euo pipefail

call() {
    local method="$1"
    shift
    gdbus call --session --dest io.github.mohiuddin200.Kothalipi \
        --object-path /io/github/mohiuddin200/Kothalipi \
        --method "io.github.mohiuddin200.Kothalipi.$method" "$@"
}

if [ "${1:-}" = "--stop" ]; then
    call StopSpeaking ""
    exit 0
fi

TEXT="${1:-Kothalipi can read text aloud. Select some text in any app and press Super, Alt and A.}"
call Speak "$TEXT" "${2:-af_heart}" "${3:-1.0}"
