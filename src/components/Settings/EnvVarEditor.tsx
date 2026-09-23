import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { looksLikeSecret } from "@/utils/secretDetection";
import { isSensitiveEnvKey } from "../../../shared/utils/envVars";
import { ImportEnvDialog } from "./ImportEnvDialog";
import { Button } from "@/components/ui/button";
import { useRowFocus } from "./useRowFocus";
import { ENV_KEY_DUPLICATE_MESSAGE, ENV_KEY_INVALID_MESSAGE, isValidEnvKey } from "./EnvVarRow";

/**
 * Inline env var CRUD editor with validation and optional inheritance.
 *
 * Renders a bordered table surface with flush cells, hairline row dividers,
 * and a flush "Add variable" row — matching the chrome of Vercel/Railway/GitHub
 * Actions env editors. Draft rows are the source of truth during editing — we
 * can't represent an in-progress duplicate key as a JS object, so we keep an
 * array of `{rowId, key, value, isInherited}` and serialize back to a
 * `Record<string, string>` only when all keys are unique and non-empty.
 *
 * Inheritance (optional, via `inheritedEnv` prop):
 *  - Inherited rows render disabled and muted, with a `+ Override` action in
 *    the actions cell that promotes the row to an editable override seeded
 *    with the inherited value.
 *  - Override rows (env entries that shadow an inherited key) get a
 *    modified left-stripe and a revert (RotateCcw) action that clears the override
 *    back to inherited.
 *  - Clearing an override's value on blur also reverts to inherited, so we
 *    don't silently ship empty-string overrides.
 *
 * Validation surfaces:
 *  - Empty key after trim → error stripe on the row + "Enter a name" under the
 *    key. Blur on an empty key does NOT persist.
 *  - Duplicate key → error stripe on both matching rows + a message under the
 *    key. The second occurrence is not persisted until resolved.
 *  - Literal secret value → warning stripe + an advisory under the value.
 *    Values still commit (warning is advisory only).
 *
 *  Messages sit in the row's flow, under the field they describe, and are
 *  referenced by it: squeezed into the cell at a 4xs size they were the smallest
 *  text on the page at exactly the moment the row needed reading.
 *
 * Reveal toggle: when the key name matches `isSensitiveEnvKey` or the value
 * matches `looksLikeSecret`, an eye toggle appears in the value cell and the
 * input renders as `type="password"` until the user reveals it. Revealed rows
 * are session-scoped and cleared on `contextKey` change.
 */

export interface EnvVarSuggestion {
  key: string;
  hint: string;
}

export interface EnvVarEditorProps {
  /** Current env var map (source of truth from parent). */
  env: Record<string, string>;
  /** Called with the new map when a valid change occurs. Empty map → {}. */
  onChange: (env: Record<string, string>) => void;
  /** Optional list of suggested KEY names (with hints) to speed up common setups. */
  suggestions?: EnvVarSuggestion[];
  /** Optional "keyed" identity (e.g. presetId) — used to reset draft rows when the parent context changes. */
  contextKey?: string;
  /** Placeholder text for the value input. */
  valuePlaceholder?: string;
  /** Optional data-testid for the whole editor surface. */
  "data-testid"?: string;
  /**
   * Optional inherited env vars from a parent scope (e.g. an agent's global
   * env when editing a preset). Inherited rows render as muted, disabled
   * entries alongside overrides; absence of the prop disables inheritance
   * entirely (identical to the original editor behaviour).
   */
  inheritedEnv?: Record<string, string>;
}

interface DraftRow {
  rowId: string;
  key: string;
  value: string;
  isInherited: boolean;
}

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `row-${rowIdCounter}`;
}

function normalizePastedEnvValue(raw: string): string {
  return raw
    .replace(/[‘’‛‚′ʼ]/g, "'")
    .replace(/[“”‟„″]/g, '"')
    .replace(/[–—]/g, "-")
    .trim();
}

function envToDraft(
  env: Record<string, string>,
  inheritedEnv?: Record<string, string>
): DraftRow[] {
  const rows: DraftRow[] = [];
  // Preserve insertion order of env entries — these are overrides.
  for (const [key, value] of Object.entries(env)) {
    rows.push({ rowId: nextRowId(), key, value, isInherited: false });
  }
  if (inheritedEnv) {
    // Append inherited-only keys in their insertion order.
    for (const [key, value] of Object.entries(inheritedEnv)) {
      if (key in env) continue;
      rows.push({ rowId: nextRowId(), key, value, isInherited: true });
    }
  }
  return rows;
}

function draftToEnv(rows: DraftRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.isInherited) continue;
    const k = row.key.trim();
    if (!k) continue;
    if (seen.has(k)) continue; // drop duplicates — the validation surface warns the user
    seen.add(k);
    out[k] = row.value;
  }
  return out;
}

function shallowEnvEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === undefined && b === undefined;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function findDuplicateKeys(rows: DraftRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.isInherited) continue;
    const k = row.key.trim();
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [k, n] of counts) {
    if (n > 1) dups.add(k);
  }
  return dups;
}

function isValid(rows: DraftRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.isInherited) continue;
    const k = row.key.trim();
    if (!k) return false;
    if (!isValidEnvKey(k)) return false;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

const EMPTY_SUGGESTIONS: EnvVarSuggestion[] = [];

interface EnvVarKeyCellProps {
  rowId: string;
  /** 1-based position, for a field name that means something when read aloud. */
  position: number;
  value: string;
  suggestions: EnvVarSuggestion[];
  usedKeys: Set<string>;
  disabled: boolean;
  isEmptyKey: boolean;
  isDuplicate: boolean;
  /** The name is present but not something a shell can export. */
  isMalformed: boolean;
  onChange: (rowId: string, newKey: string) => void;
  onBlur: (rowId: string) => void;
  /**
   * Picker selection — must commit synchronously. Distinct from `onChange` so
   * the parent can both update the row AND drive `onChange(env)` in the same
   * pass (clicking a suggestion otherwise loses the selection: the input's
   * blur fires before the option's click, and the blur path commits the OLD
   * key before the click can update the row).
   */
  onSelect: (rowId: string, newKey: string) => void;
  registerRef: (rowId: string, el: HTMLInputElement | null) => void;
}

/**
 * Per-row key cell with a Radix Popover suggestion picker.
 *
 * Replaces the native `<datalist>` indicator (Chromium's is unreliable in
 * Electron — clicks often do nothing, content can't be styled, hint text
 * isn't surfaced). State (open / activeIndex) is local so opening one row's
 * popover doesn't re-render other rows. Focus stays on the input while the
 * popover is open via `onOpenAutoFocus` preventDefault, and is restored on
 * close via `onCloseAutoFocus`.
 */
function EnvVarKeyCell({
  rowId,
  position,
  value,
  suggestions,
  usedKeys,
  disabled,
  isEmptyKey,
  isDuplicate,
  isMalformed,
  onChange,
  onBlur,
  onSelect,
  registerRef,
}: EnvVarKeyCellProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `env-key-suggestions-${rowId}`;
  const messageId = `env-key-message-${rowId}`;
  const hasError = isEmptyKey || isDuplicate || isMalformed;

  const trimmedValue = value.trim();
  const availableSuggestions = useMemo(() => {
    return suggestions.filter((s) => !usedKeys.has(s.key) && s.key !== trimmedValue);
  }, [suggestions, usedKeys, trimmedValue]);

  // Clamp activeIndex when the available list shrinks (another row took a key).
  useEffect(() => {
    setActiveIndex((i) => (i >= availableSuggestions.length ? availableSuggestions.length - 1 : i));
  }, [availableSuggestions.length]);

  // Reset highlight when the popover closes so the next open starts unhighlighted.
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  const handleSelect = (key: string) => {
    onSelect(rowId, key);
    setOpen(false);
  };

  const showChevron = availableSuggestions.length > 0 && !disabled;

  return (
    <div className="flex flex-col">
      <div className="relative">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <input
              ref={(el) => {
                inputRef.current = el;
                registerRef(rowId, el);
              }}
              type="text"
              className={cn(
                ENV_CELL_INPUT,
                showChevron ? "pl-2.5 pr-8" : "px-2.5",
                disabled ? "text-text-secondary" : "text-text-primary"
              )}
              value={value}
              placeholder="KEY"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={disabled}
              aria-label={`Name of variable ${position}`}
              aria-invalid={hasError ? "true" : undefined}
              aria-describedby={hasError ? messageId : undefined}
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                open && activeIndex >= 0 ? `env-key-option-${rowId}-${activeIndex}` : undefined
              }
              onChange={(e) => onChange(rowId, e.target.value)}
              onBlur={() => onBlur(rowId)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  if (availableSuggestions.length === 0) return;
                  e.preventDefault();
                  if (!open) {
                    setOpen(true);
                    setActiveIndex(0);
                  } else {
                    setActiveIndex((i) =>
                      i + 1 >= availableSuggestions.length ? availableSuggestions.length - 1 : i + 1
                    );
                  }
                } else if (e.key === "ArrowUp") {
                  if (!open) return;
                  e.preventDefault();
                  setActiveIndex((i) => (i <= 0 ? 0 : i - 1));
                } else if (e.key === "Enter" && open && activeIndex >= 0) {
                  e.preventDefault();
                  const sel = availableSuggestions[activeIndex];
                  if (sel) handleSelect(sel.key);
                } else if (e.key === "Escape") {
                  if (open) {
                    // Close the popover first; don't bubble to the surrounding
                    // dialog's Escape handler.
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                  } else {
                    e.currentTarget.blur();
                  }
                }
              }}
              data-testid="env-editor-key"
            />
          </PopoverAnchor>
          {showChevron && (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Show name suggestions for variable ${position}`}
                tabIndex={-1}
                onMouseDown={(e) => {
                  // Keep focus on the input — without this, clicking the chevron
                  // moves focus to the button and subsequent keyboard nav (Arrow,
                  // Enter) wouldn't fire on the input's onKeyDown handler.
                  e.preventDefault();
                  inputRef.current?.focus();
                }}
                className={cn(ENV_CELL_ACTION, "absolute right-1 top-1/2 -translate-y-1/2")}
                data-testid="env-editor-key-suggestions-trigger"
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </PopoverTrigger>
          )}
          <PopoverContent
            align="start"
            sideOffset={4}
            className="p-1 min-w-52 w-auto"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
            data-testid="env-editor-key-suggestions-listbox"
          >
            <div role="listbox" id={listboxId} aria-label="Env var key suggestions">
              {availableSuggestions.map((s, idx) => (
                <div
                  key={s.key}
                  id={`env-key-option-${rowId}-${idx}`}
                  role="option"
                  aria-selected={idx === activeIndex}
                  onClick={() => handleSelect(s.key)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={cn(
                    "flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer",
                    idx === activeIndex && "bg-overlay-soft"
                  )}
                  data-testid="env-editor-key-suggestion"
                >
                  <span className="font-mono text-xs text-text-primary shrink-0">{s.key}</span>
                  {s.hint && (
                    <span className="text-2xs text-text-secondary leading-snug">{s.hint}</span>
                  )}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {hasError && (
        <p
          id={messageId}
          className="px-2.5 pb-2 text-xs text-status-error"
          data-testid={
            isEmptyKey
              ? "env-editor-error-empty"
              : isMalformed
                ? "env-editor-error-invalid"
                : "env-editor-error-duplicate"
          }
        >
          {isEmptyKey
            ? "Enter a name"
            : isMalformed
              ? ENV_KEY_INVALID_MESSAGE
              : ENV_KEY_DUPLICATE_MESSAGE}
        </p>
      )}
    </div>
  );
}

/** A borderless field filling its table cell; the ring is inset so it stays inside the cell. */
const ENV_CELL_INPUT = cn(
  "w-full bg-transparent border-0 outline-hidden py-2 font-mono text-xs leading-[inherit]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
  "disabled:cursor-default"
);

/** Icon actions inside the table, at the 24px target minimum. */
const ENV_CELL_ACTION =
  "flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors";

// Auto-clear duration for the "Pasted text normalized" inline indicator.
// Long enough to read at a glance; short enough to feel ephemeral.
const NORMALIZED_INDICATOR_TTL_MS = 2000;

export function EnvVarEditor({
  env,
  onChange,
  suggestions,
  contextKey,
  valuePlaceholder = "value or ${ENV_VAR}",
  "data-testid": dataTestId,
  inheritedEnv,
}: EnvVarEditorProps) {
  const [rows, setRows] = useState<DraftRow[]>(() => envToDraft(env, inheritedEnv));
  // Track which keys have been "touched" (blurred or modified after creation) —
  // we suppress the empty-key error for newly added rows until first blur.
  const [touchedKeys, setTouchedKeys] = useState<Record<string, boolean>>({});
  // Per-row reveal state for secret values. Session-scoped, cleared on context switch.
  const [revealedRows, setRevealedRows] = useState<Set<string>>(() => new Set());
  // When non-null, the focus-recovery effect focuses the key input for that rowId.
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const focus = useRowFocus();
  // Per-row "Pasted text normalized" inline indicator. Auto-clears after 2s.
  const [normalizedRows, setNormalizedRows] = useState<Set<string>>(() => new Set());
  const normalizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastEnvRef = useRef<Record<string, string>>(env);
  const lastInheritedRef = useRef<Record<string, string> | undefined>(inheritedEnv);
  const lastContextKeyRef = useRef<string | undefined>(contextKey);
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // When the parent's env or inheritedEnv changes externally (different preset
  // selected, programmatic reset, global env updated), reseed the draft rows.
  // We use shallow key+value compares so typing a value doesn't trigger a
  // reseed and new-identity empty objects (`{} !== {}`) don't cause thrash.
  useEffect(() => {
    const envChanged = !shallowEnvEqual(env, lastEnvRef.current);
    const inheritedChanged = !shallowEnvEqual(inheritedEnv, lastInheritedRef.current);
    const contextChanged = lastContextKeyRef.current !== contextKey;
    if (!contextChanged && !envChanged && !inheritedChanged) return;

    lastEnvRef.current = env;
    lastInheritedRef.current = inheritedEnv;
    lastContextKeyRef.current = contextKey;
    if (contextChanged) {
      setTouchedKeys({});
      setRevealedRows(new Set());
      normalizeTimers.current.forEach((t) => clearTimeout(t));
      normalizeTimers.current.clear();
      setNormalizedRows(new Set());
    }
    // Only reseed if the incoming env+inheritance actually differs from what
    // our current draft would produce. Otherwise the parent's commit echo
    // would stomp an in-progress edit.
    const draftAsEnv = draftToEnv(rows);
    if (contextChanged || inheritedChanged || !shallowEnvEqual(draftAsEnv, env)) {
      setRows(envToDraft(env, inheritedEnv));
    }
  }, [env, inheritedEnv, contextKey, rows]);

  // Clear any pending normalize-indicator timers on unmount so we don't
  // setState on an unmounted component.
  useEffect(() => {
    const timers = normalizeTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Focus recovery after adding a row. Narrowly keyed to avoid cross-firing
  // with the reseed effect above.
  useEffect(() => {
    if (pendingFocusKey === null) return;
    const input = keyInputRefs.current.get(pendingFocusKey);
    if (input) {
      input.focus();
      input.select();
    }
    setPendingFocusKey(null);
  }, [pendingFocusKey]);

  const commitIfValid = (nextRows: DraftRow[]) => {
    if (isValid(nextRows)) {
      const nextEnv = draftToEnv(nextRows);
      // Intentionally do NOT update lastEnvRef here. The ref tracks the last
      // env *prop* value — if we seed it with our synthesized commit, the
      // subsequent effect pass will read env (still the stale prop) and
      // mistake it for an external reset, triggering a reseed that stomps
      // the in-progress edit. Let the prop echo back from the parent and
      // update lastEnvRef there.
      if (!shallowEnvEqual(lastEnvRef.current, nextEnv)) {
        onChange(nextEnv);
      }
    }
  };

  const handleAdd = () => {
    const newRowId = nextRowId();
    setRows((prev) => {
      // Pick a KEY name that isn't already present (including inherited keys).
      let candidate = "NEW_VAR";
      let i = 1;
      const present = new Set(prev.map((r) => r.key.trim()));
      while (present.has(candidate)) candidate = `NEW_VAR_${i++}`;
      const newRow: DraftRow = {
        rowId: newRowId,
        key: candidate,
        value: "",
        isInherited: false,
      };
      // Insert before the inherited-only tail so new overrides stay grouped
      // with existing overrides.
      const firstInheritedIdx = prev.findIndex((r) => r.isInherited);
      if (firstInheritedIdx === -1) {
        return [...prev, newRow];
      }
      return [...prev.slice(0, firstInheritedIdx), newRow, ...prev.slice(firstInheritedIdx)];
    });
    setPendingFocusKey(newRowId);
  };

  const handleRemove = (rowId: string) => {
    focus.focusAfterDelete(
      rows.map((r) => r.rowId),
      rows.findIndex((r) => r.rowId === rowId)
    );
    const priorTimer = normalizeTimers.current.get(rowId);
    if (priorTimer) {
      clearTimeout(priorTimer);
      normalizeTimers.current.delete(rowId);
    }
    setNormalizedRows((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
    setRows((prev) => {
      const row = prev.find((r) => r.rowId === rowId);
      if (!row) return prev;
      const key = row.key.trim();
      // If this override shadows an inherited key, "removing" means reverting
      // to the inherited value rather than dropping the row altogether —
      // the inherited entry would otherwise reappear as a separate row.
      if (!row.isInherited && inheritedEnv && key in inheritedEnv) {
        const inheritedValue = inheritedEnv[key]!;
        const next = prev.map((r) =>
          r.rowId === rowId ? { ...r, value: inheritedValue, isInherited: true } : r
        );
        commitIfValid(next);
        return next;
      }
      const next = prev.filter((r) => r.rowId !== rowId);
      commitIfValid(next);
      return next;
    });
    setRevealedRows((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
  };

  const handleKeyChange = (rowId: string, newKey: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, key: newKey } : r)));
  };

  const handleKeySelect = (rowId: string, newKey: string) => {
    // Picker selection commits synchronously. The input's blur fires before
    // the option's click, so a typing-style onChange + later blur loses the
    // pick (blur commits the OLD key before the click can update rows).
    // Mark the row touched so a subsequent blank-out still surfaces the
    // empty-key error.
    setTouchedKeys((prev) => ({ ...prev, [rowId]: true }));
    setRows((prev) => {
      const next = prev.map((r) => (r.rowId === rowId ? { ...r, key: newKey } : r));
      commitIfValid(next);
      return next;
    });
  };

  const handleValueChange = (rowId: string, newValue: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, value: newValue } : r)));
  };

  const handleValuePaste = (rowId: string, e: React.ClipboardEvent<HTMLInputElement>) => {
    if (e.currentTarget.disabled) return;
    const raw = e.clipboardData?.getData("text");
    if (raw == null) return;
    const cleaned = normalizePastedEnvValue(raw);
    if (cleaned === raw) return;
    e.preventDefault();
    const inserted = document.execCommand("insertText", false, cleaned);
    if (!inserted) {
      const input = e.currentTarget;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      handleValueChange(rowId, input.value.slice(0, start) + cleaned + input.value.slice(end));
    }
    const prior = normalizeTimers.current.get(rowId);
    if (prior) clearTimeout(prior);
    setNormalizedRows((prev) => {
      if (prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });
    const timer = setTimeout(() => {
      normalizeTimers.current.delete(rowId);
      setNormalizedRows((prev) => {
        if (!prev.has(rowId)) return prev;
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
    }, NORMALIZED_INDICATOR_TTL_MS);
    normalizeTimers.current.set(rowId, timer);
  };

  const handleOverride = (rowId: string) => {
    setRows((prev) => {
      const row = prev.find((r) => r.rowId === rowId);
      if (!row || !row.isInherited) return prev;
      // Promote the inherited row to an override carrying the current value.
      // This makes the preset env explicitly include the key, so a later
      // change to the inherited map does not silently alter this preset.
      const next = prev.map((r) => (r.rowId === rowId ? { ...r, isInherited: false } : r));
      commitIfValid(next);
      return next;
    });
  };

  const handleRevert = (rowId: string) => {
    setRows((prev) => {
      const row = prev.find((r) => r.rowId === rowId);
      if (!row || row.isInherited) return prev;
      const key = row.key.trim();
      if (!inheritedEnv || !(key in inheritedEnv)) return prev;
      const inheritedValue = inheritedEnv[key]!;
      const next = prev.map((r) =>
        r.rowId === rowId ? { ...r, value: inheritedValue, isInherited: true } : r
      );
      commitIfValid(next);
      return next;
    });
  };

  const handleKeyBlur = (rowId: string) => {
    setTouchedKeys((prev) => ({ ...prev, [rowId]: true }));
    setRows((prev) => {
      commitIfValid(prev);
      return prev;
    });
  };

  const handleValueBlur = (rowId: string) => {
    setRows((prev) => {
      const row = prev.find((r) => r.rowId === rowId);
      if (!row || row.isInherited) {
        commitIfValid(prev);
        return prev;
      }
      const key = row.key.trim();
      // If a user clears an override's value and that key is still inherited,
      // silently reverting is safer than persisting an empty-string override —
      // otherwise the preset would ship `KEY=""` which masks the inherited
      // value instead of falling back to it.
      if (row.value === "" && inheritedEnv && key in inheritedEnv) {
        const inheritedValue = inheritedEnv[key]!;
        const next = prev.map((r) =>
          r.rowId === rowId ? { ...r, value: inheritedValue, isInherited: true } : r
        );
        commitIfValid(next);
        return next;
      }
      commitIfValid(prev);
      return prev;
    });
  };

  const toggleReveal = (rowId: string) => {
    setRevealedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const registerKeyInput = (rowId: string, el: HTMLInputElement | null) => {
    if (el) keyInputRefs.current.set(rowId, el);
    else keyInputRefs.current.delete(rowId);
  };

  const handleImportConfirm = (mergedEnv: Record<string, string>) => {
    // Imports commit the merged map as the new source of truth. Bump the
    // parent first, then sync local draft + lastEnvRef so the reseed effect
    // sees the prop and ref already aligned (no stomp on the optimistic
    // rows) and so a thrown onChange leaves local state untouched.
    onChange(mergedEnv);
    lastEnvRef.current = mergedEnv;
    setRows(envToDraft(mergedEnv));
    setTouchedKeys({});
  };

  const duplicateKeys = findDuplicateKeys(rows);
  const isEmpty = rows.length === 0;
  // Every edit commits only while the whole table is valid, so a visible error
  // also means nothing typed since is being saved — say so where it is seen.
  const hasBlockingError =
    duplicateKeys.size > 0 ||
    rows.some(
      (r) =>
        !r.isInherited &&
        ((touchedKeys[r.rowId] && r.key.trim() === "") ||
          (r.key.trim() !== "" && !isValidEnvKey(r.key.trim())))
    );

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleAdd}
      ref={focus.registerFallback}
      data-testid="env-editor-add"
    >
      <Plus aria-hidden="true" />
      Add variable
    </Button>
  );
  const importButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setIsImportOpen(true)}
      data-testid="env-editor-import"
    >
      <Upload aria-hidden="true" />
      Import .env
    </Button>
  );
  const importDialog = (
    <ImportEnvDialog
      isOpen={isImportOpen}
      onClose={() => setIsImportOpen(false)}
      env={env}
      onImport={handleImportConfirm}
    />
  );

  // Empty, there is no table to frame: one line and the two ways to fill it.
  if (isEmpty) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid={dataTestId}>
        <p className="min-w-0 flex-1 text-sm text-text-secondary">
          Add your first variable, or import a .env file
        </p>
        <div className="flex items-center gap-2">
          {addButton}
          {importButton}
        </div>
        {importDialog}
      </div>
    );
  }

  return (
    <div
      className="rounded-[var(--radius-md)] border border-border-default overflow-hidden bg-surface-input"
      data-testid={dataTestId}
    >
      <div
        className="grid grid-cols-[2fr_3fr_auto] text-xs font-medium text-text-secondary bg-overlay-subtle border-b border-border-default"
        aria-hidden="true"
      >
        <div className="px-2.5 py-1.5">Name</div>
        <div className="px-2.5 py-1.5 border-l border-border-subtle">Value</div>
        <div className="w-9" />
      </div>
      <div className="divide-y divide-border-subtle">
        {rows.map((row, rowIndex) => {
          const trimmedKey = row.key.trim();
          const touched = !!touchedKeys[row.rowId];
          const isEmptyKey = !row.isInherited && touched && trimmedKey === "";
          const isDuplicate =
            !row.isInherited && trimmedKey !== "" && duplicateKeys.has(trimmedKey);
          const isMalformed = !row.isInherited && trimmedKey !== "" && !isValidEnvKey(trimmedKey);
          const hasSecretWarning = !row.isInherited && looksLikeSecret(row.value);
          const isSecret = !row.isInherited && (isSensitiveEnvKey(row.key) || hasSecretWarning);
          const isRevealed = revealedRows.has(row.rowId);
          const valueInputType = isSecret && !isRevealed ? "password" : "text";
          const isOverride =
            !row.isInherited && !!inheritedEnv && trimmedKey !== "" && trimmedKey in inheritedEnv;
          const stripeClass =
            isEmptyKey || isDuplicate
              ? "before:bg-status-error"
              : hasSecretWarning
                ? "before:bg-status-warning"
                : isOverride
                  ? "before:bg-state-modified"
                  : "before:bg-transparent";
          // Keys taken by *other* editable rows — used to filter the
          // suggestion popover so a single key can't be picked twice.
          // Inherited rows don't count: a suggested key that matches an
          // inherited entry should still be pickable as an override.
          const usedKeys = new Set<string>();
          for (const r of rows) {
            if (r.rowId === row.rowId) continue;
            if (r.isInherited) continue;
            const k = r.key.trim();
            if (k) usedKeys.add(k);
          }
          return (
            <div
              key={row.rowId}
              className={cn(
                "relative grid grid-cols-[2fr_3fr_auto] items-stretch group",
                "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px]",
                stripeClass,
                row.isInherited && "bg-overlay-subtle"
              )}
              data-testid={row.isInherited ? "env-editor-row-inherited" : "env-editor-row"}
            >
              <EnvVarKeyCell
                rowId={row.rowId}
                position={rowIndex + 1}
                value={row.key}
                suggestions={suggestions ?? EMPTY_SUGGESTIONS}
                usedKeys={usedKeys}
                disabled={row.isInherited}
                isEmptyKey={isEmptyKey}
                isDuplicate={isDuplicate}
                isMalformed={isMalformed}
                onChange={handleKeyChange}
                onBlur={handleKeyBlur}
                onSelect={handleKeySelect}
                registerRef={(id, el) => {
                  registerKeyInput(id, el);
                  focus.register(id)(el);
                }}
              />
              {/* Value cell */}
              <div className="flex flex-col border-l border-border-subtle">
                <div className="relative">
                  <input
                    type={valueInputType}
                    className={cn(
                      ENV_CELL_INPUT,
                      isSecret ? "pl-2.5 pr-9" : "px-2.5",
                      row.isInherited ? "text-text-secondary" : "text-text-primary"
                    )}
                    value={row.value}
                    placeholder={valuePlaceholder}
                    spellCheck={false}
                    autoComplete={isSecret ? "new-password" : "off"}
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    data-form-type="other"
                    disabled={row.isInherited}
                    aria-label={`Value of ${trimmedKey || `variable ${rowIndex + 1}`}`}
                    aria-describedby={
                      hasSecretWarning ? `env-value-message-${row.rowId}` : undefined
                    }
                    onChange={(e) => handleValueChange(row.rowId, e.target.value)}
                    onBlur={() => handleValueBlur(row.rowId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        // Blur first so the current row commits its value to
                        // the parent; only then add the new row. Without this,
                        // the browser's focus-change blur fires after handleAdd
                        // has already appended the placeholder row, and
                        // handleValueBlur's commit sweeps in an unintended
                        // NEW_VAR: "" entry.
                        e.currentTarget.blur();
                        handleAdd();
                      } else if (e.key === "Escape") {
                        e.currentTarget.blur();
                      }
                    }}
                    onPaste={(e) => handleValuePaste(row.rowId, e)}
                    data-testid="env-editor-value"
                  />
                  {isSecret && (
                    <button
                      type="button"
                      onClick={() => toggleReveal(row.rowId)}
                      aria-pressed={isRevealed}
                      aria-label={`${isRevealed ? "Hide" : "Show"} value${trimmedKey ? ` of ${trimmedKey}` : ""}`}
                      className={cn(ENV_CELL_ACTION, "absolute right-1.5 top-1/2 -translate-y-1/2")}
                      data-testid="env-editor-reveal"
                    >
                      {isRevealed ? (
                        <EyeOff size={12} aria-hidden="true" />
                      ) : (
                        <Eye size={12} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
                {hasSecretWarning && (
                  <p
                    id={`env-value-message-${row.rowId}`}
                    className="flex items-start gap-1.5 px-2.5 pb-2 text-xs text-text-secondary"
                    data-testid="env-editor-warning-secret"
                  >
                    <AlertTriangle
                      className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
                      aria-hidden="true"
                    />
                    {"Looks like a secret — reference it as ${ENV_VAR} from your shell instead"}
                  </p>
                )}
                {!hasSecretWarning && normalizedRows.has(row.rowId) && (
                  <p
                    className="px-2.5 pb-2 text-xs text-text-secondary"
                    data-testid="env-editor-normalized"
                  >
                    Pasted text normalized
                  </p>
                )}
              </div>
              {/* Actions cell — remove / revert / override by row kind. */}
              <div className="flex items-start justify-center w-9 pt-1.5 border-l border-border-subtle">
                {row.isInherited ? (
                  <button
                    type="button"
                    className={ENV_CELL_ACTION}
                    aria-label={`Override ${trimmedKey} in this preset`}
                    onClick={() => handleOverride(row.rowId)}
                    data-testid="env-editor-override"
                    title="Override this inherited value"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : isOverride ? (
                  <button
                    type="button"
                    className={ENV_CELL_ACTION}
                    aria-label={`Revert ${trimmedKey} to inherited value`}
                    onClick={() => handleRevert(row.rowId)}
                    data-testid="env-editor-revert"
                    title="Revert to inherited value"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      ENV_CELL_ACTION,
                      "text-status-error hover:text-status-error hover:bg-status-error/10"
                    )}
                    aria-label={`Delete ${trimmedKey || "unnamed variable"} (row ${rowIndex + 1})`}
                    onClick={() => handleRemove(row.rowId)}
                    data-testid="env-editor-remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 py-2 border-t border-border-default bg-overlay-subtle">
        {hasBlockingError && (
          <p className="w-full text-xs text-status-error" role="status">
            Changes aren't saved until every name is valid and unique
          </p>
        )}
        {addButton}
        {importButton}
      </div>
      {importDialog}
    </div>
  );
}
