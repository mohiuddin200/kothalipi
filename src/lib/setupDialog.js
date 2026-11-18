import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { createCard, createDialog, createWrappedLabel } from "./dialogKit.js";
import {
  log,
  readInstalledServiceConfig,
  showModalDialog,
  closeModalDialog,
  setupModalEventHandlers,
} from "./resourceUtils.js";

export class ServiceSetupDialog {
  constructor(extension, errorMessage) {
    this.extension = extension;
    this.errorMessage = errorMessage;
    this.overlay = null;
    this.centerTimeoutId = null;

    // Installed service environment state (from installer marker file).
    this._installedModel = null;
    this._installedDevice = null;
    this._installedAt = null;
    this._installStateKnown = false;

    // UI refs
    this.statusBox = null;
    this.statusIcon = null;
    this.statusLabel = null;

    this._buildDialog();
  }

  _refreshStatusLabel() {
    const installed = readInstalledServiceConfig();
    this._installStateKnown = installed.known;
    this._installedModel = installed.model;
    this._installedDevice = installed.device;
    this._installedAt = installed.installedAt;

    if (!this.statusLabel) return;

    if (this._installStateKnown) {
      this.statusLabel.set_text(this._getInstalledConfigText());
      this.statusBox.remove_style_class_name("kothalipi-status-warning");
      this.statusIcon.hide();
    } else {
      this.statusLabel.set_text(
        `Service Status: ${this.errorMessage || "Service not installed"}`
      );
      this.statusBox.add_style_class_name("kothalipi-status-warning");
      this.statusIcon.show();
    }
  }

  _buildDialog() {
    const { overlay, dialog, closeButton } = createDialog({
      title: "Kothalipi Service Setup",
      size: "wide",
    });
    this.overlay = overlay;
    this.dialogContainer = dialog;
    this.closeButton = closeButton;

    // Status message (installed state)
    this.statusBox = new St.BoxLayout({ style_class: "kothalipi-status" });
    this.statusBox.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
    this.statusIcon = new St.Icon({
      icon_name: "dialog-warning-symbolic",
      style_class: "kothalipi-status-icon",
      y_align: Clutter.ActorAlign.START,
    });
    this.statusLabel = createWrappedLabel("", "");
    this.statusBox.add_child(this.statusIcon);
    this.statusBox.add_child(this.statusLabel);
    this._refreshStatusLabel();

    const body = new St.BoxLayout({ style_class: "kothalipi-stack", vertical: true });

    // Main explanation
    const explanation =
      "Kothalipi requires a background service for speech processing. " +
      "This service is installed separately from the extension (following GNOME guidelines). " +
      "Installation instructions are maintained in the project repository.";
    body.add_child(createWrappedLabel(explanation, "kothalipi-text"));

    // Link to manual instructions on GitHub
    body.add_child(
      new St.Label({ text: "Manual Installation:", style_class: "kothalipi-subhead" })
    );
    body.add_child(
      createWrappedLabel(
        "For installation instructions, visit the GitHub repository:",
        "kothalipi-text"
      )
    );

    const repoLink = new St.Button({
      label: "https://github.com/mohiuddin200/kothalipi",
      style_class: "kothalipi-link",
      can_focus: true,
      track_hover: true,
      x_align: Clutter.ActorAlign.START,
    });

    repoLink.connect("clicked", () => {
      this._openUrl("https://github.com/mohiuddin200/kothalipi");
    });
    body.add_child(repoLink);

    // Assemble dialog
    this.dialogContainer.add_child(createCard([this.statusBox]));
    this.dialogContainer.add_child(body);

    // Close button handler
    this.closeButton.connect("clicked", () => this.close());

    // Set up standard modal event handlers (Escape key + click outside to close)
    const handlers = setupModalEventHandlers(this.overlay, () => this.close());
    this.keyPressHandler = handlers.keyPressHandler;
    this.clickHandler = handlers.clickHandler;
  }

  _getInstalledConfigText() {
    if (!this._installStateKnown)
      return "Installed service environment: not installed (or unknown)";
    const at = this._installedAt ? `, installed_at=${this._installedAt}` : "";
    return `Installed service environment: model=${
      this._installedModel || "unknown"
    }, device=${this._installedDevice || "unknown"}${at}`;
  }

  _copyToClipboard(text) {
    try {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
      return true;
    } catch (e) {
      console.error(`Error copying to clipboard: ${e}`);
      return false;
    }
  }

  _openUrl(url) {
    try {
      // Use D-Bus portal API for opening URLs safely
      const portal = Gio.DBusProxy.new_sync(
        Gio.DBus.session,
        Gio.DBusProxyFlags.NONE,
        null,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
        null
      );

      portal.call_sync(
        "OpenURI",
        new GLib.Variant("(ssa{sv})", ["", url, {}]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );

      log.debug("Opening GitHub repository in browser...");
    } catch (e) {
      console.error(`Error opening URL via portal: ${e}`);
      try {
        // Fallback to xdg-open if portal fails
        Gio.app_info_launch_default_for_uri(url, null);
      } catch (fallbackError) {
        console.error(`Error opening URL: ${fallbackError}`);
        this._copyToClipboard(url);
      }
    }
  }

  show() {
    if (!this.overlay) return;
    this._refreshStatusLabel();

    // Clear any existing centering timeout
    if (this.centerTimeoutId) {
      GLib.Source.remove(this.centerTimeoutId);
    }
    // showModalDialog returns a timeout ID for widget centering
    this.centerTimeoutId = showModalDialog(this.overlay, this.dialogContainer, {
      fallbackWidth: 700,
      fallbackHeight: 500,
      onComplete: () => (this.centerTimeoutId = null),
    });
  }

  close() {
    closeModalDialog(
      this.overlay,
      {
        keyPressHandler: this.keyPressHandler,
        clickHandler: this.clickHandler,
      },
      this.centerTimeoutId
    );
    this.centerTimeoutId = null;
    this.overlay = null;
  }
}
