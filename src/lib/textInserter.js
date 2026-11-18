import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

const HELD_MODIFIERS =
  Clutter.ModifierType.CONTROL_MASK |
  Clutter.ModifierType.MOD1_MASK |
  Clutter.ModifierType.SUPER_MASK |
  Clutter.ModifierType.SHIFT_MASK;

function sleep(ms) {
  return new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    })
  );
}

// Puts transcribed text where the user was typing.
export class TextInserter {
  constructor() {
    this._keyboard = null;
  }

  /**
   * @param {string} text
   * @param {object} options
   * @param {boolean} options.insert - place the text at the cursor
   * @param {boolean} options.copy - also leave it on the clipboard
   * @returns {Promise<{method: "inserted"|"pasted"|"clipboard", copied: boolean}>}
   */
  async deliver(text, { insert = true, copy = true } = {}) {
    const clipboard = St.Clipboard.get_default();

    if (insert && Main.inputMethod.currentFocus) {
      // The focused field speaks the text-input protocol: hand it the text
      // directly, the way the on-screen keyboard does. Nothing is simulated,
      // so it works on any keyboard layout and in terminals.
      if (copy) clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
      Main.inputMethod.commit(text);
      return { method: "inserted", copied: copy };
    }

    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

    if (insert && global.display.focus_window && (await this._modifiersFree())) {
      // No text-input field (XWayland and some Electron apps): paste instead.
      // Shift+Insert pastes the clipboard in graphical apps and the primary
      // selection in terminals, so both carry the text.
      clipboard.set_text(St.ClipboardType.PRIMARY, text);
      await this._pressShiftInsert();
      return { method: "pasted", copied: true };
    }

    return { method: "clipboard", copied: true };
  }

  // A paste sent while the shortcut's own keys are still down would arrive
  // as a different shortcut. Give the user a moment to let go.
  async _modifiersFree() {
    for (let i = 0; i < 30; i++) {
      const [, , modifiers] = global.get_pointer();
      if (!(modifiers & HELD_MODIFIERS)) return true;
      await sleep(50);
    }
    return false;
  }

  async _pressShiftInsert() {
    if (!this._keyboard) {
      this._keyboard = Clutter.get_default_backend()
        .get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    const key = (keyval, state) =>
      this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, state);

    key(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
    await sleep(20);
    key(Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
    await sleep(20);
    key(Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
    await sleep(20);
    key(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
  }

  destroy() {
    this._keyboard = null;
  }
}
