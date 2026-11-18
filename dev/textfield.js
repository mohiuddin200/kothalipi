// A one-field window for the screenshot harness. It mirrors the field's
// contents into the file named on the command line so the harness can see
// what was inserted.
//   gjs -m dev/textfield.js OUTPUT_FILE
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

const output = ARGV[0];
const app = new Gtk.Application({ flags: Gio.ApplicationFlags.NON_UNIQUE });

app.connect("activate", () => {
  const entry = new Gtk.Entry({
    placeholder_text: "Dictated text lands here",
    margin_top: 24,
    margin_bottom: 24,
    margin_start: 24,
    margin_end: 24,
    width_request: 420,
  });
  entry.connect("changed", () => GLib.file_set_contents(output, entry.text));

  const window = new Gtk.ApplicationWindow({
    application: app,
    title: "Kothalipi test field",
    child: entry,
  });
  window.connect("notify::is-active", () => {
    if (window.is_active) GLib.file_set_contents(`${output}.ready`, "");
  });
  window.present();
  entry.grab_focus();
});

app.run([]);
