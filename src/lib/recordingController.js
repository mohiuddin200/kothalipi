import GLib from "gi://GLib";
import { RecordingStateManager } from "./recordingStateManager.js";
import { TextInserter } from "./textInserter.js";
import { isWaylandCompositor } from "./compat.js";
import { log } from "./resourceUtils.js";

const COUNTDOWN_SECONDS = 10;
// Above this the microphone is clearly picking something up (about -46 dBFS).
const SOUND_LEVEL = 0.1;
// How long to wait for a first sound before pointing at the microphone.
const SILENCE_WARNING_MS = 4000;

const dim = (words) => `<span alpha="58%">${words}</span>`;

// Service errors are written for logs. The pill has room for one short line
// that names the problem and what to try.
function describeError(message) {
  const text = (message || "").toLowerCase();
  if (text.includes("no speech") || text.includes("empty text"))
    return "No speech detected. Check your microphone";
  if (text.includes("no audio") || text.includes("audio file not found"))
    return "Nothing was recorded. Check your microphone";
  if (text.includes("ffmpeg"))
    return "The recorder could not start. Check your microphone";
  return "Transcription failed. Try again";
}

// Drives one dictation from start to delivered text, and keeps the pill in
// step with it.
export class RecordingController {
  constructor(uiManager, serviceManager) {
    this.uiManager = uiManager;
    this.serviceManager = serviceManager;
    this.recordingStateManager = null;
    this._phase = "idle"; // idle | starting | recording | processing
    this._countdownId = 0;
    this._inserter = new TextInserter();
    this._resetHint();
  }

  get pill() {
    return this.uiManager.pill;
  }

  /** A dictation is starting, recording or being transcribed. */
  get busy() {
    return this._phase !== "idle";
  }

  initialize() {
    this.recordingStateManager = new RecordingStateManager(
      this.uiManager.icon,
      this.serviceManager.dbusManager
    );
  }

  async toggleRecording(settings) {
    // Service readiness is handled by the extension entrypoint.
    if (!this.recordingStateManager) this.initialize();

    if (this._phase === "idle") await this.start(settings);
    else if (this._phase === "recording") await this.stop();
    // While starting or transcribing there is nothing to toggle yet.
  }

  async start(settings) {
    if (this._phase !== "idle") return;
    this._phase = "starting";

    const dbusManager = this.serviceManager.dbusManager;
    if (dbusManager && this.recordingStateManager.dbusManager !== dbusManager)
      this.recordingStateManager.updateDbusManager(dbusManager);

    // Open the pill straight away; the service answers within a few frames.
    this.pill?.setState("recording");
    const started = await this.recordingStateManager.startRecording(settings);

    if (this._phase !== "starting") {
      // Cancelled before the service answered: drop the recording it began.
      if (started) await this.recordingStateManager.cancelRecording();
      return;
    }
    if (!started) {
      this._phase = "idle";
      this.pill?.setState("idle");
      this.uiManager.showServiceSetupDialog(
        "Failed to start recording. Please verify the Kothalipi service is installed and up to date."
      );
      return;
    }

    this._phase = "recording";
    this._resetHint();
    this._recordingSince = GLib.get_monotonic_time();
    this._refreshHint();
    this._armCountdown(settings.get_int("recording-duration"));
  }

  async stop() {
    if (this._phase !== "recording") return;
    this._beginProcessing();
    const stopped = await this.recordingStateManager.stopRecording();
    if (!stopped && this._phase === "processing") {
      this.recordingStateManager.reset();
      this._phase = "idle";
      this.pill?.setState("error", {
        label: "Could not stop the recording. Try again",
      });
    }
  }

  async cancel() {
    if (this._phase === "idle") return;
    this._clearCountdown();
    this._phase = "idle";
    this.pill?.setState("idle");
    await this.recordingStateManager.cancelRecording();
  }

  handleRecordingStopped(recordingId, reason) {
    if (!this._isCurrent(recordingId)) return;
    log.debug(`Recording stopped: ${recordingId} (${reason})`);
    // The time limit ran out, so the service stopped on its own.
    if (reason === "completed" && this._phase === "recording")
      this._beginProcessing();
  }

  handleAudioLevel(recordingId, level) {
    if (this._phase !== "recording" || !this._isCurrent(recordingId)) return;
    this.pill?.pushLevel(level);

    if (this._heardSound) return;
    if (level > SOUND_LEVEL) {
      this._heardSound = true;
      if (this._silenceWarned) this._refreshHint();
    } else if (
      !this._silenceWarned &&
      GLib.get_monotonic_time() - this._recordingSince > SILENCE_WARNING_MS * 1000
    ) {
      this._silenceWarned = true;
      this._refreshHint();
    }
  }

  // A rough reading of what was just said. It is only shown; the text that
  // gets delivered arrives with handleTranscriptionReady.
  handlePartialTranscript(recordingId, text) {
    if (this._phase !== "recording" || !this._isCurrent(recordingId)) return;
    const words = (text || "").replace(/\s+/g, " ").trim();
    if (!words) return;
    this._heardSound = true;
    this._transcript = words;
    this._refreshHint();
  }

  async handleTranscriptionReady(recordingId, text) {
    if (!this._isCurrent(recordingId)) return;
    log.debug(`Transcription ready: ${recordingId}`);
    this._finish();

    const settings = this.uiManager.extensionCore.settings;
    const insert =
      !isWaylandCompositor() && settings.get_boolean("skip-preview-x11");

    if (insert) {
      this._typeText(text);
      this.pill?.setState("done", { label: "Inserted", holdMs: 1400 });
      return;
    }

    try {
      const { method, copied } = await this._inserter.deliver(text, {
        insert: settings.get_boolean("auto-insert"),
        copy: settings.get_boolean("copy-to-clipboard"),
      });
      // A new dictation may have started while the text was being placed.
      if (this._phase !== "idle") return;

      const dim = (words) => `  <span alpha="58%">${words}</span>`;
      let label = `Copied${dim("Ctrl+V to paste")}`;
      if (method === "inserted")
        label = copied ? `Inserted${dim("and copied")}` : "Inserted";
      else if (method === "pasted") label = `Pasted${dim("and copied")}`;
      this.pill?.setState("done", {
        label,
        holdMs: method === "clipboard" ? 2400 : 1500,
      });
    } catch (e) {
      console.error(`Error delivering the text: ${e}`);
      if (this._phase === "idle")
        this.pill?.setState("error", {
          label: "Could not place the text. Try again",
        });
    }
  }

  handleRecordingError(recordingId, errorMessage) {
    if (!this._isCurrent(recordingId)) return;
    log.warn(`Recording error: ${errorMessage}`);
    this._finish();
    this.pill?.setState("error", { label: describeError(errorMessage) });
  }

  _isCurrent(recordingId) {
    const manager = this.recordingStateManager;
    return (
      !!manager &&
      !manager.isCancelled &&
      manager.currentRecordingId === recordingId
    );
  }

  _beginProcessing() {
    this._clearCountdown();
    this._phase = "processing";
    this.pill?.setState("processing");
  }

  _finish() {
    this._clearCountdown();
    this._phase = "idle";
    this.recordingStateManager.reset();
  }

  _resetHint() {
    this._transcript = "";
    this._countdown = "";
    this._heardSound = false;
    this._silenceWarned = false;
    this._recordingSince = 0;
  }

  // The line above the pill while recording: what was heard so far, or why
  // nothing is showing, with the remaining time after it near the limit.
  _refreshHint() {
    if (this._phase !== "recording") return;

    let line = null;
    if (this._transcript) line = GLib.markup_escape_text(this._transcript, -1);
    else if (this._silenceWarned && !this._heardSound)
      line = "No sound yet. Check your microphone";
    else if (this.recordingStateManager?.livePreview) line = dim("Listening…");

    if (this._countdown)
      line = line ? `${line}  ${dim(this._countdown)}` : this._countdown;
    this.pill?.setHint(line, { keepEnd: true });
  }

  // Show the remaining time once the limit is close.
  _armCountdown(duration) {
    this._clearCountdown();
    let remaining = Math.min(COUNTDOWN_SECONDS, duration);
    const tick = () => {
      if (this._phase !== "recording" || remaining <= 0) {
        this._countdownId = 0;
        return GLib.SOURCE_REMOVE;
      }
      this._countdown = `Stops in ${remaining}s`;
      this._refreshHint();
      remaining -= 1;
      this._countdownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, tick);
      return GLib.SOURCE_REMOVE;
    };
    this._countdownId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(0, duration - remaining) * 1000,
      tick
    );
  }

  _clearCountdown() {
    if (this._countdownId) {
      GLib.source_remove(this._countdownId);
      this._countdownId = 0;
    }
  }

  async _typeText(text) {
    try {
      await this.serviceManager.typeText(
        text,
        this.uiManager.extensionCore.settings.get_boolean("copy-to-clipboard")
      );
    } catch (e) {
      console.error(`Error typing text: ${e}`);
    }
  }

  cleanup() {
    this._clearCountdown();
    this._inserter.destroy();
    this._phase = "idle";
    if (this.recordingStateManager) {
      this.recordingStateManager.cleanup();
      this.recordingStateManager = null;
    }
  }
}
