# Contributing to Kothalipi

Thank you for helping. This guide covers how to report problems, how to set up a development copy, and what a good
pull request looks like.

By taking part you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting a bug

Open a [bug report](https://github.com/mohiuddin200/kothalipi/issues/new/choose) and include:

- GNOME Shell version: `gnome-shell --version`
- Distribution and version: `lsb_release -a`
- Session type: `echo $XDG_SESSION_TYPE`
- What you did, what you expected, and what happened
- Logs: `journalctl -b /usr/bin/gnome-shell | grep -i kothalipi`
- For a GNOME Shell crash: the report written by `./debug-crash.sh`

Logs can contain text you dictated. Read them before you paste them.

For security problems, do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Suggesting a feature

Open a [feature request](https://github.com/mohiuddin200/kothalipi/issues/new/choose). Describe the problem you want
solved before the solution you have in mind. For anything large, please open an issue before writing code so the
approach can be agreed first.

## Project layout

| Path | What is there |
| --- | --- |
| `src/` | The GNOME Shell extension (GJS, ES modules). |
| `src/lib/` | The pill, dialogs, recording controller, D-Bus client. |
| `src/schemas/` | Settings schema. |
| `src/icons/` | The top-bar icon. |
| `service/` | The Python background service and its installer. |
| `dev/` | Test-shell scripts and the screenshot harness. |
| `images/` | Logo and README screenshots. |

## Development setup

You need GNOME Shell 46 or later and the packages listed in the [README](./README.md#requirements).

```bash
git clone https://github.com/mohiuddin200/kothalipi.git
cd kothalipi
make install                                  # link src/ into GNOME Shell, compile the schema
./service/install-service.sh --local          # install the background service from this clone
```

### Test without touching your real session

The extension directory is a link to `src/`, but a running GNOME Shell does not reload changed code. Instead of
logging out after every edit, use the throwaway test shells. Each one gets its own D-Bus session and its own settings
database, so it cannot change your real desktop.

| Command | What it does |
| --- | --- |
| `make check` | Loads the extension in a headless shell and reports its state and any JavaScript errors. |
| `make shots SHOTS_DIR=/some/dir` | Plays the pill through every state in a headless shell and saves screenshots. |
| `make dev` | Opens a windowed test shell you can click around in. Needs `mutter-dev-bin`. |

Run `make check` before every pull request. If you changed anything visible, run `make shots` and look at the images.

To try your changes in your real session, log out and back in (Wayland) or restart the shell (X11).

### Changing the service

After editing anything under `service/`, reinstall it and restart the running copy:

```bash
./service/install-service.sh --local          # add --gpu --whisper-model <name> if you use them
pkill -f kothalipi-service                    # D-Bus starts it again on the next request
```

Re-running the installer rebuilds the service's virtual environment from scratch.

## Code guidelines

**Extension (JavaScript)**

- Follow the [GNOME Shell extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).
  The extension is meant for extensions.gnome.org, so these are requirements.
- Everything created in `enable()` must be destroyed or disconnected in `disable()`: actors, signal handlers,
  timeouts, key bindings.
- Keep heavy work out of the extension. Recording, transcription and anything that needs extra binaries belong in
  the service.
- Match the style of the file you are editing: two-space indentation, double quotes, semicolons.
- CSS classes start with `kothalipi-`, because GNOME Shell stylesheets share one namespace.
- The top-bar icon is a symbolic SVG. Use filled shapes only; strokes are not recoloured by the shell.

**Service (Python)**

- Keep it compatible with Python 3.8 to 3.13.
- New D-Bus methods or signals must be added in three places: `service/src/kothalipi_service/service.py`,
  `service/data/io.github.mohiuddin200.Kothalipi.xml`, and the interface XML in `src/lib/dbusManager.js`.

**User-facing text**

- Plain words, sentence case, no jargon. Say what happens: "Insert text at the cursor", not "Auto-insert mode".

## Pull requests

1. Fork the repository and create a branch from `master`.
2. Keep each pull request to one change. Smaller is easier to review.
3. Run `make check`. Add before and after screenshots for visible changes.
4. Describe what changed and why, and link the issue it closes.
5. Add a line to [CHANGELOG.md](./CHANGELOG.md) under "Unreleased" for anything a user would notice.

## License

Kothalipi is licensed under [GPL-3.0-or-later](./LICENSE). By contributing, you agree that your contribution is
licensed under the same terms.
