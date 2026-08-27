import { useState } from "react";
import { EyeOff, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  usePreferencesStore,
  DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN,
  MAX_ALWAYS_HIDDEN_PATTERNS,
  MAX_ALWAYS_HIDDEN_PATTERN_LENGTH,
} from "@/store/preferencesStore";
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

  const isModified = !sameList(patterns, DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN);

  const commitAdd = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      setError("Match by name only — no slashes");
      return;
    }
    if (trimmed.length > MAX_ALWAYS_HIDDEN_PATTERN_LENGTH) {
      setError("That pattern is too long");
      return;
    }
    if (patterns.includes(trimmed)) {
      setError("Already in the list");
      return;
    }
    // Reject at the cap rather than let the sanitizer silently drop the add
    // while the input clears as though it saved. Keep the draft so it isn't lost.
    if (patterns.length >= MAX_ALWAYS_HIDDEN_PATTERNS) {
      setError("List is full — remove one first");
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
      icon={EyeOff}
      title="Always-hidden files"
      description="Files matching these names stay hidden in every file browser panel, whatever the dotfile toggle. Match by name; use * as a wildcard (for example ._* or *.log)."
    >
      <div className="space-y-3">
        <ul className="flex flex-wrap gap-1.5" aria-label="Always-hidden patterns">
          {patterns.length === 0 && (
            <li className="text-xs text-text-secondary">Nothing is hidden</li>
          )}
          {patterns.map((pattern) => (
            <li
              key={pattern}
              className="flex items-center gap-1 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/50 py-1 pl-2 pr-1 font-mono text-xs text-daintree-text"
            >
              <span className="break-all">{pattern}</span>
              <button
                type="button"
                onClick={() => setPatterns(patterns.filter((p) => p !== pattern))}
                aria-label={`Remove ${pattern}`}
                className="flex h-4 w-4 items-center justify-center rounded text-daintree-text/50 transition-colors hover:bg-daintree-border/50 hover:text-daintree-text"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>

        <div className="flex gap-2">
          <input
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
            className={cn(
              "flex-1 rounded-[var(--radius-md)] border bg-daintree-bg px-3 py-1.5 font-mono text-sm text-daintree-text",
              "focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30",
              error ? "border-status-error/50" : "border-daintree-border"
            )}
          />
          <button
            type="button"
            onClick={commitAdd}
            disabled={draft.trim() === ""}
            aria-label="Add pattern"
            className="flex items-center gap-1 rounded-[var(--radius-md)] border border-daintree-border px-3 py-1.5 text-sm text-daintree-text/70 transition-colors hover:bg-daintree-border/50 hover:text-daintree-text disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>

        {error && <p className="text-xs text-status-error">{error}</p>}

        {isModified && (
          <button
            type="button"
            onClick={() => {
              resetPatterns();
              setError(null);
            }}
            className="flex items-center gap-1 text-xs text-daintree-text/50 transition-colors hover:text-daintree-text"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
