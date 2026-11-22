import GLib from "gi://GLib";
import St from "gi://St";
import { log } from "./resourceUtils.js";

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.1;
// Quick presses of a speed button are sent to the service as one change.
const SPEED_SETTLE_MS = 350;

// Service errors are written for logs. The pill has room for one short line.
function describeError(message) {
  const text = (message || "").toLowerCase();
  if (text.includes("not installed"))
    return "Read aloud is not installed. See Setup";
  if (text.includes("unknownmethod") || text.includes("could not be found"))
    return "Read aloud needs a newer service. See Setup";
  if (text.includes("no readable text")) return "Nothing to read in the selection";
  if (text.includes("audio player")) return "Could not play the speech. Check your speakers";
  return "Could not read the text. Try again";
}

function clipboardText(type) {
  return new Promise((resolve) =>
    St.Clipboard.get_default().get_text(type, (_clipboard, text) =>
      resolve((text ?? "").trim())
    )
  );
}

// Reads the selected text aloud through the service, and keeps the pill in
// step with it.
export class SpeechController {
  constructor(uiManager, serviceManager) {
    this.uiManager = uiManager;
    this.serviceManager = serviceManager;
    this._phase = "idle"; // idle | starting | speaking
    this._speechId = null;
    // Counts the requests, so an answer that arrives late can tell it is stale.
    this._request = 0;
    // How a speech ended, when that arrived before the id it was given.
    this._early = new Map();
    this._paused = false;
    // The speed the service is reading at.
    this._speed = 1;
    this._speedTimeoutId = 0;
  }

  get pill() {
    return this.uiManager.pill;
  }

  get active() {
    return this._phase !== "idle";
  }

  async toggle(settings) {
    if (this.active) await this.stop();
    else await this.start(settings);
  }

  /** Reads `text` aloud, or the selected text when none is given. */
  async start(settings, text = null) {
    if (this.active) return;
    this._phase = "starting";
    const request = ++this._request;
    const stale = () => this._request !== request || this._phase !== "starting";

    try {
      // What is selected now, or failing that what was last copied.
      text ??=
        (await clipboardText(St.ClipboardType.PRIMARY)) ||
        (await clipboardText(St.ClipboardType.CLIPBOARD));
      if (stale()) return;
      if (!text) {
        this._phase = "idle";
        this.pill?.setState("error", {
          label: "Select some text to read",
          holdMs: 2600,
        });
        return;
      }

      // Open the pill straight away; the voice follows within a second or so.
      this.pill?.setState("speaking");
      this._speed = settings.get_double("read-aloud-speed");
      const speechId = await this.serviceManager.dbusManager.speak(
        text,
        settings.get_string("read-aloud-voice"),
        this._speed
      );
      if (stale()) {
        // Stopped before the service answered: drop the speech it began.
        await this.serviceManager.dbusManager?.stopSpeaking(speechId);
        return;
      }
      this._speechId = speechId;
      this._phase = "speaking";
      const ended = this._early.get(speechId);
      this._early.clear();
      ended?.();
      // A speed button may have been pressed before the service answered.
      if (!this._speedTimeoutId) this._applySpeed(settings);
    } catch (e) {
      if (stale()) return;
      log.warn(`Read aloud failed: ${e?.message || e}`);
      this._fail(e?.message || String(e));
    }
  }

  async stop() {
    if (!this.active) return;
    const speechId = this._speechId;
    this._reset();
    if (this.pill?.state === "speaking") this.pill.setState("idle");
    // Without an id the service has not answered yet; start() drops the
    // speech when it does.
    if (speechId) await this.serviceManager.dbusManager?.stopSpeaking(speechId);
  }

  /** Pauses the reading, or carries on with it from where it paused. */
  async togglePause() {
    if (this._phase !== "speaking" || !this._speechId) return;
    const speechId = this._speechId;
    const paused = !this._paused;
    // Show it straight away; the service answers within a few frames.
    this._paused = paused;
    this.pill?.setPaused(paused);

    const done = await this.serviceManager.dbusManager?.setSpeechPaused(
      speechId,
      paused
    );
    if (!done && this._speechId === speechId && this._paused === paused) {
      // An older service cannot pause; the reading goes on.
      this._paused = !paused;
      this.pill?.setPaused(!paused);
    }
  }

  /**
   * Makes the reading faster (`steps` above zero) or slower. The speed is a
   * setting, so the next reading starts at it too.
   */
  changeSpeed(settings, steps) {
    if (!this.active) return;
    const current = settings.get_double("read-aloud-speed");
    const speed = Math.max(
      SPEED_MIN,
      Math.min(SPEED_MAX, Math.round((current + steps * SPEED_STEP) * 10) / 10)
    );
    if (speed !== current) settings.set_double("read-aloud-speed", speed);

    let label = `${speed.toFixed(1)}×`;
    if (speed >= SPEED_MAX) label += '  <span alpha="58%">fastest</span>';
    else if (speed <= SPEED_MIN) label += '  <span alpha="58%">slowest</span>';
    this.pill?.setHint(label, { holdMs: 1400 });

    this._clearSpeedTimeout();
    this._speedTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SPEED_SETTLE_MS,
      () => {
        this._speedTimeoutId = 0;
        this._applySpeed(settings);
        return GLib.SOURCE_REMOVE;
      }
    );
  }

  // The service makes the rest of the text again at the new speed, starting
  // at the clause it was reading. While paused it does so on resuming.
  _applySpeed(settings) {
    if (this._phase !== "speaking" || !this._speechId) return;
    const speed = settings.get_double("read-aloud-speed");
    if (Math.abs(speed - this._speed) < 0.001) return;
    this._speed = speed;
    this.serviceManager.dbusManager
      ?.setSpeechSpeed(this._speechId, speed)
      .catch((e) => log.debug(`Could not change the reading speed: ${e}`));
  }

  _clearSpeedTimeout() {
    if (this._speedTimeoutId) {
      GLib.source_remove(this._speedTimeoutId);
      this._speedTimeoutId = 0;
    }
  }

  handleSpeechLevel(speechId, level) {
    if (this._phase !== "speaking" || speechId !== this._speechId) return;
    this.pill?.pushLevel(level);
  }

  handleSpeechFinished(speechId, reason) {
    if (this._phase === "starting") {
      this._early.set(speechId, () => this.handleSpeechFinished(speechId, reason));
      return;
    }
    if (speechId !== this._speechId) return;
    log.debug(`Read aloud finished: ${reason}`);
    this._reset();
    if (this.pill?.state === "speaking") this.pill.setState("idle");
  }

  handleSpeechError(speechId, message) {
    if (this._phase === "starting") {
      this._early.set(speechId, () => this.handleSpeechError(speechId, message));
      return;
    }
    if (speechId !== this._speechId) return;
    this._fail(message);
  }

  _fail(message) {
    this._reset();
    this.pill?.setState("error", { label: describeError(message) });
  }

  _reset() {
    this._phase = "idle";
    this._speechId = null;
    this._paused = false;
    this._request++;
    this._early.clear();
    this._clearSpeedTimeout();
  }

  cleanup() {
    const speechId = this._speechId;
    this._reset();
    if (speechId)
      this.serviceManager.dbusManager?.stopSpeaking(speechId).catch(() => {});
  }
}
