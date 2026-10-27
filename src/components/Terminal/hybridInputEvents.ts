export function isEnterLikeLineBreakInputEvent(event: InputEvent): boolean {
  if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") return true;

  if (event.inputType === "insertText") {
    const data = event.data ?? "";
    return data.includes("\n") || data.includes("\r");
  }

  return false;
}

/**
 * The key an Option/Alt chord the agent documents is sent as (`alt+p`), or null
 * when the press should type. The letter is the one the terminal would encode
 * (xterm with Option as Meta reads the key code, then a dead key's physical
 * key), never the glyph Option makes of it, so the composer and the terminal
 * agree on which chord was pressed. AltGr typing never matches: Windows reports
 * it with Ctrl held, Linux as AltGraph.
 */
export function agentAltChordKey(
  event: KeyboardEvent,
  chords: readonly string[] | undefined
): string | null {
  if (!chords || chords.length === 0) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.isComposing || event.getModifierState("AltGraph")) return null;
  const letter = altChordLetter(event);
  return letter !== null && chords.includes(letter) ? `alt+${letter}` : null;
}

function altChordLetter(event: KeyboardEvent): string | null {
  if (event.keyCode >= 65 && event.keyCode <= 90) {
    return String.fromCharCode(event.keyCode).toLowerCase();
  }
  if (event.key === "Dead" && /^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  }
  return null;
}
