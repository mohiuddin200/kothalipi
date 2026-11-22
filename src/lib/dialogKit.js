import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import St from "gi://St";

import { shortcutKeys } from "./shortcutKeys.js";

// Building blocks for the extension's dialogs. All of the look lives in
// stylesheet.css under the `kothalipi-` prefix; this file only assembles actors.

const SWITCH_TRAVEL = 14; // track content width minus knob width, in CSS px
const MARK_BARS = [0.3, 0.72, 1, 0.56, 0.3]; // the pill's bars, in miniature

function scaleFactor() {
  return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** A label that wraps instead of pushing its container wider. */
export function createWrappedLabel(text, styleClass) {
  const label = new St.Label({ text, style_class: styleClass, x_expand: true });
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  return label;
}

function createMark() {
  const mark = new St.DrawingArea({
    style_class: "kothalipi-mark",
    y_align: Clutter.ActorAlign.CENTER,
  });
  mark.connect("repaint", (area) => {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    const pitch = width / MARK_BARS.length;
    const bar = pitch * 0.56;
    cr.setSourceRGBA(1, 1, 1, 0.95);
    MARK_BARS.forEach((level, i) => {
      const h = Math.max(bar, height * level);
      const x = i * pitch + (pitch - bar) / 2;
      const y = (height - h) / 2;
      const r = bar / 2;
      cr.newSubPath();
      cr.arc(x + r, y + r, r, Math.PI, 2 * Math.PI);
      cr.arc(x + r, y + h - r, r, 0, Math.PI);
      cr.closePath();
      cr.fill();
    });
    cr.$dispose();
  });
  return mark;
}

export function createIconButton(iconName, accessibleName) {
  return new St.Button({
    style_class: "kothalipi-icon-button",
    can_focus: true,
    track_hover: true,
    accessible_name: accessibleName,
    y_align: Clutter.ActorAlign.CENTER,
    child: new St.Icon({
      icon_name: iconName,
      style_class: "kothalipi-icon",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    }),
  });
}

/** @param {"quiet"|"ghost"} variant */
export function createButton(label, variant = "quiet") {
  return new St.Button({
    label,
    style_class:
      variant === "ghost" ? "kothalipi-button kothalipi-button-ghost" : "kothalipi-button",
    can_focus: true,
    track_hover: true,
    y_align: Clutter.ActorAlign.CENTER,
  });
}

/**
 * The scrim, the dialog surface and its header.
 * @param {object} options
 * @param {string} options.title
 * @param {""|"narrow"|"wide"} [options.size]
 * @returns {{overlay: St.Widget, dialog: St.BoxLayout, closeButton: St.Button}}
 */
export function createDialog({ title, size = "" }) {
  const overlay = new St.Widget({
    style_class: "kothalipi-scrim",
    reactive: true,
    can_focus: true,
    track_hover: true,
  });

  const dialog = new St.BoxLayout({
    style_class: size ? `kothalipi-dialog kothalipi-dialog-${size}` : "kothalipi-dialog",
    vertical: true,
    reactive: true, // a click on the surface is not a click on the scrim
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
  });

  const header = new St.BoxLayout({ style_class: "kothalipi-header" });
  const closeButton = createIconButton("window-close-symbolic", "Close");
  header.add_child(createMark());
  header.add_child(
    new St.Label({
      text: title,
      style_class: "kothalipi-title",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    })
  );
  header.add_child(closeButton);

  dialog.add_child(header);
  overlay.add_child(dialog);
  return { overlay, dialog, closeButton };
}

/**
 * A row of tabs; exactly one is checked. `onChange` gets the new index.
 * @returns {{actor: St.BoxLayout, select: function(number): void}}
 */
export function createTabs(labels, onChange) {
  const actor = new St.BoxLayout({
    style_class: "kothalipi-tabs",
    x_align: Clutter.ActorAlign.START,
  });
  const buttons = labels.map(
    (label) =>
      new St.Button({
        label,
        style_class: "kothalipi-tab",
        can_focus: true,
        track_hover: true,
      })
  );
  const select = (index) => {
    buttons.forEach((button, i) => {
      if (i === index) button.add_style_pseudo_class("checked");
      else button.remove_style_pseudo_class("checked");
    });
    onChange(index);
  };
  buttons.forEach((button, i) => {
    button.connect("clicked", () => select(i));
    actor.add_child(button);
  });
  return { actor, select };
}

/** A rounded group; children are separated by hairlines. */
export function createCard(children = []) {
  const card = new St.BoxLayout({ style_class: "kothalipi-card", vertical: true });
  children.forEach((child, i) => {
    if (i > 0) card.add_child(new St.Widget({ style_class: "kothalipi-divider" }));
    card.add_child(child);
  });
  return card;
}

/** A setting: what it is on the left, its control on the right. */
export function createRow({ title, description = "", control = null }) {
  const text = new St.BoxLayout({
    style_class: "kothalipi-row-text",
    vertical: true,
    x_expand: true,
    y_align: Clutter.ActorAlign.CENTER,
  });
  text.add_child(createWrappedLabel(title, "kothalipi-row-title"));
  if (description)
    text.add_child(createWrappedLabel(description, "kothalipi-row-description"));

  const row = new St.BoxLayout({ style_class: "kothalipi-row" });
  // Horizontal boxes ask for width first, which would give a wrapped
  // description the height of a single line.
  row.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
  row.add_child(text);
  if (control) {
    control.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(control);
  }
  return row;
}

function knobTarget(button) {
  return button.checked ? SWITCH_TRAVEL * scaleFactor() : 0;
}

/** An on/off switch. Read and write its state through `checked`. */
export function createSwitch(accessibleName) {
  // Without the expand flags a bin centres its child and ignores the align.
  const knob = new St.Widget({
    style_class: "kothalipi-switch-knob",
    x_expand: true,
    y_expand: true,
    x_align: Clutter.ActorAlign.START,
    y_align: Clutter.ActorAlign.CENTER,
  });
  const button = new St.Button({
    style_class: "kothalipi-switch",
    toggle_mode: true,
    can_focus: true,
    track_hover: true,
    accessible_name: accessibleName,
    child: knob,
  });
  button.connect("notify::checked", () => {
    knob.ease({
      translation_x: knobTarget(button),
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUINT,
    });
  });
  return button;
}

/** Puts the knob where `checked` says, without the slide. */
export function settleSwitch(button) {
  const knob = button.child;
  knob.remove_all_transitions();
  knob.translation_x = knobTarget(button);
}

/** @returns {{actor: St.BoxLayout, minus: St.Button, plus: St.Button, value: St.Label}} */
export function createStepper(accessibleName) {
  return createValueStepper(
    ["list-remove-symbolic", `Decrease ${accessibleName}`],
    ["list-add-symbolic", `Increase ${accessibleName}`]
  );
}

/** A stepper that walks a short list of choices instead of a number. */
export function createChooser(accessibleName) {
  return createValueStepper(
    ["go-previous-symbolic", `Previous ${accessibleName}`],
    ["go-next-symbolic", `Next ${accessibleName}`]
  );
}

function createValueStepper(minusButton, plusButton) {
  const actor = new St.BoxLayout({ style_class: "kothalipi-stepper" });
  const minus = createIconButton(...minusButton);
  const plus = createIconButton(...plusButton);
  const value = new St.Label({
    style_class: "kothalipi-stepper-value",
    y_align: Clutter.ActorAlign.CENTER,
  });
  actor.add_child(minus);
  actor.add_child(value);
  actor.add_child(plus);
  return { actor, minus, plus, value };
}

export function createKeycaps() {
  return new St.BoxLayout({
    style_class: "kothalipi-keycaps",
    y_align: Clutter.ActorAlign.CENTER,
  });
}

/** Shows `keys` as keycaps, or `emptyText` when there are none. */
export function setKeycaps(box, keys, emptyText) {
  box.destroy_all_children();
  if (keys.length === 0) {
    box.add_child(
      new St.Label({
        text: emptyText,
        style_class: "kothalipi-muted",
        y_align: Clutter.ActorAlign.CENTER,
      })
    );
    return;
  }
  for (const key of keys)
    box.add_child(new St.Label({ text: key, style_class: "kothalipi-keycap" }));
}

export function setShortcutKeycaps(box, accelerator, emptyText = "Not set") {
  setKeycaps(box, shortcutKeys(accelerator), emptyText);
}
