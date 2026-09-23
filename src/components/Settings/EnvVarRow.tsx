import type { ReactNode, Ref } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The editable `NAME = value` row shared by the global Environment page and the
 * project Variables page. Both are explicit-save editors over the same data shape,
 * and before this they had drifted into two row designs: different field density,
 * a grey delete on one and a red one on the other, and different wording for the
 * same validation failure.
 */

export interface EnvVarDraft {
  id: string;
  key: string;
  value: string;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name a POSIX shell can export. */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export const ENV_KEY_INVALID_MESSAGE =
  "Start with a letter or underscore, then use only letters, digits and underscores";
export const ENV_KEY_DUPLICATE_MESSAGE = "Another variable already uses this name";

/**
 * Per-row name errors, keyed by row id. Blank names are skipped rather than flagged:
 * a blank row is dropped on save, so it is not something the user has to fix.
 * Every row after the first with a given name is the duplicate.
 */
export function validateEnvRows(rows: readonly EnvVarDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (!isValidEnvKey(key)) errors[row.id] = ENV_KEY_INVALID_MESSAGE;
    else if (seen.has(key)) errors[row.id] = ENV_KEY_DUPLICATE_MESSAGE;
    seen.add(key);
  }
  return errors;
}

/**
 * Columns for every env row, editable or read-only, so `=` and the value start at
 * the same x down a group whatever sits in the row's trailing slot.
 */
export const ENV_ROW_GRID =
  "grid grid-cols-[minmax(0,2fr)_auto_minmax(0,3fr)_auto] items-center gap-x-2";

interface EnvVarRowProps {
  row: EnvVarDraft;
  /** 1-based, so two rows holding the same name still get distinct action names. */
  position: number;
  error?: string;
  /** Mask the value behind a reveal toggle. */
  sensitive: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  onKeyChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onDelete: () => void;
  /**
   * Where the value is stored, shown inside the name field so it never shifts the
   * row's columns (a leading glyph pushed one row's fields 40px right of the rest).
   */
  storageBadge?: ReactNode;
  valuePlaceholder?: string;
  keyRef?: Ref<HTMLInputElement>;
}

export function EnvVarRow({
  row,
  position,
  error,
  sensitive,
  revealed,
  onToggleReveal,
  onKeyChange,
  onValueChange,
  onDelete,
  storageBadge,
  valuePlaceholder = "value",
  keyRef,
}: EnvVarRowProps) {
  const errorId = `${row.id}-error`;
  const name = row.key.trim();
  return (
    <div className="px-4 py-2.5" data-env-row="">
      <div className={ENV_ROW_GRID}>
        <div className="relative min-w-0">
          <Input
            ref={keyRef}
            type="text"
            value={row.key}
            onChange={(e) => onKeyChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            className={cn("font-mono", storageBadge && "pr-8")}
            placeholder="VARIABLE_NAME"
            aria-label="Environment variable name"
          />
          {storageBadge && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 flex">{storageBadge}</span>
          )}
        </div>
        <span className="text-text-secondary" aria-hidden="true">
          =
        </span>
        <div className="relative min-w-0">
          <Input
            type={sensitive && !revealed ? "password" : "text"}
            value={row.value}
            onChange={(e) => onValueChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete={sensitive ? "new-password" : "off"}
            className={cn("font-mono", sensitive && "pr-9")}
            placeholder={valuePlaceholder}
            aria-label="Environment variable value"
            aria-describedby={error ? errorId : undefined}
          />
          {sensitive && (
            <button
              type="button"
              onClick={onToggleReveal}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
              aria-pressed={revealed}
              aria-label={`${revealed ? "Hide" : "Show"} value${name ? ` of ${name}` : ""}`}
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
        <Button
          variant="ghost-danger"
          size="icon-sm"
          onClick={onDelete}
          aria-label={`Delete ${name || "unnamed variable"} (row ${position})`}
        >
          <Trash2 />
        </Button>
        {error && (
          <p id={errorId} className="col-span-3 mt-1 text-xs text-status-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
