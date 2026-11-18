// Development harness, loaded only by `dev/shell.sh shots`.
// It reaches into the fork's pill, plays each state with synthetic voice
// levels, and writes PNGs to $KOTHALIPI_SHOTS_DIR. Nothing here talks to the
// service or the microphone.
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

Gio._promisify(Shell.Screenshot.prototype, "screenshot_area");

const CROP_W = 420;
const CROP_H = 220;

const sleep = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    })
  );

// A syllable-like envelope: bursts with short gaps, like speech.
function speechLevel(t) {
  const syllable = Math.max(0, Math.sin(t * 9.5)) ** 0.6;
  const phrase = 0.55 + 0.45 * Math.sin(t * 1.7 + 0.6);
  const pause = Math.sin(t * 0.9 + 2.4) > 0.9 ? 0.05 : 1;
  return Math.min(1, 0.12 + 0.8 * syllable * phrase) * pause;
}

export default class ShotsExtension extends Extension {
  enable() {
    this._outDir = GLib.getenv("KOTHALIPI_SHOTS_DIR");
    this._target = GLib.getenv("KOTHALIPI_TARGET_UUID");
    if (!this._outDir || !this._target) return;
    this._run().catch((e) => {
      console.error(`shots: ${e}\n${e.stack}`);
      this._finish("failed");
    });
  }

  disable() {
    this._stopLevels();
    this._backdrop?.destroy();
    this._backdrop = null;
  }

  async _run() {
    const pill = await this._waitForPill();
    this._pill = pill;
    this._shooter = new Shell.Screenshot();
    const controller =
      Main.extensionManager.lookup(this._target).stateObj.recordingController;

    await this._shotPanel("panel-1-icon");
    if (GLib.getenv("KOTHALIPI_PANEL_ONLY")) { this._finish("ok"); return; }

    for (const theme of ["dark", "light"]) {
      this._setBackdrop(theme);
      pill.setState("idle");
      await sleep(500);
      await this._shot(`${theme}-1-rest`);

      this._fakeHover(true);
      await sleep(900);
      await this._shot(`${theme}-2-hover`);
      this._fakeHover(false);
      await sleep(350);

      if (theme === "dark") await this._sequence("seq-a-open", () => pill.setState("recording"), 14, 30);
      else pill.setState("recording");
      this._startLevels();
      await sleep(1300);
      await this._shot(`${theme}-3-recording`);
      if (theme === "dark") await this._sequence("seq-b-voice", () => {}, 12, 60);

      pill._zone = "stop";
      pill._hovered = true;
      pill._applyZoneFeedback();
      pill._wake();
      await sleep(300);
      await this._shot(`${theme}-4-recording-stop-hover`);
      pill._zone = "cancel";
      pill._applyZoneFeedback();
      pill._wake();
      await sleep(300);
      await this._shot(`${theme}-5-recording-cancel-hover`);
      pill._zone = null;
      pill._hovered = false;
      pill._applyZoneFeedback();

      pill.setHint("Stops in 9s");
      await sleep(500);
      await this._shot(`${theme}-6-countdown`);

      this._stopLevels();
      if (theme === "dark") await this._sequence("seq-c-processing", () => pill.setState("processing"), 14, 30);
      else pill.setState("processing");
      await sleep(700);
      await this._shot(`${theme}-7-processing`);
      if (theme === "dark") await this._sequence("seq-d-wave", () => {}, 10, 90);

      const copied = 'Copied  <span alpha="58%">Ctrl+V to paste</span>';
      if (theme === "dark") await this._sequence("seq-e-done", () => pill.setState("done", { label: copied, holdMs: 1500 }), 14, 30);
      else pill.setState("done", { label: copied, holdMs: 1500 });
      await sleep(700);
      await this._shot(`${theme}-8-done`);
      if (theme === "dark") {
        await sleep(450);
        await this._sequence("seq-f-settle", () => {}, 12, 35);
      }
      await sleep(900);

      pill.setState("error", { label: "No speech detected. Check your microphone", holdMs: 1400 });
      await sleep(800);
      await this._shot(`${theme}-9-error`);
      await sleep(1100);
    }

    // The pill hidden when idle, then opening from nothing.
    this._setBackdrop("dark");
    pill.setIdleVisible(false);
    await sleep(500);
    await this._shot("dark-10-idle-hidden");
    pill.setIdleVisible(true);
    await sleep(400);

    // Riding above a bottom dock.
    const dock = Main.uiGroup
      .get_children()
      .find((actor) => actor.name === "dashtodockContainer");
    if (dock) {
      this._backdrop.hide();
      pill._refreshDock();
      await sleep(900);
      await this._shot("dock-1-rest", 760, 300);
      pill.setState("recording");
      this._startLevels();
      await sleep(1200);
      await this._shot("dock-2-recording", 760, 300);
      this._stopLevels();
      pill.setState("idle");
      await sleep(500);
    } else {
      console.log("shots: no dock in this shell, skipping dock scene");
    }

    // The real controller on its happy path, with the service stubbed out.
    this._backdrop.show();
    await this._controllerPass(controller, pill);

    this._finish("ok");
  }

  // Exercises start -> levels -> stop -> transcription through the real
  // controller, with a stand-in for the D-Bus calls.
  async _controllerPass(controller, pill) {
    const manager = controller.recordingStateManager;
    const serviceManager = controller.serviceManager;
    const realDbus = serviceManager.dbusManager;
    const calls = [];
    this._calls = calls;
    const stub = {
      setWhisperConfig: async () => true,
      startRecording: async () => {
        calls.push("start");
        return "shots-recording";
      },
      stopRecording: async () => {
        calls.push("stop");
        return true;
      },
      cancelRecording: async () => {
        calls.push("cancel");
        return true;
      },
    };
    serviceManager.dbusManager = stub;
    manager.dbusManager = stub;
    const settings = Main.extensionManager.lookup(this._target).stateObj.settings;
    const log = [];
    const note = (step) => log.push(`${step}: phase=${controller._phase} pill=${pill.state}`);

    await controller.toggleRecording(settings);
    note("after start");
    controller.handleAudioLevel("shots-recording", 0.8);
    controller.handleAudioLevel("someone-else", 0.1);
    await sleep(300);
    log.push(`level target after matching+foreign signal: ${pill._levelTarget.toFixed(2)}`);
    await controller.toggleRecording(settings);
    note("after stop");
    await controller.toggleRecording(settings);
    note("toggle while processing (ignored)");
    await controller.handleTranscriptionReady("shots-recording", "hello from the harness");
    note("after transcription");
    await sleep(400);
    await this._shot("flow-1-done");
    await sleep(2600);
    note("after hold");

    await controller.toggleRecording(settings);
    await controller.cancel();
    note("after cancel");
    await controller.handleTranscriptionReady("shots-recording", "late text must be ignored");
    note("late transcription after cancel");

    await controller.toggleRecording(settings);
    controller.handleRecordingError("shots-recording", "No speech detected (audio appears silent).");
    note("after error");
    await sleep(500);

    log.push(`dbus calls: ${calls.join(",")}`);
    await controller.cancel();
    pill.setState("idle");
    await sleep(500);

    await this._pointerPass(controller, pill, log);
    await this._insertPass(controller, pill, log);

    serviceManager.dbusManager = realDbus;
    manager.dbusManager = realDbus;
    manager.reset();
    pill.setState("idle");
    this._write("controller-pass.txt", log.join("\n") + "\n");
  }

  // Real pointer events through the compositor: hover, click to start, the
  // stop button, then the cancel button. The extension's own toggle path is
  // bypassed (it would ask the real service); the pill's actions are pointed
  // at the stubbed controller instead.
  async _pointerPass(controller, pill, log) {
    const settings = Main.extensionManager.lookup(this._target).stateObj.settings;
    const realStart = pill._actions.onStart;
    pill._actions.onStart = () => controller.toggleRecording(settings);

    const seat = Clutter.get_default_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const at = (dx = 0) => {
      const [stageX, stageY] = pill._stage.get_transformed_position();
      const body = pill._bodyRect();
      return [stageX + (body.cx + dx) * pill._scale, stageY + body.cy * pill._scale];
    };
    const move = async (dx = 0) => {
      const [x, y] = at(dx);
      pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
      await sleep(350);
    };
    const click = async () => {
      pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      await sleep(60);
      pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      await sleep(450);
    };
    const note = (step) =>
      log.push(`pointer ${step}: hovered=${pill._hovered} zone=${pill._zone} phase=${controller._phase} pill=${pill.state}`);

    this._calls.length = 0;
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 40, 40);
    await sleep(300);
    note("away");
    await move();
    await sleep(400);
    note("over rest pill");
    await this._shot("pointer-1-hover");
    await click();
    note("after click on idle pill");
    const stopDx = pill._bodyRect().w / 2 - 20;
    await move(stopDx);
    note("over stop button");
    await this._shot("pointer-2-stop-hover");
    await click();
    note("after click on stop");
    await controller.handleTranscriptionReady("shots-recording", "pointer pass");
    await sleep(300);
    await move();
    await click();
    note("after click on done pill");

    await click();
    note("after click to start again");
    await move(-(pill._bodyRect().w / 2 - 20));
    note("over cancel button");
    await click();
    note("after click on cancel");
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 40, 40);
    await sleep(500);
    note("pointer away again");
    log.push(`pointer dbus calls: ${this._calls.join(",")}`);

    pill._actions.onStart = realStart;
  }

  // Dictates into a real text field: once into a field that accepts direct
  // text input, once into one that does not (so the paste route is used),
  // and once with nothing focused.
  async _insertPass(controller, pill, log) {
    const display = GLib.getenv("KOTHALIPI_WAYLAND_DISPLAY");
    const script = GLib.getenv("KOTHALIPI_TEXTFIELD");
    if (!display || !script) {
      log.push("insert: skipped (no test field configured)");
      return;
    }
    const settings = Main.extensionManager.lookup(this._target).stateObj.settings;
    const clipboardText = () =>
      new Promise((resolve) =>
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text))
      );
    const dictate = async (text, { stopWithPointer = false } = {}) => {
      await controller.toggleRecording(settings);
      if (stopWithPointer) {
        await sleep(500);
        const [stageX, stageY] = pill._stage.get_transformed_position();
        const body = pill._bodyRect();
        const pointer = Clutter.get_default_backend()
          .get_default_seat()
          .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        pointer.notify_absolute_motion(
          GLib.get_monotonic_time(),
          stageX + (body.x + body.w - 20) * pill._scale,
          stageY + body.cy * pill._scale
        );
        await sleep(300);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await sleep(60);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await sleep(300);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 40, 40);
      } else {
        await controller.toggleRecording(settings);
      }
      await controller.handleTranscriptionReady("shots-recording", text);
      await sleep(700);
    };
    const withField = async (name, env, body, program = script, extraArgs = []) => {
      const out = `${this._outDir}/field-${name}.txt`;
      const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
      launcher.setenv("WAYLAND_DISPLAY", display, true);
      launcher.setenv("GDK_BACKEND", "wayland", true);
      launcher.unsetenv("DISPLAY");
      for (const [key, value] of Object.entries(env)) launcher.setenv(key, value, true);
      const proc = launcher.spawnv(["gjs", "-m", program, out, ...extraArgs]);
      for (let i = 0; i < 60 && !GLib.file_test(`${out}.ready`, GLib.FileTest.EXISTS); i++)
        await sleep(200);
      await sleep(600);
      log.push(
        `insert[${name}] window="${global.display.focus_window?.get_title() ?? "none"}" text-input focus=${!!Main.inputMethod.currentFocus}`
      );
      const read = () => {
        if (!GLib.file_test(out, GLib.FileTest.EXISTS)) return "(nothing received)";
        const [ok, bytes] = GLib.file_get_contents(out);
        return ok ? new TextDecoder().decode(bytes) : "(unreadable)";
      };
      try {
        await body(read);
      } finally {
        proc.force_exit();
        await sleep(600);
      }
    };

    settings.set_boolean("copy-to-clipboard", true);
    this._backdrop.hide();

    await withField("native", {}, async (read) => {
      await dictate("Hello from Whisper.");
      log.push(`insert[native] field="${read()}" label="${pill._labelMarkup}" clipboard="${await clipboardText()}"`);
      await this._shot("insert-1-native", 760, 420);
      await sleep(1600);

      await dictate(" Stopped with the mouse.", { stopWithPointer: true });
      log.push(`insert[native, stop by click] field="${read()}" label="${pill._labelMarkup}"`);
      await sleep(1600);

      settings.set_boolean("copy-to-clipboard", false);
      await dictate(" বাংলা লেখা।");
      log.push(`insert[native, copy off] field="${read()}" label="${pill._labelMarkup}" clipboard="${await clipboardText()}"`);
      settings.set_boolean("copy-to-clipboard", true);
      await sleep(1600);

      settings.set_boolean("auto-insert", false);
      await dictate("This must stay out of the field.");
      log.push(`insert[native, insert off] field="${read()}" label="${pill._labelMarkup}" clipboard="${await clipboardText()}"`);
      settings.set_boolean("auto-insert", true);
      await sleep(2500);
    });

    await withField("no-text-input", { GTK_IM_MODULE: "gtk-im-context-simple" }, async (read) => {
      await dictate("Pasted because this field has no text input.");
      log.push(`insert[no-text-input] field="${read()}" label="${pill._labelMarkup}" clipboard="${await clipboardText()}"`);
      await sleep(1600);
    });

    // The widget GNOME Terminal is built on.
    const terminal = GLib.getenv("KOTHALIPI_TERMFIELD");
    const spoken = "Typed into a VTE terminal.";
    if (terminal) {
      await withField(
        "terminal",
        {},
        async (read) => {
          await dictate(spoken);
          await sleep(500);
          log.push(`insert[terminal] received="${read()}" label="${pill._labelMarkup}"`);
          await this._shot("insert-2-terminal", 760, 420);
          await sleep(1200);
        },
        terminal,
        [String(spoken.length)]
      );
    }

    await dictate("Nothing is focused.");
    log.push(
      `insert[no window] window=${global.display.focus_window ? "yes" : "none"} label="${pill._labelMarkup}" clipboard="${await clipboardText()}"`
    );
    await sleep(2500);
    this._backdrop.show();
  }

  async _waitForPill() {
    for (let i = 0; i < 100; i++) {
      const pill = Main.extensionManager.lookup(this._target)?.stateObj
        ?.uiManager?.pill;
      if (pill) return pill;
      await sleep(200);
    }
    throw new Error(`${this._target} never created its pill`);
  }

  _fakeHover(hovered) {
    const pill = this._pill;
    // The harness has no pointer; mirror what notify::hover does.
    Object.defineProperty(pill._hit, "hover", {
      value: hovered,
      configurable: true,
    });
    pill._onHoverChanged();
    delete pill._hit.hover;
  }

  _startLevels() {
    this._stopLevels();
    const started = GLib.get_monotonic_time();
    this._levelsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      const t = (GLib.get_monotonic_time() - started) / 1e6;
      this._pill.pushLevel(speechLevel(t));
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopLevels() {
    if (this._levelsId) GLib.source_remove(this._levelsId);
    this._levelsId = 0;
  }

  // A window-like backdrop so contrast can be judged on dark and light.
  _setBackdrop(theme) {
    this._backdrop?.destroy();
    const monitor = Main.layoutManager.primaryMonitor;
    const dark = theme === "dark";
    this._backdrop = new St.Widget({
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
      style: `background-color: ${dark ? "#1b1b1f" : "#f3f3f5"};`,
    });
    const ink = dark ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.22)";
    for (let row = 0; row < 14; row++) {
      this._backdrop.add_child(
        new St.Widget({
          x: monitor.width / 2 - 300,
          y: monitor.height - 260 + row * 18,
          width: 380 + ((row * 97) % 220),
          height: 7,
          style: `background-color: ${ink}; border-radius: 3px;`,
        })
      );
    }
    Main.uiGroup.insert_child_below(this._backdrop, this._pill._stage);
  }

  // The right end of the top bar, where the extension's panel icon sits.
  async _shotPanel(name, width = 420) {
    // The bar slides in at startup and is see-through over the overview.
    for (let i = 0; i < 50 && Main.layoutManager._startingUp; i++)
      await sleep(200);
    Main.overview.hide();
    await sleep(1200);
    const monitor = Main.layoutManager.primaryMonitor;
    const file = Gio.File.new_for_path(`${this._outDir}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await this._shooter.screenshot_area(
      monitor.x + monitor.width - width,
      monitor.y,
      width,
      Main.panel.height,
      stream
    );
    stream.close(null);
  }

  async _shot(name, width = CROP_W, height = CROP_H) {
    const monitor = Main.layoutManager.primaryMonitor;
    const x = monitor.x + Math.floor((monitor.width - width) / 2);
    const y = monitor.y + monitor.height - height;
    const file = Gio.File.new_for_path(`${this._outDir}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await this._shooter.screenshot_area(x, y, width, height, stream);
    stream.close(null);
  }

  // Runs `action`, then captures `count` frames `gapMs` apart.
  async _sequence(name, action, count, gapMs) {
    action();
    for (let i = 0; i < count; i++) {
      await this._shot(`${name}-${String(i).padStart(2, "0")}`);
      await sleep(gapMs);
    }
  }

  _write(name, text) {
    GLib.file_set_contents(`${this._outDir}/${name}`, text);
  }

  _finish(status) {
    this._stopLevels();
    this._write("finished", `${status}\n`);
  }
}
