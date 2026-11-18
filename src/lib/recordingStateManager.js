import { COLORS } from "./constants.js";
import { log, readInstalledServiceConfig } from "./resourceUtils.js";

// Owns the recording that is in flight on the D-Bus service.
export class RecordingStateManager {
  constructor(icon, dbusManager) {
    this.icon = icon;
    this.dbusManager = dbusManager;
    this.currentRecordingId = null;
    this.isCancelled = false;
    // Whether the service sends a rough transcript during this recording.
    this.livePreview = false;
  }

  // The extension recreates the D-Bus manager after a service restart.
  updateDbusManager(dbusManager) {
    this.dbusManager = dbusManager;
  }

  async startRecording(settings) {
    if (this.currentRecordingId) {
      log.debug("Recording already in progress");
      return false;
    }

    try {
      this.isCancelled = false;

      const recordingDuration = settings.get_int("recording-duration");
      const copyToClipboard = settings.get_boolean("copy-to-clipboard");
      const installed = readInstalledServiceConfig();
      if (!installed.known) return false;

      const whisperModel = installed.model || "base";
      const whisperDevice = installed.device || "cpu";

      if (!this.dbusManager) {
        console.error("RecordingStateManager: dbusManager is null");
        return false;
      }

      // Ensure the service uses the installed model/device before recording.
      try {
        const applied = await this.dbusManager.setWhisperConfig(
          whisperModel,
          whisperDevice
        );
        if (!applied) {
          // An older service without SetWhisperConfig only knows base+cpu.
          if (whisperModel !== "base" || whisperDevice !== "cpu") {
            log.warn(
              "Service does not support SetWhisperConfig; selected model/device requires service upgrade."
            );
            return false;
          }
        }
      } catch (e) {
        console.error(`Failed to set Whisper config: ${e.message}`);
        return false;
      }

      // Older services have no live preview; the stand-in used by the
      // screenshot harness has no such method at all.
      this.livePreview =
        (await this.dbusManager.setLivePreview?.(
          settings.get_boolean("live-preview")
        )) ?? false;

      // Preview mode: the service transcribes and hands the text back; the
      // extension decides how to deliver it.
      const recordingId = await this.dbusManager.startRecording(
        recordingDuration,
        copyToClipboard,
        true
      );

      this.currentRecordingId = recordingId;
      this.updateIcon(true);
      log.debug(`Recording started with ID: ${recordingId}`);
      return true;
    } catch (e) {
      console.error(`Error starting recording: ${e}`);
      this.updateIcon(false);
      return false;
    }
  }

  // Stops capture. The recording stays current until its text or error arrives.
  async stopRecording() {
    if (!this.currentRecordingId) {
      log.debug("No recording to stop");
      return false;
    }

    try {
      await this.dbusManager.stopRecording(this.currentRecordingId);
      this.updateIcon(false);
      return true;
    } catch (e) {
      console.error(`Error stopping recording: ${e}`);
      return false;
    }
  }

  async cancelRecording() {
    if (!this.currentRecordingId) return false;

    const recordingId = this.currentRecordingId;
    this.isCancelled = true;
    this.currentRecordingId = null;
    this.updateIcon(false);

    try {
      await this.dbusManager.cancelRecording(recordingId);
    } catch (error) {
      log.warn("Error calling D-Bus cancel recording:", error.message);
    }
    return true;
  }

  // The recording has delivered its text or its error.
  reset() {
    this.currentRecordingId = null;
    this.isCancelled = false;
    this.updateIcon(false);
  }

  isRecording() {
    return this.currentRecordingId !== null;
  }

  updateIcon(isRecording) {
    if (!this.icon) return;
    this.icon.set_style(isRecording ? `color: ${COLORS.PRIMARY};` : "");
  }

  cleanup() {
    this.currentRecordingId = null;
    this.isCancelled = false;
    try {
      this.updateIcon(false);
    } catch (error) {
      log.warn("Error resetting icon during cleanup:", error.message);
    }
  }
}
