import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  createButton,
  createCard,
  createDialog,
  createKeycaps,
  createWrappedLabel,
  setKeycaps,
} from "./dialogKit.js";
import { showModalDialog, closeModalDialog } from "./resourceUtils.js";

export class ShortcutCapture {
  constructor() {
    this.overlay = null;
    this.captureWindow = null;
    this.keyPressHandler = null;
    this.keyReleaseHandler = null;
    this.clickHandler = null;
    this.centerTimeoutId = null;
    this.callback = null;
  }

  capture(callback) {
    this.callback = callback;

    const { overlay, dialog, closeButton } = createDialog({
      title: "Set shortcut",
      size: "narrow",
    });
    this.overlay = overlay;
    this.captureWindow = dialog;
    this.closeButton = closeButton;
    this.closeButton.connect("clicked", () => {
      this._cancel();
    });

    // Instructions
    const instructions = new St.BoxLayout({
      style_class: "kothalipi-stack",
      vertical: true,
    });
    instructions.add_child(
      createWrappedLabel("Press the key combination you want to use", "kothalipi-text")
    );
    instructions.add_child(
      createWrappedLabel(
        "Use modifier keys (Ctrl, Alt, Shift, Super) + a letter or key",
        "kothalipi-muted"
      )
    );
    this.captureWindow.add_child(instructions);

    // Clear any existing centering timeout
    if (this.centerTimeoutId) {
      GLib.Source.remove(this.centerTimeoutId);
    }
    // showModalDialog returns a timeout ID for widget centering
    this.centerTimeoutId = showModalDialog(this.overlay, this.captureWindow, {
      fallbackWidth: 400,
      fallbackHeight: 250,
      onComplete: () => (this.centerTimeoutId = null),
    });

    // State tracking for modifier keys
    let modifierState = {
      control: false,
      shift: false,
      alt: false,
      super: false,
    };

    // The keys held so far
    const heldKeys = createKeycaps();
    heldKeys.x_align = Clutter.ActorAlign.CENTER;
    heldKeys.x_expand = true;
    const well = new St.BoxLayout({ style_class: "kothalipi-capture-well" });
    well.add_child(heldKeys);
    this.captureWindow.add_child(createCard([well]));

    // Cancel button
    const buttonBox = new St.BoxLayout({
      vertical: false,
      x_align: Clutter.ActorAlign.END,
    });
    const cancelButton = createButton("Cancel");
    cancelButton.connect("clicked", () => {
      this._cancel();
    });
    buttonBox.add_child(cancelButton);
    this.captureWindow.add_child(buttonBox);

    // Function to update the display
    const updateDisplay = () => {
      let parts = [];
      if (modifierState.control) parts.push("Ctrl");
      if (modifierState.shift) parts.push("Shift");
      if (modifierState.alt) parts.push("Alt");
      if (modifierState.super) parts.push("Super");

      setKeycaps(heldKeys, parts, "Waiting for key combination...");
    };
    updateDisplay();

    // Modal overlay click handler (close on backdrop click)
    this.clickHandler = this.overlay.connect(
      "button-press-event",
      (actor, event) => {
        if (event.get_source() === this.overlay) {
          this._cancel();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      }
    );

    // Capture keyboard input with better modifier handling
    this.keyPressHandler = this.overlay.connect(
      "key-press-event",
      (actor, event) => {
        const keyval = event.get_key_symbol();
        const keyName = Clutter.keyval_name(keyval);

        if (keyval === Clutter.KEY_Escape) {
          this._cancel();
          return Clutter.EVENT_STOP;
        }

        // Update modifier state based on actual key presses
        if (keyName === "Control_L" || keyName === "Control_R") {
          modifierState.control = true;
          updateDisplay();
          return Clutter.EVENT_STOP;
        }
        if (keyName === "Shift_L" || keyName === "Shift_R") {
          modifierState.shift = true;
          updateDisplay();
          return Clutter.EVENT_STOP;
        }
        if (keyName === "Alt_L" || keyName === "Alt_R") {
          modifierState.alt = true;
          updateDisplay();
          return Clutter.EVENT_STOP;
        }
        if (keyName === "Super_L" || keyName === "Super_R") {
          modifierState.super = true;
          updateDisplay();
          return Clutter.EVENT_STOP;
        }

        // If it's a regular key (not just a modifier), complete the shortcut
        if (
          keyName &&
          !keyName.includes("_L") &&
          !keyName.includes("_R") &&
          !keyName.startsWith("Control") &&
          !keyName.startsWith("Shift") &&
          !keyName.startsWith("Alt") &&
          !keyName.startsWith("Super")
        ) {
          // Build final shortcut string
          let shortcut = "";
          if (modifierState.control) shortcut += "<Control>";
          if (modifierState.shift) shortcut += "<Shift>";
          if (modifierState.alt) shortcut += "<Alt>";
          if (modifierState.super) shortcut += "<Super>";
          shortcut += keyName.toLowerCase();

          // Clean up and return result
          this._complete(shortcut);
          return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
      }
    );

    // Also handle key release to reset modifier state if needed
    this.keyReleaseHandler = this.overlay.connect("key-release-event", () => {
      // Don't reset modifiers on release - let user build combination
      // This allows holding multiple modifiers before pressing the final key
      return Clutter.EVENT_STOP;
    });
  }

  _cancel() {
    const cb = this.callback;
    this.cleanup();
    if (cb) cb(null);
  }

  _complete(shortcut) {
    const cb = this.callback;
    this.cleanup();
    if (cb) cb(shortcut);
  }

  cleanup() {
    closeModalDialog(
      this.overlay,
      {
        keyPressHandler: this.keyPressHandler,
        keyReleaseHandler: this.keyReleaseHandler,
        clickHandler: this.clickHandler,
      },
      this.centerTimeoutId
    );
    this.centerTimeoutId = null;
    this.overlay = null;
    this.captureWindow = null;
    this.keyPressHandler = null;
    this.keyReleaseHandler = null;
    this.clickHandler = null;
    this.callback = null;
  }
}
