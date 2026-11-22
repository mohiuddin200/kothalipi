import Meta from "gi://Meta";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { log } from "./resourceUtils.js";

export class KeybindingManager {
  constructor(extensionCore) {
    this.extensionCore = extensionCore;
    this.currentKeybinding = null;
  }

  setupKeybinding() {
    const settings = this.extensionCore.settings;

    // Remove existing keybinding if it exists
    Main.wm.removeKeybinding("toggle-recording");

    // Get shortcut from settings
    let shortcuts = settings.get_strv("toggle-recording");
    if (shortcuts.length > 0) {
      this.currentKeybinding = shortcuts[0];
    } else {
      // Use a much safer shortcut that doesn't conflict with system shortcuts
      // Avoid Ctrl+C (SIGINT), Ctrl+Z (SIGTSTP), and workspace navigation shortcuts
      this.currentKeybinding = "<Super><Alt>r";
      settings.set_strv("toggle-recording", [this.currentKeybinding]);
    }

    // Register keybinding
    Main.wm.addKeybinding(
      "toggle-recording",
      settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => {
        log.debug("Keyboard shortcut triggered");
        // Use direct reference to this extension instance
        this.extensionCore.toggleRecording();
      }
    );
    log.debug(`Keybinding registered: ${this.currentKeybinding}`);

    // The shell follows this key by itself; an empty list is no shortcut.
    Main.wm.removeKeybinding("read-aloud");
    Main.wm.addKeybinding(
      "read-aloud",
      settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => this.extensionCore.readAloud()
    );
  }

  cleanup() {
    // Remove keybinding
    Main.wm.removeKeybinding("toggle-recording");
    Main.wm.removeKeybinding("read-aloud");
    this.currentKeybinding = null;
  }
}
