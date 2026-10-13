/**
 * Default chords that differ by platform. Linux desktops grab Ctrl+Alt+T for
 * their own terminal, so Daintree binds terminal.new to Ctrl+Shift+Alt+T there
 * (shared/config/defaultKeybindings.ts, LINUX_REPLACEMENT_KEYBINDINGS).
 */
export const NEW_TERMINAL_CHORD =
  process.platform === "darwin"
    ? "Meta+Alt+t"
    : process.platform === "linux"
      ? "Control+Shift+Alt+t"
      : "Control+Alt+t";
