# Security Policy

## Supported versions

Kothalipi is in early development. Security fixes are made on the `master` branch only.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately with GitHub's vulnerability reporting: open the repository's
[Security tab](https://github.com/mohiuddin200/kothalipi/security) and choose **Report a vulnerability**.

Include, as far as you can:

- what the problem is and what an attacker could do with it,
- steps to reproduce it,
- your GNOME Shell version, distribution and session type (Wayland or X11),
- the Kothalipi version or commit.

You can expect an acknowledgement within a week. Once a fix is ready it is released, and you are credited in the
changelog unless you prefer otherwise.

## What is in scope

Kothalipi records from your microphone, runs a local background service on the D-Bus session bus, writes to the
clipboard and inserts text into the focused window. Reports about any of these are welcome, for example:

- another local application triggering a recording or reading a transcript without the user's knowledge,
- audio or transcripts being stored or sent somewhere they should not be,
- the service installer running or downloading something unexpected.

Kothalipi is designed to do all speech recognition on your machine. If you find it sending audio or text to a remote
server, treat that as a vulnerability and report it.

## Out of scope

Vulnerabilities in Whisper, PyTorch, FFmpeg or GNOME Shell should go to those projects. If Kothalipi's use of them
makes things worse, report it here too.
