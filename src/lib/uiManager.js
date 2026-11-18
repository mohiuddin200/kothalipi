import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { FlowPill } from "./flowPill.js";
import { SettingsDialog } from "./settingsDialog.js";
import { ServiceSetupDialog } from "./setupDialog.js";
import { ShortcutCapture } from "./shortcutCapture.js";
import { shortcutKeys } from "./shortcutKeys.js";
import { log } from "./resourceUtils.js";

// "<Control><Alt>h" -> "Ctrl+Alt+H"
function formatShortcut(accelerator) {
  return shortcutKeys(accelerator).join("+");
}

export class UIManager {
  constructor(extensionCore) {
    this.extensionCore = extensionCore;
    this.icon = null;
    this.iconWidget = null;
    this.pill = null;
    this.settingsDialog = null;
    this._settingsSignals = [];
  }

  initialize() {
    // Create the panel button
    this.icon = new PanelMenu.Button(0.0, "Kothalipi Indicator");

    const iconBox = new St.BoxLayout({
      style_class: "panel-status-indicators-box",
    });

    // Set up the icon
    this.iconWidget = new St.Icon({
      gicon: Gio.icon_new_for_string(
        `${this.extensionCore.path}/icons/voice-cursor-symbolic.svg`
      ),
      style_class: "system-status-icon",
    });
    iconBox.add_child(this.iconWidget);

    this.icon.add_child(iconBox);

    // Create popup menu
    this.createPopupMenu();

    // Add click handler for left-click recording toggle
    this._setupClickHandler();

    // Add to panel (remove existing first to avoid conflicts)
    this._addToPanel();

    this._createPill();
  }

  _createPill() {
    const core = this.extensionCore;
    const settings = core.settings;

    this.pill = new FlowPill({
      onStart: () => core.toggleRecording(),
      onStop: () => core.recordingController?.stop(),
      onCancel: () => core.recordingController?.cancel(),
      onSecondary: () => this.showSettingsWindow(),
    });

    const syncShortcut = () =>
      this.pill?.setShortcutLabel(
        formatShortcut(settings.get_strv("toggle-recording")[0])
      );
    const syncIdle = () =>
      this.pill?.setIdleVisible(settings.get_boolean("show-idle-pill"));

    this._settingsSignals = [
      settings.connect("changed::toggle-recording", syncShortcut),
      settings.connect("changed::show-idle-pill", syncIdle),
    ];
    syncShortcut();
    syncIdle();
  }

  createPopupMenu() {
    // Settings menu item
    let settingsItem = new PopupMenu.PopupMenuItem("Settings");
    settingsItem.connect("activate", () => {
      this.showSettingsWindow();
    });
    this.icon.menu.addMenuItem(settingsItem);

    // Setup Guide menu item
    let setupItem = new PopupMenu.PopupMenuItem("Setup");
    setupItem.connect("activate", () => {
      this.showServiceSetupDialog("Manual setup guide requested");
    });
    this.icon.menu.addMenuItem(setupItem);
  }

  _setupClickHandler() {
    this.icon.connect("button-press-event", (actor, event) => {
      const buttonPressed = event.get_button();

      if (buttonPressed === 1) {
        // Left click - toggle recording
        this.icon.menu.close(true);
        log.debug("Click handler triggered");

        // Use direct reference to this extension instance
        this.extensionCore.toggleRecording();
        return Clutter.EVENT_STOP;
      } else if (buttonPressed === 3) {
        // Right click - show menu
        return Clutter.EVENT_PROPAGATE;
      }

      return Clutter.EVENT_STOP;
    });
  }

  _addToPanel() {
    try {
      // Remove any existing indicator first
      Main.panel.statusArea["kothalipi-indicator"]?.destroy();
      delete Main.panel.statusArea["kothalipi-indicator"];
    } catch (e) {
      log.debug("No existing indicator to remove:", e.message);
    }

    Main.panel.addToStatusArea("kothalipi-indicator", this.icon);
  }

  showSettingsWindow() {
    if (!this.extensionCore.settings) {
      console.error("Extension not properly enabled, cannot show settings");
      return;
    }

    if (!this.settingsDialog) {
      this.settingsDialog = new SettingsDialog(this.extensionCore);
    }
    this.settingsDialog.show();
  }

  showServiceSetupDialog(errorMessage) {
    const setupDialog = new ServiceSetupDialog(
      this.extensionCore,
      errorMessage
    );
    setupDialog.show();
  }

  notify(title, message) {
    Main.notify(title, message);
  }

  captureNewShortcut(callback) {
    const shortcutCapture = new ShortcutCapture();
    shortcutCapture.capture(callback);
  }

  cleanup() {
    for (const id of this._settingsSignals)
      this.extensionCore.settings?.disconnect(id);
    this._settingsSignals = [];

    if (this.pill) {
      this.pill.destroy();
      this.pill = null;
    }

    // Close settings dialog
    if (this.settingsDialog) {
      log.debug("Closing settings dialog");
      this.settingsDialog.close({ animate: false });
      this.settingsDialog = null;
    }

    // Clean up panel icon first (CRITICAL for avoiding conflicts)
    try {
      if (this.icon) {
        log.debug("Removing panel icon from status area");
        this.icon.destroy();
        this.icon = null;
      }

      // Remove from status area to prevent conflicts
      if (Main.panel.statusArea["kothalipi-indicator"]) {
        log.debug("Cleaning up status area indicator");
        Main.panel.statusArea["kothalipi-indicator"].destroy();
        delete Main.panel.statusArea["kothalipi-indicator"];
      }
    } catch (error) {
      log.warn("Error cleaning up panel icon:", error.message);
      // Force cleanup even if there are errors
      this.icon = null;
      try {
        delete Main.panel.statusArea["kothalipi-indicator"];
      } catch (e) {
        // Ignore secondary cleanup errors
      }
    }
  }
}
