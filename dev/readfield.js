// A window of selected text for the screenshot harness: what read aloud
// reads. It writes OUTPUT_FILE.ready once the text is selected.
//   gjs -m dev/readfield.js OUTPUT_FILE
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

const TEXT = `Kothalipi reads selected text aloud.

Select text in any app and press Super+Alt+A. A natural voice starts reading within a second or two. Pause it, change its speed or stop it from the pill at the bottom of the screen.

The voice is Kokoro, an open model that runs on your own computer. Nothing you select leaves it.`;

const output = ARGV[0];
const app = new Gtk.Application({ flags: Gio.ApplicationFlags.NON_UNIQUE });

app.connect("activate", () => {
  const view = new Gtk.TextView({
    editable: false,
    wrap_mode: Gtk.WrapMode.WORD,
    top_margin: 20,
    bottom_margin: 20,
    left_margin: 24,
    right_margin: 24,
    width_request: 520,
  });
  view.buffer.text = TEXT;

  const window = new Gtk.ApplicationWindow({
    application: app,
    title: "Kothalipi test text",
    child: view,
  });
  window.connect("notify::is-active", () => {
    if (!window.is_active) return;
    // Selecting makes the text the primary selection, as dragging over it
    // would. GTK does not paint the selection in the harness's screenshots,
    // so a tag paints the same range in the desktop's accent colour.
    view.grab_focus();
    const [start, end] = view.buffer.get_bounds();
    view.buffer.select_range(start, end);
    const shown = new Gtk.TextTag({ background: "#E95420", foreground: "#ffffff" });
    view.buffer.get_tag_table().add(shown);
    view.buffer.apply_tag(shown, start, end);
    GLib.file_set_contents(`${output}.ready`, "");
  });
  window.present();
});

app.run([]);
