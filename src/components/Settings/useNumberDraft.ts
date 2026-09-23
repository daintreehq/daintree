import { useState } from "react";

/**
 * A number field that keeps what the user typed until it means something. Parsing
 * on every keystroke and committing the result turned "0" into "use the default"
 * and 500 into 120 without a word; now an entry that doesn't parse stays on screen
 * with an error and the stored value is left alone. Clearing the field still resets
 * to the default.
 */
export function useNumberDraft(
  stored: string,
  parse: (raw: string) => number | undefined,
  commit: (value: number | undefined) => void
) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? stored,
    invalid: draft !== null,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      if (raw.trim() === "") {
        setDraft(null);
        commit(undefined);
        return;
      }
      const parsed = parse(raw);
      if (parsed === undefined) {
        setDraft(raw);
        return;
      }
      setDraft(null);
      commit(parsed);
    },
    /** For a reset from outside the field, so a stale invalid draft doesn't linger. */
    clear: () => setDraft(null),
  };
}
