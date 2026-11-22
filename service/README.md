# Kothalipi Service

> Part of [Kothalipi](https://github.com/mohiuddin200/kothalipi), a fork of
> [Speech2Text](https://github.com/kavehtehrani/speech2text-extension) by Kaveh Tehrani.
> `kothalipi-service` is not on PyPI yet: where this document says `--pypi`, use `--local` from a clone for now.

A D-Bus service that provides speech-to-text and read aloud for the GNOME Shell Kothalipi extension.

## Overview

This service handles the actual speech recognition processing using OpenAI's Whisper model locally. It runs as a D-Bus service and communicates with the GNOME Shell extension to provide seamless speech-to-text functionality.

## Features

- **Real-time speech recognition** using OpenAI Whisper
- **D-Bus integration** for seamless desktop integration
- **Audio recording** with configurable duration
- **Multiple output modes** (clipboard, text insertion, preview)
- **Read aloud** (optional): text to speech with Kokoro, played as it is made
- **Error handling** and recovery
- **Session management** for multiple concurrent recordings

## Installation

### System Dependencies

This service requires several system packages to be installed (e.g. ffmpeg, clipboard tools). See the main [README.md](../README.md) for the complete list of system dependencies.

### Service Installation

The service is available on PyPI and is typically installed into a per-user virtual environment by the extension’s installer.

```bash
pip install kothalipi-service
```

**PyPI Package**: [kothalipi-service](https://pypi.org/project/kothalipi-service/)

Or from the source repository:

```bash
cd service/
pip install .
```

### D-Bus Registration

After installation, you need to register the D-Bus service and desktop entry. The installer script (`install-service.sh`) handles this automatically.

#### Basic Installation

1. **Using the repository (local source install)**

```bash
# From the repo root
./service/install-service.sh --local
```

2. **Using the bundled installer (PyPI install)**

```bash
# From the repo root
./service/install-service.sh --pypi
```

#### Configuration Options

The installer supports several options to configure the Whisper model and processing device:

**Whisper Model Selection**

Use `--whisper-model <name>` to specify which Whisper model to use. Available models:
- `tiny` - Fastest, least accurate 
- `base` - Good balance (default)
- `small` - Better accuracy 
- `medium` - High accuracy 
- `large` - Best accuracy
- Variants: `tiny.en`, `base.en`, `small.en`, `medium.en` (English-only, faster)

The model name is recorded for UI display purposes. The actual model files are downloaded automatically by Whisper when first used.

**Device Selection (CPU/GPU)**

- **CPU mode (default)**: Recommended for most users. Easier installation and better compatibility across systems.
- **GPU mode**: Use `--gpu` flag to install GPU-enabled ML dependencies. On Linux, this typically requires NVIDIA CUDA support.

**Read Aloud**

Use `--read-aloud` to also install text to speech. It adds the `kokoro-onnx` package to the virtual environment and
downloads the Kokoro model files (about 350 MB) to `~/.local/share/kothalipi-service/tts`. It needs Python 3.10 or
newer, and plays through `paplay` or `pw-play`. Without it the service still starts, and a request to read aloud is
answered with an error that says it is not installed.

The model files are kept when the installer rebuilds the virtual environment, so only the first install downloads
them. Pass `--read-aloud` again on every reinstall, or the package is left out. Set `KOTHALIPI_TTS_DIR` before the
service starts to load the model files from another directory.

**CPU Thread Count**

CPU inference uses up to four threads by default. Set `KOTHALIPI_CPU_THREADS` before the service starts to override
the default. The value is clamped between one and the number of available CPUs; invalid values fall back to four.

For example, with a systemd user session:

```bash
mkdir -p ~/.config/environment.d
printf 'KOTHALIPI_CPU_THREADS=12\n' > ~/.config/environment.d/90-kothalipi.conf
```

Log out and back in after changing the file so the D-Bus-activated service inherits the new value.

**Example Installations**

```bash
# Default: base model, CPU mode
./service/install-service.sh --pypi

# Medium model with GPU support
./service/install-service.sh --pypi --gpu --whisper-model medium

# Base model with read aloud
./service/install-service.sh --pypi --whisper-model base --read-aloud

# Small English-only model, CPU mode
./service/install-service.sh --pypi --whisper-model small.en

# Large model with GPU (requires significant VRAM)
./service/install-service.sh --pypi --gpu --whisper-model large
```

**Other Options**

- `--python <cmd>`: Use a specific Python interpreter (e.g., `--python python3.12`)
- `--non-interactive`: Run without user prompts (auto-accept defaults)
- `--service-version <version>`: Install a specific service package version from PyPI
- `--help`: Show all available options

**What the Installer Does**

The installer will:

- Create a per-user virtual environment under `~/.local/share/kothalipi-service/venv`
- Install the `kothalipi-service` package with appropriate ML dependencies
- Register the D-Bus service at `~/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service`
- Create a desktop entry at `~/.local/share/applications/kothalipi-service.desktop`
- Record installation metadata in `~/.local/share/kothalipi-service/install-state.conf` (model, device, timestamp)

**Note**: To change the model or device after installation, you must re-run the installer with the new options. The installer rebuilds the virtual environment from scratch, ensuring clean dependency management.

## Usage

### Starting the Service

The service is D-Bus activated and starts automatically when requested by the extension. You can also start it manually:

```bash
# If the entry point is on PATH (pip install)
kothalipi-service

# Or via the per-user wrapper created by the installer
~/.local/share/kothalipi-service/kothalipi-service
```

### Configuration

The service uses OpenAI's Whisper model locally for speech recognition. No API key is required. All processing happens on your local machine for complete privacy.

**Model and Device Configuration**

The Whisper model and processing device (CPU/GPU) are configured during service installation using the installer flags (see [D-Bus Registration](#d-bus-registration) above). The extension reads this configuration from `~/.local/share/kothalipi-service/install-state.conf` to display the current settings in the setup dialog.

To change the model or device, reinstall the service with the desired options. The installer will rebuild the virtual environment with the appropriate dependencies.

### D-Bus Interface

The service provides the following D-Bus interface (stable; used by the GNOME extension):

Methods:

- `StartRecording(duration, copy_to_clipboard, preview_mode)` → `recording_id`
- `StopRecording(recording_id)` → `success`
- `CancelRecording(recording_id)` → `success`
- `TypeText(text, copy_to_clipboard)` → `success`
- `GetServiceStatus()` → `status`
- `CheckDependencies()` → `all_available, missing_dependencies[]`
- `Speak(text, voice, speed)` → `speech_id` (replaces any speech in progress)
- `StopSpeaking(speech_id)` → `success` (an empty id stops whatever is being read)
- `PauseSpeaking(speech_id)` → `success` and `ResumeSpeaking(speech_id)` → `success`
- `SetSpeechSpeed(speech_id, speed)` → `success` (carries on from the clause being spoken, under the same id)

Signals:

- `RecordingStarted(recording_id)`
- `RecordingStopped(recording_id, reason)`
- `TranscriptionReady(recording_id, text)`
- `RecordingError(recording_id, error_message)`
- `TextTyped(text, success)`
- `SpeechStarted(speech_id)`
- `SpeechFinished(speech_id, reason)` (`completed` or `stopped`)
- `SpeechError(speech_id, error_message)`
- `SpeechLevel(speech_id, level)` (loudness of what is playing, 0 to 1, about 20 times a second)

## Requirements

- **Python**: 3.8–3.13 (Python 3.14+ not supported yet); read aloud needs 3.10 or newer
- **System**: Linux with D-Bus support
- **Desktop**: GNOME Shell (tested on GNOME 46+)

## License

This project is licensed under the GPL-3.0-or-later license. See the LICENSE file for details.

## Contributing

Contributions are welcome! Please see the main repository for contribution guidelines:
https://github.com/mohiuddin200/kothalipi
