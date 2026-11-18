# Changelog

Notable changes to Kothalipi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

## 1.0.0 - 2026-11-18

Kothalipi starts as a fork of [Speech2Text](https://github.com/kavehtehrani/speech2text-extension) 1.4.3 by Kaveh
Tehrani.

### Changed

- Renamed the project to Kothalipi. The extension is now `kothalipi@mohiuddin200.github.io`, the service is
  `kothalipi-service`, and the D-Bus name is `io.github.mohiuddin200.Kothalipi`. It installs alongside Speech2Text
  rather than replacing it.
- Replaced the recording dialog with a floating pill at the bottom of the screen that shows recording, transcribing,
  done and error states.
- Redesigned the settings, setup and shortcut dialogs.
- Text is now handed to the focused field directly, with paste and clipboard as fallbacks, so insertion also works on
  Wayland.

### Added

- A new top-bar icon and project logo: voice bars running into a text cursor.
- An optional live preview of your words while you speak.
- Voice level bars in the pill while recording.
- A setting to hide the pill when idle.
- Test-shell tooling for contributors: `make check`, `make shots` and `make dev`.
- Contributor documentation, issue and pull request templates, and CI.
