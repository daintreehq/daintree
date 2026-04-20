import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { looksLikeSecret } from "@/utils/secretDetection";
import { isSensitiveEnvKey } from "../../../shared/utils/envVars";

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
 *  - Override rows (env entries that shadow an inherited key) get an accent
 *    left-stripe and a revert (RotateCcw) action that clears the override
 *    back to inherited.
 *  - Clearing an override's value on blur also reverts to inherited, so we
 *    don't silently ship empty-string overrides.
 *
 * Validation surfaces:
 *  - Empty key after trim → red left-stripe on the row + "Key required" inline
 *    message. Blur on an empty key does NOT persist.
 *  - Duplicate key → amber left-stripe on both matching rows + "Duplicate key"
 *    inline message. The second occurrence is not persisted until resolved.
 *  - Literal secret value → amber left-stripe + inline advisory message.
 *    Values still commit (warning is advisory only).
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
  /** Optional datalist of suggested KEY names to speed up common setups. */
  suggestions?: EnvVarSuggestion[];
  /** HTML id used for the shared datalist element (must be unique per page). */
  datalistId?: string;
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
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

export function EnvVarEditor({
  env,
  onChange,
  suggestions,
  datalistId,
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
    }
    // Only reseed if the incoming env+inheritance actually differs from what
    // our current draft would produce. Otherwise the parent's commit echo
    // would stomp an in-progress edit.
    const draftAsEnv = draftToEnv(rows);
    if (contextChanged || inheritedChanged || !shallowEnvEqual(draftAsEnv, env)) {
      setRows(envToDraft(env, inheritedEnv));
    }
  }, [env, inheritedEnv, contextKey, rows]);

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

  const commitIfValid = useCallback(
    (nextRows: DraftRow[]) => {
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
    },
    [onChange]
  );

  const handleAdd = useCallback(() => {
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
  }, []);

  const handleRemove = useCallback(
    (rowId: string) => {
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
    },
    [commitIfValid, inheritedEnv]
  );

  const handleKeyChange = useCallback((rowId: string, newKey: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, key: newKey } : r)));
  }, []);

  const handleValueChange = useCallback((rowId: string, newValue: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, value: newValue } : r)));
  }, []);

  const handleOverride = useCallback(
    (rowId: string) => {
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
    },
    [commitIfValid]
  );

  const handleRevert = useCallback(
    (rowId: string) => {
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
    },
    [commitIfValid, inheritedEnv]
  );

  const handleKeyBlur = useCallback(
    (rowId: string) => {
      setTouchedKeys((prev) => ({ ...prev, [rowId]: true }));
      setRows((prev) => {
        commitIfValid(prev);
        return prev;
      });
    },
    [commitIfValid]
  );

  const handleValueBlur = useCallback(
    (rowId: string) => {
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
    },
    [commitIfValid, inheritedEnv]
  );

  const toggleReveal = useCallback((rowId: string) => {
    setRevealedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  const registerKeyInput = useCallback((rowId: string, el: HTMLInputElement | null) => {
    if (el) keyInputRefs.current.set(rowId, el);
    else keyInputRefs.current.delete(rowId);
  }, []);

  const duplicateKeys = findDuplicateKeys(rows);
  const isEmpty = rows.length === 0;

  return (
    <div
      className="rounded-[var(--radius-md)] border border-daintree-border overflow-hidden bg-daintree-bg/30"
      data-testid={dataTestId}
    >
      {datalistId && suggestions && suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map(({ key }) => (
            <option key={key} value={key} />
          ))}
        </datalist>
      )}
      {/* Header */}
      <div className="grid grid-cols-[2fr_3fr_auto] text-[10px] uppercase tracking-wide text-daintree-text/50 bg-daintree-bg/40 border-b border-daintree-border">
        <div className="px-2.5 py-1.5">Key</div>
        <div className="px-2.5 py-1.5 border-l border-daintree-border/60">Value</div>
        <div className="px-2.5 py-1.5 w-9" aria-hidden="true" />
      </div>
      {/* Body */}
      {isEmpty ? (
        <button
          type="button"
          onClick={handleAdd}
          className="w-full flex items-center justify-center gap-1.5 py-4 text-[12px] text-daintree-text/50 hover:text-daintree-accent hover:bg-daintree-bg/50 transition-colors border border-dashed border-daintree-border/60 m-2 rounded-[var(--radius-sm)]"
          data-testid="env-editor-add"
        >
          <Plus size={12} aria-hidden="true" />
          <span>Add your first variable</span>
        </button>
      ) : (
        <div className="divide-y divide-daintree-border">
          {rows.map((row) => {
            const trimmedKey = row.key.trim();
            const touched = !!touchedKeys[row.rowId];
            const isEmptyKey = !row.isInherited && touched && trimmedKey === "";
            const isDuplicate =
              !row.isInherited && trimmedKey !== "" && duplicateKeys.has(trimmedKey);
            const hasSecretWarning = !row.isInherited && looksLikeSecret(row.value);
            const isSecret = !row.isInherited && (isSensitiveEnvKey(row.key) || hasSecretWarning);
            const isRevealed = revealedRows.has(row.rowId);
            const valueInputType = isSecret && !isRevealed ? "password" : "text";
            const isOverride =
              !row.isInherited && !!inheritedEnv && trimmedKey !== "" && trimmedKey in inheritedEnv;
            const stripeClass = isEmptyKey
              ? "before:bg-status-error"
              : isDuplicate || hasSecretWarning
                ? "before:bg-amber-500/70"
                : isOverride
                  ? "before:bg-daintree-accent"
                  : "before:bg-transparent";
            return (
              <div
                key={row.rowId}
                className={cn(
                  "relative grid grid-cols-[2fr_3fr_auto] items-stretch group",
                  "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px]",
                  stripeClass,
                  row.isInherited && "bg-daintree-bg/20"
                )}
                data-testid={row.isInherited ? "env-editor-row-inherited" : "env-editor-row"}
              >
                {/* Key cell */}
                <div className="relative">
                  <input
                    ref={(el) => registerKeyInput(row.rowId, el)}
                    type="text"
                    className={cn(
                      "w-full h-full bg-transparent border-0 outline-none px-2.5 py-2 font-mono text-[12px]",
                      "focus:ring-2 focus:ring-inset focus:ring-daintree-accent/40",
                      "disabled:cursor-default",
                      row.isInherited
                        ? "text-daintree-text/40"
                        : isEmptyKey
                          ? "text-status-error"
                          : isDuplicate
                            ? "text-amber-500"
                            : "text-daintree-text/80"
                    )}
                    value={row.key}
                    placeholder="KEY"
                    list={datalistId}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={row.isInherited}
                    aria-label={`Env var key for row ${row.rowId}`}
                    aria-invalid={isEmptyKey || isDuplicate ? "true" : undefined}
                    onChange={(e) => handleKeyChange(row.rowId, e.target.value)}
                    onBlur={() => handleKeyBlur(row.rowId)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.currentTarget.blur();
                      }
                    }}
                    data-testid="env-editor-key"
                  />
                  {(isEmptyKey || isDuplicate) && (
                    <p
                      className={cn(
                        "absolute left-2.5 bottom-0.5 text-[9px] leading-none pointer-events-none",
                        isEmptyKey ? "text-status-error" : "text-amber-500"
                      )}
                      data-testid={
                        isEmptyKey ? "env-editor-error-empty" : "env-editor-error-duplicate"
                      }
                    >
                      {isEmptyKey ? "Key required" : "Duplicate key"}
                    </p>
                  )}
                </div>
                {/* Value cell */}
                <div className="relative border-l border-daintree-border/60">
                  <input
                    type={valueInputType}
                    className={cn(
                      "w-full h-full bg-transparent border-0 outline-none py-2 font-mono text-[12px]",
                      "focus:ring-2 focus:ring-inset focus:ring-daintree-accent/40",
                      "disabled:cursor-default",
                      isSecret ? "pl-2.5 pr-8" : "px-2.5",
                      row.isInherited
                        ? "text-daintree-text/40"
                        : hasSecretWarning
                          ? "text-amber-500"
                          : "text-daintree-accent/90"
                    )}
                    value={row.value}
                    placeholder={valuePlaceholder}
                    spellCheck={false}
                    autoComplete={isSecret ? "new-password" : "off"}
                    disabled={row.isInherited}
                    aria-label={`Env var value for row ${row.rowId}`}
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
                    data-testid="env-editor-value"
                  />
                  {isSecret && (
                    <button
                      type="button"
                      onClick={() => toggleReveal(row.rowId)}
                      aria-pressed={isRevealed}
                      aria-label={isRevealed ? "Hide value" : "Show value"}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-daintree-text/40 hover:text-daintree-text/70 hover:bg-daintree-bg/60 transition-colors"
                      data-testid="env-editor-reveal"
                    >
                      {isRevealed ? (
                        <EyeOff size={12} aria-hidden="true" />
                      ) : (
                        <Eye size={12} aria-hidden="true" />
                      )}
                    </button>
                  )}
                  {hasSecretWarning && (
                    <p
                      className="absolute left-2.5 bottom-0.5 text-[9px] leading-none text-amber-500 pointer-events-none"
                      data-testid="env-editor-warning-secret"
                      title="Looks like a secret. Prefer a ${ENV_VAR} reference to your shell environment."
                    >
                      {"Looks like a secret — prefer ${ENV_VAR}"}
                    </p>
                  )}
                </div>
                {/* Actions cell — remove / revert / override by row kind. */}
                <div className="flex items-center justify-center w-9 border-l border-daintree-border/60">
                  {row.isInherited ? (
                    <button
                      type="button"
                      className="p-1 rounded text-daintree-text/40 hover:text-daintree-accent hover:bg-daintree-bg/60 transition-colors"
                      aria-label={`Override ${trimmedKey} in this preset`}
                      onClick={() => handleOverride(row.rowId)}
                      data-testid="env-editor-override"
                      title="Override this inherited value"
                    >
                      <Plus size={12} aria-hidden="true" />
                    </button>
                  ) : isOverride ? (
                    <button
                      type="button"
                      className="p-1 rounded text-daintree-text/40 hover:text-daintree-accent hover:bg-daintree-bg/60 transition-colors"
                      aria-label={`Revert ${trimmedKey} to inherited value`}
                      onClick={() => handleRevert(row.rowId)}
                      data-testid="env-editor-revert"
                      title="Revert to inherited value"
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="p-1 rounded text-daintree-text/30 hover:text-status-error hover:bg-daintree-bg/60 transition-colors"
                      aria-label={`Remove ${trimmedKey || "empty"} env var`}
                      onClick={() => handleRemove(row.rowId)}
                      data-testid="env-editor-remove"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Add row (only when non-empty — empty state has its own affordance) */}
      {!isEmpty && (
        <button
          type="button"
          onClick={handleAdd}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-daintree-text/50 hover:text-daintree-accent hover:bg-daintree-bg/50 transition-colors border-t border-daintree-border"
          data-testid="env-editor-add"
        >
          <Plus size={12} aria-hidden="true" />
          <span>Add variable</span>
        </button>
      )}
    </div>
  );
}
