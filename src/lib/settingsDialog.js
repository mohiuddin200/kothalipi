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
  setShortcutKeycaps,
  settleSwitch,
} from "./dialogKit.js";
import {
  showModalDialog,
  closeModalDialog,
  setupModalEventHandlers,
} from "./resourceUtils.js";

const DEFAULT_SHORTCUT = "<Super><Alt>r";
const DURATION_MIN = 10;
const DURATION_MAX = 300;
const DURATION_STEP = 10;

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
      fallbackHeight: 580,
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
  }

  _build() {
    const { overlay, dialog, closeButton } = createDialog({ title: "Settings" });
    this.overlay = overlay;
    this.dialog = dialog;
    this.closeButton = closeButton;

    dialog.add_child(
      createCard([
        this._buildShortcutGroup(),
        this._buildDurationRow(),
        this._buildLanguageRow(),
      ])
    );
    dialog.add_child(
      createCard(toggleSettings().map((setting) => this._buildToggleRow(setting)))
    );
  }

  _buildShortcutGroup() {
    this.shortcutKeycaps = createKeycaps();
    const row = createRow({
      title: "Dictation shortcut",
      description: "Press it anywhere to start or stop dictating.",
      control: this.shortcutKeycaps,
    });

    this.changeShortcutButton = createButton("Change");
    this.resetToDefaultButton = createButton("Reset to default", "ghost");
    this.removeShortcutButton = createButton("Remove", "ghost");

    const actions = new St.BoxLayout({ style_class: "kothalipi-row-actions" });
    actions.add_child(this.changeShortcutButton);
    actions.add_child(this.resetToDefaultButton);
    actions.add_child(this.removeShortcutButton);

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

    this.changeShortcutButton.connect("clicked", () => {
      this.extension.uiManager.captureNewShortcut((newShortcut) => {
        // Escape and the other keys go to whichever dialog is on top.
        this.overlay?.grab_key_focus();
        if (newShortcut) {
          this.settings.set_strv("toggle-recording", [newShortcut]);
          this.extension.keybindingManager?.setupKeybinding();
        }
      });
    });

    this.resetToDefaultButton.connect("clicked", () => {
      this.settings.set_strv("toggle-recording", [DEFAULT_SHORTCUT]);
      this.extension.keybindingManager?.setupKeybinding();
    });

    this.removeShortcutButton.connect("clicked", () => {
      Main.wm.removeKeybinding("toggle-recording");
      this.settings.set_strv("toggle-recording", []);
    });

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

    const stepLanguage = (delta) => {
      const current = this.settings.get_string("language");
      const index = LANGUAGES.findIndex(([code]) => code === current);
      // A code from outside the list steps back onto it.
      const next =
        index < 0 ? 0 : (index + delta + LANGUAGES.length) % LANGUAGES.length;
      this.settings.set_string("language", LANGUAGES[next][0]);
    };
    this.languageChooser.minus.connect("clicked", () => stepLanguage(-1));
    this.languageChooser.plus.connect("clicked", () => stepLanguage(1));

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

    const shortcut = this.settings.get_strv("toggle-recording")[0] ?? null;
    setShortcutKeycaps(this.shortcutKeycaps, shortcut);
    this.resetToDefaultButton.reactive = shortcut !== DEFAULT_SHORTCUT;
    this.removeShortcutButton.reactive = shortcut !== null;

    const duration = this.settings.get_int("recording-duration");
    this.durationStepper.value.set_text(formatDuration(duration));
    this.durationStepper.minus.reactive = duration > DURATION_MIN;
    this.durationStepper.plus.reactive = duration < DURATION_MAX;

    const language = this.settings.get_string("language");
    this.languageChooser.value.set_text(
      LANGUAGES.find(([code]) => code === language)?.[1] ?? language
    );

    for (const [key, toggle] of this._switches)
      toggle.checked = this.settings.get_boolean(key);
  }
}
