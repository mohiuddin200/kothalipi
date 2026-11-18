// A terminal window for the screenshot harness, built on the same widget
// GNOME Terminal uses (GTK 3 + VTE). The shell inside reads COUNT characters
// and writes them to OUTPUT_FILE, so the harness can see what the terminal
// actually received.
//   gjs -m dev/termfield.js OUTPUT_FILE COUNT
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=3.0";
import Vte from "gi://Vte?version=2.91";

const [output, count] = ARGV;
Gtk.init(null);

const terminal = new Vte.Terminal();
terminal.spawn_async(
  Vte.PtyFlags.DEFAULT,
  null,
  [
    "/bin/bash",
    "--norc",
    "-c",
    `IFS= read -r -N ${parseInt(count, 10)} text; printf %s "$text" > "$0"; sleep 60`,
    output,
  ],
  null,
  GLib.SpawnFlags.DEFAULT,
  null,
  -1,
  null,
  null
);

const window = new Gtk.Window({
  title: "Kothalipi test terminal",
  default_width: 640,
  default_height: 180,
});
window.add(terminal);
window.connect("notify::is-active", () => {
  if (window.is_active) GLib.file_set_contents(`${output}.ready`, "");
});
window.connect("destroy", () => Gtk.main_quit());
window.show_all();
terminal.grab_focus();
Gtk.main();
