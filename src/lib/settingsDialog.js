import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { isWaylandCompositor } from "./compat.js";
import {
  createButton,
  createCard,
  createChooser,
  createDialog,
  createKeycaps,
  createRow,
  createStepper,
  createSwitch,
  createTabs,
  createWrappedLabel,
  setShortcutKeycaps,
  settleSwitch,
} from "./dialogKit.js";
import {
  showModalDialog,
  closeModalDialog,
  setupModalEventHandlers,
} from "./resourceUtils.js";

const DURATION_MIN = 10;
const DURATION_MAX = 300;
const DURATION_STEP = 10;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.1;

// The two shortcuts, by settings key.
const SHORTCUTS = {
  "toggle-recording": {
    title: "Dictation shortcut",
    description: "Press it anywhere to start or stop dictating.",
    fallback: "<Super><Alt>r",
  },
  "read-aloud": {
    title: "Read aloud shortcut",
    description: "Select text anywhere, then press it. Press again to stop.",
    fallback: "<Super><Alt>a",
  },
};

// Whisper language codes offered in the dialog. Any other code Whisper knows
// can still be set through the "language" key.
const LANGUAGES = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["bn", "Bangla"],
  ["hi", "Hindi"],
  ["ur", "Urdu"],
  ["ar", "Arabic"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
];

// Kokoro voices offered in the dialog. Any other voice the model has can
// still be set through the "read-aloud-voice" key.
const VOICES = [
  ["af_heart", "Heart · US"],
  ["af_bella", "Bella · US"],
  ["af_nicole", "Nicole · US"],
  ["af_sarah", "Sarah · US"],
  ["am_michael", "Michael · US"],
  ["am_fenrir", "Fenrir · US"],
  ["am_puck", "Puck · US"],
  ["bf_emma", "Emma · UK"],
  ["bf_isabella", "Isabella · UK"],
  ["bm_george", "George · UK"],
  ["bm_fable", "Fable · UK"],
];

// 90 -> "1 min 30 sec"
function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} sec`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}

function toggleSettings() {
  const toggles = [
    {
      key: "live-preview",
      title: "Show words while you speak",
      description: "A rough preview above the pill. It is not the final text.",
    },
    {
      key: "auto-insert",
      title: "Insert text at the cursor",
      description: "When no field is focused, the text is copied instead.",
    },
    {
      key: "copy-to-clipboard",
      title: "Copy to clipboard",
      description: "Also keep each transcript on the clipboard.",
    },
  ];
  if (!isWaylandCompositor()) {
    toggles.push({
      key: "skip-preview-x11",
      title: "Auto-insert mode at cursor (X11 only)",
      description: "Type the text with simulated key presses instead.",
    });
  }
  toggles.push({
    key: "show-idle-pill",
    title: "Show the pill when idle",
    description: "A small pill at the bottom of the screen. Click it to dictate.",
  });
  return toggles;
}

export class SettingsDialog {
  constructor(extension) {
    this.extension = extension;
    this.settings = extension.settings;
    this.overlay = null;
    this.dialog = null;
    this.centerTimeoutId = null;
    this.keyPressHandler = null;
    this.clickHandler = null;
    this._settingsChangedId = 0;
    this._switches = new Map();
    this._shortcuts = new Map();
  }

  show() {
    if (this.overlay) {
      return; // Already open
    }

    this._build();
    this._connect();
    this._sync();
    for (const toggle of this._switches.values()) settleSwitch(toggle);

    if (this.centerTimeoutId) GLib.Source.remove(this.centerTimeoutId);
    // showModalDialog returns a timeout ID for widget centering
    this.centerTimeoutId = showModalDialog(this.overlay, this.dialog, {
      fallbackWidth: 480,
      fallbackHeight: 620,
      onComplete: () => (this.centerTimeoutId = null),
    });
  }

  /** @param {object} [options] - `animate: false` when the extension is being disabled */
  close({ animate = true } = {}) {
    if (this._settingsChangedId) {
      this.settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }
    closeModalDialog(
      this.overlay,
      {
        keyPressHandler: this.keyPressHandler,
        clickHandler: this.clickHandler,
      },
      this.centerTimeoutId,
      { animate }
    );
    this.centerTimeoutId = null;
    this.overlay = null;
    this.dialog = null;
    this.keyPressHandler = null;
    this.clickHandler = null;
    this._switches.clear();
    this._shortcuts.clear();
  }

  _build() {
    const { overlay, dialog, closeButton } = createDialog({ title: "Settings" });
    this.overlay = overlay;
    this.dialog = dialog;
    this.closeButton = closeButton;

    const dictation = new St.BoxLayout({ style_class: "kothalipi-page", vertical: true });
    dictation.add_child(
      createCard([
        this._buildShortcutGroup("toggle-recording"),
        this._buildDurationRow(),
        this._buildLanguageRow(),
      ])
    );
    dictation.add_child(
      createCard(toggleSettings().map((setting) => this._buildToggleRow(setting)))
    );

    const reading = new St.BoxLayout({ style_class: "kothalipi-page", vertical: true });
    reading.add_child(
      createCard([
        this._buildShortcutGroup("read-aloud"),
        this._buildVoiceGroup(),
        this._buildSpeedRow(),
      ])
    );
    reading.add_child(
      createWrappedLabel(
        "With nothing selected, the text you copied last is read. " +
          "Reading runs on your computer and needs the read aloud part of the service.",
        "kothalipi-note"
      )
    );

    const pages = [dictation, reading];
    this._tabs = createTabs(["Dictation", "Read aloud"], (index) =>
      pages.forEach((page, i) => (page.visible = i === index))
    );
    dialog.add_child(this._tabs.actor);
    for (const page of pages) dialog.add_child(page);
    this._tabs.select(0);
  }

  _buildShortcutGroup(key) {
    const { title, description } = SHORTCUTS[key];
    const keycaps = createKeycaps();
    const row = createRow({ title, description, control: keycaps });

    const change = createButton("Change");
    const reset = createButton("Reset to default", "ghost");
    const remove = createButton("Remove", "ghost");
    this._shortcuts.set(key, { keycaps, change, reset, remove });

    const actions = new St.BoxLayout({ style_class: "kothalipi-row-actions" });
    actions.add_child(change);
    actions.add_child(reset);
    actions.add_child(remove);

    const group = new St.BoxLayout({ vertical: true });
    group.add_child(row);
    group.add_child(actions);
    return group;
  }

  _buildDurationRow() {
    this.durationStepper = createStepper("recording limit");
    return createRow({
      title: "Recording limit",
      description: "Dictation stops on its own after this long.",
      control: this.durationStepper.actor,
    });
  }

  _buildLanguageRow() {
    this.languageChooser = createChooser("language");
    return createRow({
      title: "Language",
      description: "Auto-detect can misread your first words.",
      control: this.languageChooser.actor,
    });
  }

  _buildVoiceGroup() {
    this.voiceChooser = createChooser("voice");
    const row = createRow({
      title: "Voice",
      description: "The voices read English.",
      control: this.voiceChooser.actor,
    });

    this.sampleButton = createButton("Play a sample");
    const actions = new St.BoxLayout({ style_class: "kothalipi-row-actions" });
    actions.add_child(this.sampleButton);

    const group = new St.BoxLayout({ vertical: true });
    group.add_child(row);
    group.add_child(actions);
    return group;
  }

  _buildSpeedRow() {
    this.speedStepper = createStepper("reading speed");
    return createRow({
      title: "Speed",
      description: "How fast the voice reads.",
      control: this.speedStepper.actor,
    });
  }

  _buildToggleRow({ key, title, description }) {
    const toggle = createSwitch(title);
    toggle.connect("clicked", () =>
      this.settings.set_boolean(key, toggle.checked)
    );
    this._switches.set(key, toggle);
    return createRow({ title, description, control: toggle });
  }

  _connect() {
    this.closeButton.connect("clicked", () => this.close());

    for (const [key, controls] of this._shortcuts) {
      controls.change.connect("clicked", () => {
        this.extension.uiManager.captureNewShortcut((newShortcut) => {
          // Escape and the other keys go to whichever dialog is on top.
          this.overlay?.grab_key_focus();
          if (newShortcut) {
            this.settings.set_strv(key, [newShortcut]);
            this.extension.keybindingManager?.setupKeybinding();
          }
        });
      });

      controls.reset.connect("clicked", () => {
        this.settings.set_strv(key, [SHORTCUTS[key].fallback]);
        this.extension.keybindingManager?.setupKeybinding();
      });

      controls.remove.connect("clicked", () => {
        Main.wm.removeKeybinding(key);
        this.settings.set_strv(key, []);
      });
    }

    const stepDuration = (delta) => {
      const current = this.settings.get_int("recording-duration");
      const next = Math.max(DURATION_MIN, Math.min(DURATION_MAX, current + delta));
      this.settings.set_int("recording-duration", next);
    };
    this.durationStepper.minus.connect("clicked", () =>
      stepDuration(-DURATION_STEP)
    );
    this.durationStepper.plus.connect("clicked", () =>
      stepDuration(DURATION_STEP)
    );

    // Walks a list of [value, label] pairs kept in a string setting. A value
    // from outside the list steps back onto it.
    const stepChoice = (key, choices, delta) => {
      const current = this.settings.get_string(key);
      const index = choices.findIndex(([value]) => value === current);
      const next =
        index < 0 ? 0 : (index + delta + choices.length) % choices.length;
      this.settings.set_string(key, choices[next][0]);
    };
    this.languageChooser.minus.connect("clicked", () =>
      stepChoice("language", LANGUAGES, -1)
    );
    this.languageChooser.plus.connect("clicked", () =>
      stepChoice("language", LANGUAGES, 1)
    );
    this.voiceChooser.minus.connect("clicked", () =>
      stepChoice("read-aloud-voice", VOICES, -1)
    );
    this.voiceChooser.plus.connect("clicked", () =>
      stepChoice("read-aloud-voice", VOICES, 1)
    );

    const stepSpeed = (delta) => {
      const current = this.settings.get_double("read-aloud-speed");
      // Tenths, so repeated steps do not drift.
      const next = Math.round((current + delta) * 10) / 10;
      this.settings.set_double(
        "read-aloud-speed",
        Math.max(SPEED_MIN, Math.min(SPEED_MAX, next))
      );
    };
    this.speedStepper.minus.connect("clicked", () => stepSpeed(-SPEED_STEP));
    this.speedStepper.plus.connect("clicked", () => stepSpeed(SPEED_STEP));

    this.sampleButton.connect("clicked", () => this.extension.playSample());

    // The controls only write settings; what they show always comes from here.
    this._settingsChangedId = this.settings.connect("changed", () =>
      this._sync()
    );

    // Set up standard modal event handlers (Escape key + click outside to close)
    const handlers = setupModalEventHandlers(this.overlay, () => this.close());
    this.keyPressHandler = handlers.keyPressHandler;
    this.clickHandler = handlers.clickHandler;
  }

  _sync() {
    if (!this.overlay) return;

    for (const [key, controls] of this._shortcuts) {
      const shortcut = this.settings.get_strv(key)[0] ?? null;
      setShortcutKeycaps(controls.keycaps, shortcut);
      controls.reset.reactive = shortcut !== SHORTCUTS[key].fallback;
      controls.remove.reactive = shortcut !== null;
    }

    const duration = this.settings.get_int("recording-duration");
    this.durationStepper.value.set_text(formatDuration(duration));
    this.durationStepper.minus.reactive = duration > DURATION_MIN;
    this.durationStepper.plus.reactive = duration < DURATION_MAX;

    const language = this.settings.get_string("language");
    this.languageChooser.value.set_text(
      LANGUAGES.find(([code]) => code === language)?.[1] ?? language
    );

    const voice = this.settings.get_string("read-aloud-voice");
    this.voiceChooser.value.set_text(
      VOICES.find(([name]) => name === voice)?.[1] ?? voice
    );

    const speed = this.settings.get_double("read-aloud-speed");
    this.speedStepper.value.set_text(`${speed.toFixed(1)}×`);
    this.speedStepper.minus.reactive = speed > SPEED_MIN + 0.01;
    this.speedStepper.plus.reactive = speed < SPEED_MAX - 0.01;

    for (const [key, toggle] of this._switches)
      toggle.checked = this.settings.get_boolean(key);
  }
}
