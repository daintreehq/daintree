import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { looksLikeSecret } from "@/utils/secretDetection";
import { isSensitiveEnvKey } from "../../../shared/utils/envVars";

/**
 * Inline env var CRUD editor with validation.
 *
 * Renders a bordered table surface with flush cells, hairline row dividers,
 * and a flush "Add variable" row — matching the chrome of Vercel/Railway/GitHub
 * Actions env editors. Draft rows are the source of truth during editing — we
 * can't represent an in-progress duplicate key as a JS object, so we keep an
 * array of `{rowId, key, value}` and serialize back to a `Record<string,string>`
 * only when all keys are unique and non-empty.
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
}

interface DraftRow {
  rowId: string;
  key: string;
  value: string;
}

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `row-${rowIdCounter}`;
}

function envToDraft(env: Record<string, string>): DraftRow[] {
  return Object.entries(env).map(([key, value]) => ({
    rowId: nextRowId(),
    key,
    value,
  }));
}

function draftToEnv(rows: DraftRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    if (seen.has(k)) continue; // drop duplicates — the validation surface warns the user
    seen.add(k);
    out[k] = row.value;
  }
  return out;
}

function findDuplicateKeys(rows: DraftRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
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
}: EnvVarEditorProps) {
  const [rows, setRows] = useState<DraftRow[]>(() => envToDraft(env));
  // Track which keys have been "touched" (blurred or modified after creation) —
  // we suppress the empty-key error for newly added rows until first blur.
  const [touchedKeys, setTouchedKeys] = useState<Record<string, boolean>>({});
  // Per-row reveal state for secret values. Session-scoped, cleared on context switch.
  const [revealedRows, setRevealedRows] = useState<Set<string>>(() => new Set());
  // When non-null, the focus-recovery effect focuses the key input for that rowId.
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const lastEnvRef = useRef<Record<string, string>>(env);
  const lastContextKeyRef = useRef<string | undefined>(contextKey);
  const keyInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // When the parent's env changes externally (different preset selected,
  // programmatic reset), reseed the draft rows. We use a shallow compare on
  // keys+values so typing a value doesn't trigger a reseed.
  useEffect(() => {
    const curKeys = Object.keys(env).sort().join("\x00");
    const curVals = Object.keys(env)
      .sort()
      .map((k) => env[k])
      .join("\x00");
    const prevKeys = Object.keys(lastEnvRef.current).sort().join("\x00");
    const prevVals = Object.keys(lastEnvRef.current)
      .sort()
      .map((k) => lastEnvRef.current[k])
      .join("\x00");
    const contextChanged = lastContextKeyRef.current !== contextKey;
    if (contextChanged || curKeys !== prevKeys || curVals !== prevVals) {
      lastEnvRef.current = env;
      lastContextKeyRef.current = contextKey;
      if (contextChanged) {
        setTouchedKeys({});
        setRevealedRows(new Set());
      }
      // Only reseed if the incoming env is actually different from what our
      // draft would produce. Otherwise typing triggers a parent update that
      // would otherwise stomp the user's in-progress edit.
      const draftAsEnv = draftToEnv(rows);
      const draftKeys = Object.keys(draftAsEnv).sort().join("\x00");
      const draftVals = Object.keys(draftAsEnv)
        .sort()
        .map((k) => draftAsEnv[k])
        .join("\x00");
      if (contextChanged || draftKeys !== curKeys || draftVals !== curVals) {
        setRows(envToDraft(env));
      }
    }
  }, [env, contextKey, rows]);

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
        const prev = lastEnvRef.current;
        const prevKeys = Object.keys(prev).sort().join("\x00");
        const nextKeys = Object.keys(nextEnv).sort().join("\x00");
        const prevVals = Object.keys(prev)
          .sort()
          .map((k) => prev[k])
          .join("\x00");
        const nextVals = Object.keys(nextEnv)
          .sort()
          .map((k) => nextEnv[k])
          .join("\x00");
        if (prevKeys !== nextKeys || prevVals !== nextVals) {
          lastEnvRef.current = nextEnv;
          onChange(nextEnv);
        }
      }
    },
    [onChange]
  );

  const handleAdd = useCallback(() => {
    const newRowId = nextRowId();
    setRows((prev) => {
      // Pick a KEY name that isn't already present.
      let candidate = "NEW_VAR";
      let i = 1;
      const present = new Set(prev.map((r) => r.key.trim()));
      while (present.has(candidate)) candidate = `NEW_VAR_${i++}`;
      return [...prev, { rowId: newRowId, key: candidate, value: "" }];
    });
    setPendingFocusKey(newRowId);
  }, []);

  const handleRemove = useCallback(
    (rowId: string) => {
      setRows((prev) => {
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
    [commitIfValid]
  );

  const handleKeyChange = useCallback((rowId: string, newKey: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, key: newKey } : r)));
  }, []);

  const handleValueChange = useCallback((rowId: string, newValue: string) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, value: newValue } : r)));
  }, []);

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

  const handleValueBlur = useCallback(() => {
    setRows((prev) => {
      commitIfValid(prev);
      return prev;
    });
  }, [commitIfValid]);

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
            const isEmptyKey = touched && trimmedKey === "";
            const isDuplicate = trimmedKey !== "" && duplicateKeys.has(trimmedKey);
            const hasSecretWarning = looksLikeSecret(row.value);
            const isSecret = isSensitiveEnvKey(row.key) || hasSecretWarning;
            const isRevealed = revealedRows.has(row.rowId);
            const valueInputType = isSecret && !isRevealed ? "password" : "text";
            const stripeClass = isEmptyKey
              ? "before:bg-status-error"
              : isDuplicate || hasSecretWarning
                ? "before:bg-amber-500/70"
                : "before:bg-transparent";
            return (
              <div
                key={row.rowId}
                className={cn(
                  "relative grid grid-cols-[2fr_3fr_auto] items-stretch group",
                  "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px]",
                  stripeClass
                )}
              >
                {/* Key cell */}
                <div className="relative">
                  <input
                    ref={(el) => registerKeyInput(row.rowId, el)}
                    type="text"
                    className={cn(
                      "w-full h-full bg-transparent border-0 outline-none px-2.5 py-2 font-mono text-[12px]",
                      "focus:ring-2 focus:ring-inset focus:ring-daintree-accent/40",
                      isEmptyKey
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
                      "w-full h-full bg-transparent border-0 outline-none py-2 font-mono text-[12px] text-daintree-accent/90",
                      "focus:ring-2 focus:ring-inset focus:ring-daintree-accent/40",
                      isSecret ? "pl-2.5 pr-8" : "px-2.5",
                      hasSecretWarning && "text-amber-500"
                    )}
                    value={row.value}
                    placeholder={valuePlaceholder}
                    spellCheck={false}
                    autoComplete={isSecret ? "new-password" : "off"}
                    aria-label={`Env var value for row ${row.rowId}`}
                    onChange={(e) => handleValueChange(row.rowId, e.target.value)}
                    onBlur={handleValueBlur}
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
                {/* Actions cell */}
                <div className="flex items-center justify-center w-9 border-l border-daintree-border/60">
                  <button
                    type="button"
                    className="p-1 rounded text-daintree-text/30 hover:text-status-error hover:bg-daintree-bg/60 transition-colors"
                    aria-label={`Remove ${trimmedKey || "empty"} env var`}
                    onClick={() => handleRemove(row.rowId)}
                    data-testid="env-editor-remove"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
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
