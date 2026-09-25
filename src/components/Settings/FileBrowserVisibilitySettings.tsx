import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  usePreferencesStore,
  DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN,
  MAX_ALWAYS_HIDDEN_PATTERNS,
  MAX_ALWAYS_HIDDEN_PATTERN_LENGTH,
} from "@/store/preferencesStore";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Editor for the app-global file-browser "always hidden" junk list (#11330).
 * Every action commits to the store immediately — add, remove, reset — so there
 * is no buffered state to flush and no second tab-flush registration to collide
 * with the host tab's own save lifecycle. The add input is the only local state,
 * committed on Enter or the add button.
 */
export function FileBrowserVisibilitySettings() {
  const patterns = usePreferencesStore((s) => s.fileBrowserAlwaysHiddenPatterns);
  const setPatterns = usePreferencesStore((s) => s.setFileBrowserAlwaysHiddenPatterns);
  const resetPatterns = usePreferencesStore((s) => s.resetFileBrowserAlwaysHiddenPatterns);

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Keys the message, so a refusal repeated word for word is announced again.
  const [errorSeq, setErrorSeq] = useState(0);
  // Removing a chip unmounts the button that had focus; the next chip takes it,
  // then the previous one, then the add field once the list is empty.
  const [focusAfterRemove, setFocusAfterRemove] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusAfterRemove === null) return;
    const next = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-pattern="${CSS.escape(focusAfterRemove)}"]`
    );
    (next ?? inputRef.current)?.focus();
    setFocusAfterRemove(null);
  }, [focusAfterRemove]);

  const removePattern = (pattern: string) => {
    const at = patterns.indexOf(pattern);
    const remaining = patterns.filter((p) => p !== pattern);
    setPatterns(remaining);
    setFocusAfterRemove(remaining[at] ?? remaining[at - 1] ?? "");
  };

  const isModified = !sameList(patterns, DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN);

  // A refusal from the Add button leaves focus on the button; move it to the
  // field the message describes, so the message is read and the fix is one step.
  const refuse = (message: string) => {
    setError(message);
    setErrorSeq((n) => n + 1);
    inputRef.current?.focus();
  };

  const commitAdd = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      refuse("Match by name only — no slashes");
      return;
    }
    if (trimmed.length > MAX_ALWAYS_HIDDEN_PATTERN_LENGTH) {
      refuse("That pattern is too long");
      return;
    }
    if (patterns.includes(trimmed)) {
      refuse("Already in the list");
      return;
    }
    // Reject at the cap rather than let the sanitizer silently drop the add
    // while the input clears as though it saved. Keep the draft so it isn't lost.
    if (patterns.length >= MAX_ALWAYS_HIDDEN_PATTERNS) {
      refuse("List is full — remove one first");
      return;
    }
    // The store re-sanitizes, so this stays the single source of truth for the
    // list's shape; the UI validation above is only for immediate feedback.
    setPatterns([...patterns, trimmed]);
    setDraft("");
    setError(null);
  };

  return (
    <SettingsSection
      id="file-browser-always-hidden"
      title="Always-hidden files"
      description="Files matching these names stay hidden in every file browser panel, whatever the dotfile toggle"
    >
      <SettingsGroup>
        <SettingsRow
          layout="stacked"
          label="Names and patterns"
          description="Match by name; use * as a wildcard (for example ._* or *.log)"
          isModified={isModified}
          onReset={() => {
            resetPatterns();
            setError(null);
          }}
          resetAriaLabel="Reset always-hidden patterns to defaults"
          error={
            error ? (
              <span key={errorSeq} role="alert">
                {error}
              </span>
            ) : undefined
          }
          control={({ labelId, descriptionId }) => (
            <div className="grid gap-3">
              <ul ref={listRef} className="flex flex-wrap gap-1.5" aria-labelledby={labelId}>
                {patterns.length === 0 && (
                  <li className="text-xs text-text-secondary">
                    Add a name or pattern to always hide it
                  </li>
                )}
                {patterns.map((pattern) => (
                  <li
                    key={pattern}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle py-1 pl-2 pr-1 font-mono text-xs text-text-primary"
                  >
                    <span className="break-all">{pattern}</span>
                    <button
                      type="button"
                      onClick={() => removePattern(pattern)}
                      aria-label={`Remove ${pattern}`}
                      data-pattern={pattern}
                      className="flex h-4 w-4 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-overlay-soft hover:text-text-primary"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitAdd();
                    }
                  }}
                  placeholder="Add a name or pattern"
                  aria-label="Add an always-hidden pattern"
                  aria-describedby={descriptionId}
                  aria-invalid={!!error || undefined}
                  invalid={!!error}
                  className="flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={commitAdd}
                  disabled={draft.trim() === ""}
                  aria-label="Add pattern"
                >
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              </div>
            </div>
          )}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
