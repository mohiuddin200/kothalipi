<p align="center"><img src="./images/kothalipi-logo.svg" width="96" alt="Kothalipi logo"></p>

<h1 align="center">Kothalipi</h1>

<p align="center">
  Dictation for GNOME Shell. Speak, and your words appear where you are typing.<br>
  Speech recognition runs on your own machine with <a href="https://github.com/openai/whisper">Whisper</a>.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9350-4A86CF" alt="GNOME Shell 46 to 50">
  <a href="https://github.com/mohiuddin200/kothalipi/actions/workflows/ci.yml"><img src="https://github.com/mohiuddin200/kothalipi/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

![Kothalipi inserting dictated text into a text field](./images/screenshot-inserted.png)

**Kothalipi** (কথালিপি) is Bengali for "speech-writing".

> **Status:** early. Kothalipi is not yet on extensions.gnome.org and its service is not yet on PyPI.
> For now, install from source as described below.

Kothalipi is a fork of [Speech2Text](https://github.com/kavehtehrani/speech2text-extension) by Kaveh Tehrani, with a
redesigned interface. See [Credits](#credits).

## Features

- **Dictate anywhere.** Press a shortcut, click the pill at the bottom of the screen, or click the top-bar icon.
- **Text goes to your cursor.** Kothalipi hands the text to the focused field directly. If the app does not accept
  that, it pastes instead; if nothing is focused, the text is left on the clipboard.
- **Words while you speak.** An optional rough preview appears above the pill during recording.
- **Private by design.** Audio is recorded and transcribed locally. Nothing is sent to a server.
- **Many languages.** Whatever your chosen Whisper model supports.
- **CPU or GPU.** Runs on CPU by default; NVIDIA CUDA is supported for larger models.

## How it looks

| Recording | Transcribing |
| --- | --- |
| ![The pill while recording, with a cancel button, voice bars and a stop button](./images/pill-recording.png) | ![The pill while transcribing](./images/pill-processing.png) |
| **Done** | **Something went wrong** |
| ![The pill after copying the text](./images/pill-done.png) | ![The pill reporting that no speech was detected](./images/pill-error.png) |

The pill follows your light or dark desktop, and the top bar gets a small icon:

| Light desktop | Top-bar icon |
| --- | --- |
| ![The pill on a light background](./images/pill-light.png) | ![The Kothalipi icon in the GNOME top bar](./images/panel-icon.png) |

These images come from the project's screenshot harness (`make shots`), which runs the extension in a test shell.

## How it works

Kothalipi has two parts:

1. **The GNOME Shell extension** (`src/`): the pill, the top-bar icon, the shortcut and the settings.
2. **A background service** (`service/`): records audio with FFmpeg and transcribes it with Whisper.

They talk over D-Bus (`io.github.mohiuddin200.Kothalipi`). The service is installed separately, into its own Python
virtual environment, because GNOME extensions are not allowed to bundle that kind of code.

## Requirements

- GNOME Shell 46 to 50
- Python 3.8 to 3.13, with the `venv` module
- FFmpeg
- A clipboard tool: `wl-clipboard` on Wayland, `xclip` or `xsel` on X11
- `xdotool` on X11 only

On Ubuntu or Debian:

```bash
sudo apt install ffmpeg python3-venv wl-clipboard
```

The service installer checks these and tells you what is missing.

## Installation

### Quick setup with an AI agent

If you use a coding agent such as Claude Code, copy this prompt into it. It checks your hardware, picks a suitable
Whisper model, and does the setup for you. To install by hand instead, follow the three steps below.

```text
Set up the Kothalipi dictation extension for GNOME Shell on this computer.
Source and instructions: https://github.com/mohiuddin200/kothalipi (read the README first).

1. Check that this is Linux running GNOME Shell 46 to 50 (gnome-shell --version) and note whether the
   session is Wayland or X11 (echo $XDG_SESSION_TYPE). If it is not GNOME, stop and tell me.
2. Check my hardware: CPU threads (nproc), memory (free -g), free disk space in my home folder
   (df -h ~), and whether there is an NVIDIA GPU with working drivers and how much memory it has
   (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader).
3. Choose the Whisper model and device from what you found:
   - NVIDIA GPU with 8 GB or more of GPU memory, and 10 GB free disk: --gpu --whisper-model medium
   - NVIDIA GPU with 4 to 8 GB of GPU memory, and 10 GB free disk:    --gpu --whisper-model small
   - No usable NVIDIA GPU (or less than 4 GB, or not enough disk), running on CPU:
       12 or more CPU threads and 16 GB or more memory:  --whisper-model small
       4 or more CPU threads and 8 GB or more memory:    --whisper-model base
       anything less:                                    --whisper-model tiny
   CPU mode needs about 4 GB of free disk. If there is less, stop and tell me.
   Tell me in two lines what hardware you found and which model you chose and why, then continue
   without waiting for an answer.
4. Check for git, make, ffmpeg, Python 3.8 to 3.13 with the venv module, and a clipboard tool
   (wl-clipboard on Wayland; xclip and xdotool on X11). List anything missing and ask me before
   running any sudo command to install it.
5. Clone the repository to ~/.local/src/kothalipi (or update it with git pull if it is already there).
   It must stay there, because the extension is linked from it.
6. In the clone, run: make install
7. Install the background service with the options you chose in step 3:
   ./service/install-service.sh --local --non-interactive <options from step 3>
   This downloads the speech recognition libraries and takes several minutes, longer in GPU mode.
8. Check that the service answers:
   gdbus call --session --dest io.github.mohiuddin200.Kothalipi --object-path /io/github/mohiuddin200/Kothalipi --method io.github.mohiuddin200.Kothalipi.GetServiceStatus
   The reply should start with 'ready'.
9. Run: gnome-extensions enable kothalipi@mohiuddin200.github.io
   On Wayland this fails until I have logged out and back in. That is expected: do not log me out or
   restart my session. Tell me to log out, log back in, and run that command myself.
10. Finish with a short summary: my hardware, the model you installed, anything that failed, and how
    to use it (press Super+Alt+R, speak, press it again; the first dictation is slower because the
    model downloads). Mention that I can switch model later by re-running the installer.

Do not change any other system settings, and do not delete anything outside ~/.local/src/kothalipi.
```

### 1. Install the extension

```bash
git clone https://github.com/mohiuddin200/kothalipi.git
cd kothalipi
make install
```

`make install` links `src/` into `~/.local/share/gnome-shell/extensions/`, so keep the clone where it is.

### 2. Install the service

```bash
./service/install-service.sh --local --whisper-model base
```

This creates `~/.local/share/kothalipi-service` and downloads the speech recognition libraries, which takes a few
minutes. The `base` model on CPU is a good starting point.

To use an NVIDIA GPU and a larger model:

```bash
./service/install-service.sh --local --gpu --whisper-model small
```

Which model to pick is a trade-off between accuracy and speed. As a starting point:

| Your computer | Suggested options |
| --- | --- |
| NVIDIA GPU, 8 GB or more of GPU memory | `--gpu --whisper-model medium` |
| NVIDIA GPU, 4 to 8 GB of GPU memory | `--gpu --whisper-model small` |
| No NVIDIA GPU, 12+ CPU threads and 16+ GB memory | `--whisper-model small` |
| No NVIDIA GPU, 4+ CPU threads and 8+ GB memory | `--whisper-model base` |
| Anything less | `--whisper-model tiny` |

GPU mode needs about 10 GB of free disk space; CPU mode about 4 GB.

Models are `tiny`, `base`, `small`, `medium`, `large` and their variants; see the
[Whisper documentation](https://github.com/openai/whisper#available-models-and-languages). Re-run the installer to
switch between CPU and GPU. More detail is in the [service README](./service/README.md).

### 3. Restart GNOME Shell and enable

- **Wayland:** log out and log back in.
- **X11:** press `Alt+F2`, type `r`, press `Enter`.

Then:

```bash
gnome-extensions enable kothalipi@mohiuddin200.github.io
```

## Usage

1. Put your cursor where you want the text.
2. Press **Super+Alt+R**, or click the pill or the top-bar icon.
3. Speak.
4. Press the shortcut again, or click the red stop button. Click **×** to cancel.

The text is inserted at your cursor. Recording also stops on its own when it reaches the recording limit (60 seconds
by default).

Right-click the top-bar icon for **Settings** and **Setup**.

### Settings

| Setting | What it does |
| --- | --- |
| Dictation shortcut | Press it anywhere to start or stop dictating. |
| Recording limit | Dictation stops on its own after this long. |
| Language | The language you dictate in. Auto-detect can misread your first words. |
| Show words while you speak | A rough preview above the pill. It is not the final text. |
| Insert text at the cursor | When no field is focused, the text is copied instead. |
| Copy to clipboard | Also keep each transcript on the clipboard. |
| Show the pill when idle | A small pill at the bottom of the screen. Click it to dictate. |

## Troubleshooting

**The extension does not appear.** Make sure you restarted GNOME Shell after installing, then check:

```bash
make status
gnome-extensions info kothalipi@mohiuddin200.github.io
```

**Recording does not start, or the Setup dialog keeps appearing.** Check that the service answers:

```bash
gdbus call --session --dest io.github.mohiuddin200.Kothalipi \
  --object-path /io/github/mohiuddin200/Kothalipi \
  --method io.github.mohiuddin200.Kothalipi.GetServiceStatus
```

If it does not, run it by hand to see the error:

```bash
~/.local/share/kothalipi-service/kothalipi-service
```

**Logs:**

```bash
journalctl -f | grep -iE "kothalipi|whisper|ffmpeg"
```

**GNOME Shell crashed.** Run `./debug-crash.sh` afterwards and attach its report to your issue.

## Uninstalling

```bash
gnome-extensions disable kothalipi@mohiuddin200.github.io
make clean   # removes the extension link and the service
```

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md); it explains how to
run the extension in a test shell without touching your real session. Please also read the
[Code of Conduct](./CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](./SECURITY.md).

## Credits

Kothalipi is a fork of [Speech2Text](https://github.com/kavehtehrani/speech2text-extension) by
[Kaveh Tehrani](https://github.com/kavehtehrani) and its contributors. The background service, the D-Bus design and
the installer come from that project. Thank you.

Speech recognition is done by [OpenAI Whisper](https://github.com/openai/whisper).

## License

[GPL-3.0-or-later](./LICENSE), the same license as the project it is forked from.
