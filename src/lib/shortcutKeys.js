const MODIFIER_NAMES = {
  Control: "Ctrl",
  Primary: "Ctrl",
  Mod1: "Alt",
  Mod4: "Super",
};

/** "<Control><Alt>h" -> ["Ctrl", "Alt", "H"]. Empty when no shortcut is set. */
export function shortcutKeys(accelerator) {
  if (!accelerator) return [];
  const modifiers = [...accelerator.matchAll(/<([^>]+)>/g)].map(
    ([, name]) => MODIFIER_NAMES[name] ?? name
  );
  const key = accelerator.replace(/<[^>]+>/g, "");
  const label =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return [...modifiers, label].filter(Boolean);
}
