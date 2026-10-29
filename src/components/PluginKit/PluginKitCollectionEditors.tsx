import { useEffect, useId, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import { Lock, LockOpen, Plus, X } from "lucide-react";
import type {
  PluginKeyValueEditorProps,
  PluginKeyValuePair,
  PluginListEditorProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { inputVariants } from "@/components/ui/input";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { field, fn, nonEmpty, pickRootProps, str, wholeLimit } from "./kitProps";
import { SkippedNote } from "./kitFiles";
import { pluginKitDnd } from "./PluginKitDnd";
import { KitSecretInput } from "./PluginKitSecretInput";
import { safely, verdict, REMOVE_ROW_CLASS } from "./kitTextInputHelpers";

const SortableList = pluginKitDnd.SortableList;

// Key/value and list editors.

interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  secret: boolean;
}

function readPairs(value: unknown): KeyValueRow[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: KeyValueRow[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) return;
    let id = nonEmpty(field(entry, "id")) ?? `kv-${index}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    out.push({
      id,
      key: str(field(entry, "key")) ?? "",
      value: str(field(entry, "value")) ?? "",
      secret: field(entry, "secret") === true,
    });
  });
  return out;
}

function toPairs(rows: readonly KeyValueRow[]): PluginKeyValuePair[] {
  return rows.map((row) =>
    row.secret
      ? { id: row.id, key: row.key, value: row.value, secret: true }
      : { id: row.id, key: row.key, value: row.value }
  );
}

const ASSIGNMENT = /^\s*(?:export\s+)?([^\s=:]+)\s*(?:=|:\s)\s*(.*)$/;

/**
 * `KEY=value`, `export KEY=value` and `Key: value` lines, as pasted from a
 * `.env` file or a request's headers. Blank lines and `#` comments are
 * skipped; a quoted value loses its quotes. Null when a line is not one of
 * these, so the paste goes in as plain text.
 */
export function parseAssignments(text: string): { key: string; value: string }[] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
  if (lines.length === 0) return null;
  const out: { key: string; value: string }[] = [];
  for (const line of lines) {
    const match = ASSIGNMENT.exec(line);
    if (!match) return null;
    let assigned = match[2]!.trim();
    if (assigned.length >= 2 && /^(["']).*\1$/.test(assigned)) assigned = assigned.slice(1, -1);
    out.push({ key: match[1]!, value: assigned });
  }
  return out;
}

export function keyValueErrors(
  rows: readonly { key: string; value: string }[],
  options: {
    caseInsensitive: boolean;
    allowDuplicates: boolean;
    validateKey?: (key: string) => unknown;
  }
): (string | null)[] {
  const norm = (key: string) => (options.caseInsensitive ? key.trim().toLowerCase() : key.trim());
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = norm(row.key);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.map((row) => {
    const key = row.key.trim();
    // A fresh, untouched row is not an error yet.
    if (key === "") return row.value.trim() === "" ? null : "Enter a key";
    if (!options.allowDuplicates && (counts.get(norm(row.key)) ?? 0) > 1) return "Duplicate key";
    return verdict(options.validateKey, key);
  });
}

/** Tells the plugin whether the editor is valid, each time that changes. */
function useValidityReport(valid: boolean, report: ((valid: boolean) => void) | undefined) {
  const last = useRef<boolean | null>(null);
  useEffect(() => {
    if (last.current === valid) return;
    last.current = valid;
    safely("onValidityChange", report, valid);
  }, [valid, report]);
}

/** Focuses the row field named `target` once it is on screen. */
function useFocusRequest(
  root: RefObject<HTMLElement | null>,
  target: string | null,
  done: () => void
) {
  useEffect(() => {
    if (target === null) return;
    root.current?.querySelector<HTMLElement>(`[data-row-focus="${CSS.escape(target)}"]`)?.focus();
    done();
  }, [root, target, done]);
}

/**
 * Key, value and the row's actions, as one grid the column heads share, so
 * a head sits over its fields whatever the actions column holds.
 */
const KV_GRID = "grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5";

/**
 * What a paste of `lines` couldn't fit with `room` left under `limit`, said
 * rather than dropped: `null` when every line went in.
 */
function pasteOverflow(
  lines: number,
  room: number,
  limit: number | undefined,
  noun: [singular: string, plural: string]
): string | null {
  if (limit === undefined || room >= lines) return null;
  const cap = pluralize(limit, ...noun);
  return room <= 0
    ? `No room to paste, up to ${cap}`
    : `${pluralize(lines - room, "line")} skipped, up to ${cap}`;
}

/** A column head over a compact field: its text on the field text's own left edge. */
const KV_HEAD = "min-w-0 truncate pl-[calc(0.5rem+1px)]";

export function KitKeyValueEditor(props: PluginKeyValueEditorProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onValidityChange,
    validateKey,
    caseInsensitiveKeys,
    allowDuplicateKeys,
    reorderable,
    keyLabel,
    valueLabel,
    keyPlaceholder,
    valuePlaceholder,
    addLabel,
    max,
    allowSecretToggle,
    disabled,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => readPairs(defaultValue));
  const rows = controlled ? readPairs(value) : own;
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  // What the last paste couldn't fit under `max`, until the next edit.
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const counterRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const handleValue = fn(onValueChange);
  const inert = disabled === true;
  const limit = wholeLimit(max, 10_000);
  const full = limit !== undefined && rows.length >= limit;
  const ariaLabel = nonEmpty(props["aria-label"]) ?? "Entries";
  // One 24px action, or two with the gap between them.
  const actionsWidth = allowSecretToggle === true ? "w-[3.375rem]" : "w-6";
  const errors = keyValueErrors(rows, {
    caseInsensitive: caseInsensitiveKeys === true,
    allowDuplicates: allowDuplicateKeys === true,
    validateKey: fn(validateKey),
  });
  useValidityReport(
    errors.every((error) => error === null),
    fn(onValidityChange)
  );
  const clearFocus = () => setFocusTarget(null);
  useFocusRequest(rootRef, focusTarget, clearFocus);

  const update = (next: KeyValueRow[]) => {
    setPasteNote(null);
    if (!controlled) setOwn(next);
    safely("KeyValueEditor onValueChange", handleValue, toPairs(next));
  };
  const newId = () => `${baseId}-new-${++counterRef.current}`;
  const add = () => {
    if (full || inert) return;
    const id = newId();
    update([...rows, { id, key: "", value: "", secret: false }]);
    setFocusTarget(`key:${id}`);
  };
  const patch = (id: string, change: Partial<KeyValueRow>) =>
    update(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  const remove = (index: number) => {
    const next = rows.filter((_, at) => at !== index);
    update(next);
    const neighbour = next[index] ?? next[index - 1];
    setFocusTarget(neighbour ? `key:${neighbour.id}` : "add");
  };
  const paste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const parsed = parseAssignments(text);
    if (!parsed) return;
    const row = rows[index]!;
    // One `KEY=value` into an empty row fills it; into a key being typed it
    // stays text. Several lines always become rows.
    if (parsed.length === 1 && (row.key !== "" || !/[=:]/.test(text))) return;
    event.preventDefault();
    // An empty row takes the first pair; otherwise they all go in after it.
    const fill = row.key === "" && row.value === "";
    const room = Math.max(
      0,
      limit === undefined ? parsed.length : limit - rows.length + (fill ? 1 : 0)
    );
    // Lines past `max` are never dropped unsaid, and a full editor says why
    // nothing went in rather than eating the paste.
    const note = pasteOverflow(parsed.length, room, limit, ["entry", "entries"]);
    if (room === 0) {
      setPasteNote(note);
      return;
    }
    const incoming = parsed.slice(0, room).map((pair, at) => ({
      id: fill && at === 0 ? row.id : newId(),
      key: pair.key,
      value: pair.value,
      secret: fill && at === 0 ? row.secret : false,
    }));
    update(
      fill
        ? [...rows.slice(0, index), ...incoming, ...rows.slice(index + 1)]
        : [...rows.slice(0, index + 1), ...incoming, ...rows.slice(index + 1)]
    );
    setPasteNote(note);
  };

  const renderRow = (row: KeyValueRow, index: number) => {
    const error = errors[index] ?? null;
    const errorId = `${baseId}-error-${row.id}`;
    const name = row.key.trim() === "" ? `row ${index + 1}` : row.key.trim();
    return (
      <div className="grid min-w-0 flex-1 gap-1" data-kv-row={row.id}>
        <div className={KV_GRID}>
          <input
            data-row-focus={`key:${row.id}`}
            type="text"
            value={row.key}
            placeholder={nonEmpty(keyPlaceholder) ?? "Key"}
            aria-label={`${nonEmpty(keyLabel) ?? "Key"} ${index + 1}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={inert}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => patch(row.id, { key: event.target.value })}
            onPaste={(event) => paste(index, event)}
            className={cn(
              inputVariants({ density: "compact", invalid: error !== null }),
              "min-w-0 font-mono"
            )}
          />
          {/* A flex cell, so the field inside sits on the row's centre line
              rather than on a text baseline 2px below the key field. */}
          <div className="flex min-w-0">
            {row.secret ? (
              <KitSecretInput
                value={row.value}
                onValueChange={(next) => patch(row.id, { value: next })}
                density="compact"
                className="w-full"
                placeholder={nonEmpty(valuePlaceholder) ?? "Value"}
                aria-label={`${nonEmpty(valueLabel) ?? "Value"} of ${name}`}
                disabled={inert}
              />
            ) : (
              <input
                type="text"
                value={row.value}
                placeholder={nonEmpty(valuePlaceholder) ?? "Value"}
                aria-label={`${nonEmpty(valueLabel) ?? "Value"} of ${name}`}
                disabled={inert}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => patch(row.id, { value: event.target.value })}
                className={cn(inputVariants({ density: "compact" }), "min-w-0 font-mono")}
              />
            )}
          </div>
          <div className={cn("flex items-center gap-1.5", actionsWidth)}>
            {allowSecretToggle === true ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={inert}
                aria-label={`Mask value of ${name}`}
                pressed={row.secret}
                onClick={() => patch(row.id, { secret: !row.secret })}
                className={REMOVE_ROW_CLASS}
              >
                {row.secret ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={inert}
              aria-label={`Remove ${name}`}
              onClick={() => remove(index)}
              className={REMOVE_ROW_CLASS}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        {error ? <InlineError id={errorId}>{error}</InlineError> : null}
      </div>
    );
  };

  const indexOf = (id: string) => rows.findIndex((row) => row.id === id);
  return (
    <div
      {...pickRootProps(props)}
      ref={rootRef}
      role="group"
      aria-label={ariaLabel}
      className={cn("grid min-w-0 gap-1.5", str(className))}
    >
      {rows.length > 0 ? (
        <div
          aria-hidden="true"
          className={cn(
            KV_GRID,
            "text-2xs font-medium text-text-secondary",
            // A sortable row insets its content past the grip.
            reorderable === true && "pl-8 pr-2"
          )}
        >
          <span className={KV_HEAD}>{nonEmpty(keyLabel) ?? "Key"}</span>
          <span className={KV_HEAD}>{nonEmpty(valueLabel) ?? "Value"}</span>
          <span className={actionsWidth} />
        </div>
      ) : null}
      {reorderable === true && rows.length > 0 ? (
        <SortableList
          items={rows}
          getId={(row) => row.id}
          aria-label={ariaLabel}
          handle
          isItemDisabled={() => inert}
          getItemLabel={(row, index) => row.key.trim() || `Row ${index + 1}`}
          onChange={(next) => update([...next])}
          renderItem={(row) => renderRow(row, indexOf(row.id))}
        />
      ) : (
        rows.map((row, index) => <div key={row.id}>{renderRow(row, index)}</div>)
      )}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-row-focus="add"
          disabled={inert || full}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {nonEmpty(addLabel) ?? "Add"}
        </Button>
      </div>
      {pasteNote ? <SkippedNote lines={[pasteNote]} /> : null}
    </div>
  );
}

function readItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function listErrors(
  items: readonly string[],
  options: { allowDuplicates: boolean; validate?: (item: string) => unknown }
): (string | null)[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed !== "") counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return items.map((item) => {
    const trimmed = item.trim();
    if (trimmed === "") return null;
    if (!options.allowDuplicates && (counts.get(trimmed) ?? 0) > 1) return "Already in the list";
    return verdict(options.validate, trimmed);
  });
}

export function KitListEditor(props: PluginListEditorProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onValidityChange,
    validate,
    allowDuplicates,
    reorderable,
    placeholder,
    addLabel,
    max,
    variant,
    disabled,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => readItems(defaultValue));
  const items = controlled ? readItems(value) : own;
  const [ids, setIds] = useState<string[]>([]);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  // What the last paste couldn't fit under `max`, until the next edit.
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const counterRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const handleValue = fn(onValueChange);
  const inert = disabled === true;
  const limit = wholeLimit(max, 10_000);
  const full = limit !== undefined && items.length >= limit;
  const code = variant === "code";
  const ariaLabel = nonEmpty(props["aria-label"]) ?? "Items";
  // Row identity survives the editor's own edits; rows a list changed from
  // outside adds past the known ones are named by position.
  const taken = new Set<string>();
  const rowIds = items.map((_, index) => {
    let id = ids[index] ?? `${baseId}-at-${index}`;
    while (taken.has(id)) id = `${id}-${index}`;
    taken.add(id);
    return id;
  });
  const rows = items.map((item, index) => ({ id: rowIds[index]!, value: item }));
  const errors = listErrors(items, {
    allowDuplicates: allowDuplicates === true,
    validate: fn(validate),
  });
  useValidityReport(
    errors.every((error) => error === null),
    fn(onValidityChange)
  );
  const clearFocus = () => setFocusTarget(null);
  useFocusRequest(rootRef, focusTarget, clearFocus);

  const update = (next: { id: string; value: string }[]) => {
    setPasteNote(null);
    setIds(next.map((row) => row.id));
    const values = next.map((row) => row.value);
    if (!controlled) setOwn(values);
    safely("ListEditor onValueChange", handleValue, values);
  };
  const newId = () => `${baseId}-new-${++counterRef.current}`;
  const add = () => {
    if (full || inert) return;
    const id = newId();
    update([...rows, { id, value: "" }]);
    setFocusTarget(id);
  };
  const remove = (index: number) => {
    const next = rows.filter((_, at) => at !== index);
    update(next);
    const neighbour = next[index] ?? next[index - 1];
    setFocusTarget(neighbour ? neighbour.id : "add");
  };
  const paste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const lines = event.clipboardData
      .getData("text")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    event.preventDefault();
    const row = rows[index]!;
    const fill = row.value === "";
    const room = Math.max(
      0,
      limit === undefined ? lines.length : limit - rows.length + (fill ? 1 : 0)
    );
    const note = pasteOverflow(lines.length, room, limit, ["item", "items"]);
    if (room === 0) {
      setPasteNote(note);
      return;
    }
    const incoming = lines
      .slice(0, room)
      .map((line, at) => ({ id: fill && at === 0 ? row.id : newId(), value: line }));
    update(
      fill
        ? [...rows.slice(0, index), ...incoming, ...rows.slice(index + 1)]
        : [...rows.slice(0, index + 1), ...incoming, ...rows.slice(index + 1)]
    );
    setPasteNote(note);
  };

  const renderRow = (row: { id: string; value: string }, index: number) => {
    const error = errors[index] ?? null;
    const errorId = `${baseId}-error-${row.id}`;
    return (
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <input
            data-row-focus={row.id}
            type="text"
            value={row.value}
            placeholder={str(placeholder)}
            aria-label={`${ariaLabel} ${index + 1}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={inert}
            spellCheck={code ? false : undefined}
            autoComplete="off"
            onChange={(event) =>
              update(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, value: event.target.value } : entry
                )
              )
            }
            onPaste={(event) => paste(index, event)}
            className={cn(
              inputVariants({ density: "compact", invalid: error !== null }),
              "min-w-0 flex-1",
              code && "font-mono"
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={inert}
            aria-label={`Remove ${row.value.trim() || `item ${index + 1}`}`}
            onClick={() => remove(index)}
            className={REMOVE_ROW_CLASS}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <InlineError id={errorId}>{error}</InlineError> : null}
      </div>
    );
  };

  const indexOf = (id: string) => rows.findIndex((row) => row.id === id);
  return (
    <div
      {...pickRootProps(props)}
      ref={rootRef}
      role="group"
      aria-label={ariaLabel}
      className={cn("grid min-w-0 gap-1.5", str(className))}
    >
      {reorderable === true && rows.length > 0 ? (
        <SortableList
          items={rows}
          getId={(row) => row.id}
          aria-label={ariaLabel}
          handle
          isItemDisabled={() => inert}
          getItemLabel={(row, index) => row.value.trim() || `Item ${index + 1}`}
          onChange={(next) => update([...next])}
          renderItem={(row) => renderRow(row, indexOf(row.id))}
        />
      ) : (
        rows.map((row, index) => <div key={row.id}>{renderRow(row, index)}</div>)
      )}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-row-focus="add"
          disabled={inert || full}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {nonEmpty(addLabel) ?? "Add"}
        </Button>
      </div>
      {pasteNote ? <SkippedNote lines={[pasteNote]} /> : null}
    </div>
  );
}
