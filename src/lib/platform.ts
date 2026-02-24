let _isMac: boolean | undefined;

export function isMac(): boolean {
  if (_isMac === undefined) {
    _isMac =
      typeof navigator !== "undefined" &&
      !!navigator.platform &&
      navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  }
  return _isMac;
}

/**
 * Format a keyboard shortcut string for tooltip display using OS-appropriate modifier names.
 * Uses text labels (not symbols) for clarity in tooltips.
 *
 * On macOS: Alt+ becomes Option+
 * On Windows/Linux: Cmd+ becomes Ctrl+, Option+ becomes Alt+
 *
 * Note: Ctrl+ is NOT converted on macOS because some shortcuts intentionally use
 * the physical Control key on all platforms (e.g., Ctrl+Shift+F).
 */
export function formatShortcutForTooltip(shortcut: string): string {
  if (!shortcut) return "";

  let formatted = shortcut;

  if (isMac()) {
    formatted = formatted.replace(/\bAlt\+/gi, "Option+");
    formatted = formatted.replace(/\bAlt\b/gi, "Option");
  } else {
    formatted = formatted.replace(/\bCmd\+/gi, "Ctrl+");
    formatted = formatted.replace(/\bOption\+/gi, "Alt+");
    formatted = formatted.replace(/\bOption\b/gi, "Alt");
  }

  return formatted;
}

/**
 * Create a tooltip string with an OS-appropriate keyboard shortcut appended.
 *
 * @example
 * createTooltipWithShortcut("Show Sidebar", "Cmd+B")
 * // macOS:  "Show Sidebar (Cmd+B)"
 * // Windows: "Show Sidebar (Ctrl+B)"
 */
export function createTooltipWithShortcut(label: string, shortcut: string): string {
  const formatted = formatShortcutForTooltip(shortcut);
  return formatted ? `${label} (${formatted})` : label;
}
