import { useState } from "react";

/**
 * A whole-number field that keeps what the user typed until they commit it with
 * blur or Enter. Committing on every keystroke clamped the "2" of "20" up to the
 * minimum before the "0" arrived, and an emptied field snapped back because "" never
 * parses. An entry that isn't a whole number puts the stored value back; one outside
 * the bounds is corrected to the nearest bound, shown in the field once committed.
 */
export function useCommittedNumberDraft(
  stored: number,
  bounds: { min: number; max: number },
  commit: (value: number) => void
) {
  const [draft, setDraft] = useState<string | null>(null);
  const [seenStored, setSeenStored] = useState(stored);
  // A change from elsewhere (reset, hardware detection, another view) wins over a
  // half-typed entry rather than being overwritten when the field is next committed.
  if (seenStored !== stored) {
    setSeenStored(stored);
    setDraft(null);
  }

  const settle = () => {
    if (draft === null) return;
    setDraft(null);
    const raw = draft.trim();
    const parsed = raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.max(bounds.min, Math.min(bounds.max, parsed));
    if (clamped !== stored) commit(clamped);
  };

  return {
    value: draft ?? String(stored),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: settle,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
      e.preventDefault();
      settle();
    },
    /** For a reset from outside the field, so a half-typed entry doesn't linger. */
    clear: () => setDraft(null),
  };
}
