import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CopyPlus, Plus, X } from "lucide-react";
import type {
  PluginAttachmentChipProps,
  PluginAttachmentListProps,
  PluginAttachmentStatus,
  PluginEntityAvailability,
  PluginEntityChipProps,
  PluginFormErrorSummaryProps,
  PluginRepeaterFieldProps,
  PluginUnsavedChangesBarProps,
} from "@shared/types/plugin-sdk-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { InlineError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/Spinner";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { renderIconSource } from "./PluginKitIcons";
import { pluginKitOverlays } from "./PluginKitOverlays";
import { pluginKitDnd } from "./PluginKitDnd";
import { pluginKitRichDisplay } from "./PluginKitRichDisplay";
import {
  faultMessage,
  guardCallbacks,
  isThenable,
  reportPluginFault,
  runPluginAction,
  settleThenable,
  warnPluginAuthor,
} from "./kitDiagnostics";
import {
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  str,
  wholeLimit,
} from "./kitProps";

const ErrorGlyph = SEVERITY_GLYPH.error;
const KitAvatar = pluginKitOverlays.Avatar;
const KitHoverCard = pluginKitRichDisplay.HoverCard;
const SortableList = pluginKitDnd.SortableList;

// ---------------------------------------------------------------------------
// Attachments

const ATTACHMENT_STATUSES = ["ready", "pending", "failed"] as const;

export interface AttachmentModel {
  id: string;
  name: string;
  detail: string | undefined;
  icon: unknown;
  status: PluginAttachmentStatus;
}

export function readAttachmentList(value: unknown): AttachmentModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: AttachmentModel[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const name = nonEmpty(field(entry, "name"));
    if (id === undefined || name === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      detail: nonEmpty(field(entry, "detail")),
      icon: field(entry, "icon"),
      status: oneOf(field(entry, "status"), ATTACHMENT_STATUSES) ?? "ready",
    });
  }
  return out;
}

const CHIP_BUTTON_CLASS =
  "relative inline-flex shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-medium hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:pointer-events-none";

// A 16px X with a 24px pointer target (WCAG 2.5.8).
const CHIP_REMOVE_CLASS = cn(
  CHIP_BUTTON_CLASS,
  "h-4 w-4 after:absolute after:-inset-1 after:content-['']"
);

function AttachmentGlyph({ attachment }: { attachment: AttachmentModel }) {
  if (attachment.status === "pending") return <Spinner size="xs" className="text-text-secondary" />;
  if (attachment.status === "failed") {
    return <ErrorGlyph aria-hidden="true" className="h-3 w-3 shrink-0 text-status-error" />;
  }
  const glyph = renderIconSource(attachment.icon ?? "file");
  return glyph ? <span className="flex shrink-0 text-text-secondary">{glyph}</span> : null;
}

/**
 * The attachment chip the Composer draws and `AttachmentChip` serves. The
 * name is a button when the attachment can be opened (not while pending).
 */
export function AttachmentChipView({
  attachment,
  onOpen,
  onRemove,
  removeLabel,
  disabled,
  rootAttributes,
  className,
}: {
  attachment: AttachmentModel;
  onOpen?: () => void;
  /** Gets the X, so a list can move focus before the chip goes. */
  onRemove?: (button: HTMLButtonElement) => void;
  removeLabel?: string;
  disabled: boolean;
  rootAttributes?: Record<string, string | number | boolean>;
  className?: string;
}) {
  const openable = onOpen !== undefined && attachment.status !== "pending";
  const failed = attachment.status === "failed";
  return (
    <Badge
      {...rootAttributes}
      size="sm"
      tone="outline"
      className={cn("min-w-0 max-w-60 gap-1 pr-0.5 text-text-primary", className)}
      data-attachment={attachment.id}
      data-status={attachment.status === "ready" ? undefined : attachment.status}
    >
      <AttachmentGlyph attachment={attachment} />
      {openable ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onOpen}
          className={cn(
            CHIP_BUTTON_CLASS,
            "min-w-0 px-0.5 text-text-primary hover:bg-transparent hover:underline"
          )}
        >
          <span className="truncate">{attachment.name}</span>
        </button>
      ) : (
        <span className="truncate">{attachment.name}</span>
      )}
      {attachment.detail ? (
        <span className="shrink-0 text-text-secondary">{attachment.detail}</span>
      ) : null}
      {failed && !attachment.detail ? <span className="sr-only">Failed</span> : null}
      {attachment.status === "pending" ? <span className="sr-only">Uploading</span> : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel ?? `Remove ${attachment.name}`}
          disabled={disabled}
          data-attachment-remove=""
          onClick={(event) => onRemove(event.currentTarget)}
          className={CHIP_REMOVE_CLASS}
        >
          <X aria-hidden="true" />
        </button>
      ) : (
        <span className="w-0.5" />
      )}
    </Badge>
  );
}

function KitAttachmentChip({
  name,
  detail,
  icon,
  status,
  onOpen,
  onRemove,
  removeLabel,
  disabled,
  className,
  ...rest
}: PluginAttachmentChipProps) {
  const label = nonEmpty(name) ?? "";
  const open = fn(onOpen);
  const remove = fn(onRemove);
  return (
    <AttachmentChipView
      attachment={{
        id: label,
        name: label,
        detail: nonEmpty(detail),
        icon,
        status: oneOf(status, ATTACHMENT_STATUSES) ?? "ready",
      }}
      onOpen={open ? () => runPluginAction("AttachmentChip onOpen", open) : undefined}
      onRemove={remove ? () => runPluginAction("AttachmentChip onRemove", remove) : undefined}
      removeLabel={nonEmpty(removeLabel)}
      disabled={disabled === true}
      rootAttributes={pickRootProps(rest)}
      className={str(className)}
    />
  );
}

/**
 * Focus for a removal, taken before the parent drops the item: the next X,
 * else the one before, else the list's root, which stays when it empties.
 */
function focusNeighbour(root: HTMLElement | null, index: number, button: HTMLButtonElement) {
  if (!root || button.ownerDocument.activeElement !== button) return;
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-attachment-remove]");
  (buttons[index + 1] ?? buttons[index - 1] ?? root).focus();
}

function KitAttachmentList({
  attachments,
  layout,
  onOpen,
  onRemove,
  empty,
  disabled,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginAttachmentListProps) {
  // The root outlives its last item, so removing that one still has
  // somewhere for focus to land.
  const rootRef = useRef<HTMLDivElement>(null);
  const items = readAttachmentList(attachments);
  const open = fn(onOpen);
  const remove = fn(onRemove);
  const inert = disabled === true;
  const rows = oneOf(layout, ["chips", "rows"] as const) === "rows";
  const name = nonEmpty(ariaLabel) ?? "Attachments";
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        "min-w-0 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      {items.length === 0 ? (
        hasContent(empty) ? (
          <div className="text-sm text-text-secondary">{node(empty)}</div>
        ) : null
      ) : (
        <ul
          aria-label={name}
          className={cn(
            "min-w-0",
            rows ? "flex flex-col divide-y divide-divider" : "flex flex-wrap gap-1"
          )}
        >
          {items.map((item, index) => {
            const openItem = open
              ? () => runPluginAction("AttachmentList onOpen", () => open(item.id))
              : undefined;
            const removeItem = remove
              ? (button: HTMLButtonElement) => {
                  focusNeighbour(rootRef.current, index, button);
                  runPluginAction("AttachmentList onRemove", () => remove(item.id));
                }
              : undefined;
            if (!rows) {
              return (
                <li key={item.id} className="flex min-w-0">
                  <AttachmentChipView
                    attachment={item}
                    onOpen={openItem}
                    onRemove={removeItem}
                    disabled={inert}
                  />
                </li>
              );
            }
            const openable = openItem !== undefined && item.status !== "pending";
            return (
              <li
                key={item.id}
                data-attachment={item.id}
                data-status={item.status === "ready" ? undefined : item.status}
                className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-sm"
              >
                <AttachmentGlyph attachment={item} />
                {openable ? (
                  <button
                    type="button"
                    disabled={inert}
                    onClick={openItem}
                    className="min-w-0 truncate rounded-[var(--radius-xs)] text-left text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  >
                    {item.name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-text-primary">{item.name}</span>
                )}
                <span
                  className={cn(
                    "ml-auto shrink-0 text-xs tabular-nums",
                    item.status === "failed" ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {item.detail ??
                    (item.status === "pending"
                      ? "Uploading"
                      : item.status === "failed"
                        ? "Failed"
                        : null)}
                </span>
                {removeItem ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    disabled={inert}
                    data-attachment-remove=""
                    onClick={(event) => removeItem(event.currentTarget)}
                    className={cn(CHIP_REMOVE_CLASS, "h-6 w-6 after:hidden")}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntityChip

const AVAILABILITIES = ["available", "loading", "missing", "forbidden"] as const;

const UNAVAILABLE_WORD: Record<Exclude<PluginEntityAvailability, "available">, string> = {
  loading: "Loading",
  missing: "Deleted",
  forbidden: "No access",
};

function KitEntityChip({
  label,
  type,
  icon,
  avatar,
  availability,
  onOpen,
  preview,
  className,
  ...rest
}: PluginEntityChipProps) {
  const name = nonEmpty(label) ?? "";
  const kind = nonEmpty(type);
  const state = oneOf(availability, AVAILABILITIES) ?? "available";
  const available = state === "available";
  const openRecord = available ? fn(onOpen) : undefined;
  const open = openRecord ? () => runPluginAction("EntityChip onOpen", openRecord) : undefined;
  const avatarName =
    typeof avatar === "object" && avatar !== null ? nonEmpty(field(avatar, "name")) : undefined;
  const glyph = renderIconSource(icon);
  const leading =
    state === "loading" ? (
      <Spinner size="xs" className="text-text-secondary" />
    ) : avatarName ? (
      <KitAvatar src={str(field(avatar as object, "src"))} name={avatarName} size="xs" decorative />
    ) : glyph ? (
      <span className="flex shrink-0 text-text-secondary [&_svg]:h-3 [&_svg]:w-3">{glyph}</span>
    ) : null;
  const spoken = [kind, name, available ? undefined : UNAVAILABLE_WORD[state]]
    .filter(Boolean)
    .join(", ");
  const body = (
    <>
      {leading}
      <span
        className={cn(
          "truncate",
          !available && "text-text-secondary",
          state === "missing" && "line-through"
        )}
      >
        {name}
      </span>
      {available || state === "loading" ? null : (
        <span className="shrink-0 text-text-secondary">· {UNAVAILABLE_WORD[state]}</span>
      )}
    </>
  );
  const chipClass = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-[var(--radius-sm)] border border-border-subtle bg-overlay-subtle px-1.5 py-0.5 align-middle text-xs text-text-primary",
    str(className)
  );
  const showPreview = available && hasContent(preview);
  const chip = open ? (
    <button
      {...pickRootProps(rest)}
      type="button"
      aria-label={spoken}
      onClick={open}
      data-entity-chip=""
      className={cn(
        chipClass,
        "cursor-pointer transition-colors duration-150 ease-out hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      )}
    >
      {body}
    </button>
  ) : (
    <span
      {...pickRootProps(rest)}
      role="img"
      aria-label={spoken}
      aria-busy={state === "loading" || undefined}
      // A preview needs something to focus for keyboard users.
      tabIndex={showPreview ? 0 : undefined}
      data-entity-chip=""
      data-availability={available ? undefined : state}
      className={cn(
        chipClass,
        showPreview &&
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      )}
    >
      {body}
    </span>
  );
  if (!showPreview) return chip;
  return <KitHoverCard content={node(preview)}>{chip}</KitHoverCard>;
}

// ---------------------------------------------------------------------------
// RepeaterField

const MAX_REPEATER_ITEMS = 10_000;
const attemptRepeater = guardCallbacks("RepeaterField");
let warnedRepeaterKey = false;

interface RepeaterEntry<T> {
  item: T;
  key: string;
  index: number;
}

/**
 * Keys from `getKey`, made unique: a repeat is suffixed (and the suffix
 * checked again) rather than allowed to share state. A missing key falls
 * back to the position, which cannot keep state on an item that moves.
 */
function repeaterEntries<T>(
  items: readonly T[],
  keyOf: ((item: T, index: number) => string) | undefined
): RepeaterEntry<T>[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const given = keyOf ? attemptRepeater(() => keyOf(item, index), undefined) : undefined;
    const valid = typeof given === "string" && given !== "";
    if (!valid && !warnedRepeaterKey) {
      warnedRepeaterKey = true;
      warnPluginAuthor("RepeaterField: getKey must return a non-empty string per item.");
    }
    const base = valid ? given : `#${index}`;
    let key = base;
    for (let n = index; seen.has(key); n += 1) key = `${base}#${n}`;
    if (key !== base && !warnedRepeaterKey) {
      warnedRepeaterKey = true;
      warnPluginAuthor(
        `RepeaterField: getKey returned "${base}" for two items; keys must be unique.`
      );
    }
    seen.add(key);
    return { item, key, index };
  });
}

function itemNodes(root: HTMLElement, key: string): HTMLElement | undefined {
  for (const element of root.querySelectorAll<HTMLElement>("[data-repeater-item]")) {
    if (element.getAttribute("data-repeater-item") === key) return element;
  }
  return undefined;
}

const FOCUSABLE =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function KitRepeaterField<T>(props: PluginRepeaterFieldProps<T>) {
  const {
    items,
    getKey,
    renderItem,
    onChange,
    createItem,
    duplicateItem,
    getItemLabel,
    addLabel,
    min,
    max,
    reorderable,
    errors,
    empty,
    disabled,
    "aria-label": ariaLabel,
    className,
    ...rest
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  // After an add or a removal: the new item's first field, a neighbour's
  // Remove, or Add when the list has emptied.
  const [focusTarget, setFocusTarget] = useState<
    { key: string; part: "field" | "remove" } | "add" | null
  >(null);
  const list: readonly T[] = Array.isArray(items) ? items : [];
  const entries = repeaterEntries(list, fn(getKey));
  const render = fn(renderItem);
  const change = fn(onChange);
  const create = fn(createItem);
  const duplicate = fn(duplicateItem);
  const labelOf = fn(getItemLabel);
  const inert = disabled === true;
  const floor = wholeLimit(min, MAX_REPEATER_ITEMS) ?? 0;
  const ceiling = wholeLimit(max, MAX_REPEATER_ITEMS);
  const full =
    entries.length >= MAX_REPEATER_ITEMS || (ceiling !== undefined && entries.length >= ceiling);
  const errorFor = (key: string): ReactNode =>
    typeof errors === "object" && errors !== null && Object.hasOwn(errors, key)
      ? content(field(errors, key))
      : undefined;
  const nameOf = (entry: RepeaterEntry<T>) =>
    nonEmpty(
      labelOf ? attemptRepeater(() => labelOf(entry.item, entry.index), undefined) : undefined
    ) ?? `Item ${entry.index + 1}`;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (focusTarget === null || !root) return;
    setFocusTarget(null);
    const item = focusTarget === "add" ? undefined : itemNodes(root, focusTarget.key);
    const field = item?.querySelector<HTMLElement>(`[data-repeater-body] :is(${FOCUSABLE})`);
    const remove = item?.querySelector<HTMLButtonElement>("[data-repeater-remove]:not(:disabled)");
    const add = root.querySelector<HTMLButtonElement>("[data-repeater-add]:not(:disabled)");
    // The first of these that can take focus: a Remove held at `min` cannot,
    // nor an Add that is not offered, and the group itself always can.
    const order =
      focusTarget === "add"
        ? [add]
        : focusTarget.part === "remove"
          ? [remove, field, add]
          : [field, remove];
    (order.find((element) => element != null) ?? root).focus();
  }, [focusTarget]);

  const commit = (next: T[]) => {
    if (change) runPluginAction("RepeaterField onChange", () => change(next));
  };
  const add = () => {
    if (!create || full || inert) return;
    const made = attemptRepeater(() => create(), undefined as T | undefined);
    if (made === undefined) return;
    const next = [...entries.map((entry) => entry.item), made];
    commit(next);
    const key = repeaterEntries(next, fn(getKey))[next.length - 1]?.key;
    if (key !== undefined) setFocusTarget({ key, part: "field" });
  };
  const removeAt = (index: number) => {
    if (inert || entries.length <= floor) return;
    const remaining = entries.filter((entry) => entry.index !== index);
    commit(remaining.map((entry) => entry.item));
    const neighbour = remaining[index] ?? remaining[index - 1];
    setFocusTarget(neighbour ? { key: neighbour.key, part: "remove" } : "add");
  };
  const duplicateAt = (index: number) => {
    const source = entries[index];
    if (!duplicate || !source || full || inert) return;
    const copy = attemptRepeater(() => duplicate(source.item), undefined as T | undefined);
    if (copy === undefined) return;
    const next = entries.map((entry) => entry.item);
    next.splice(index + 1, 0, copy);
    commit(next);
    const key = repeaterEntries(next, fn(getKey))[index + 1]?.key;
    if (key !== undefined) setFocusTarget({ key, part: "field" });
  };
  const updateAt = (index: number, value: T) => {
    if (inert) return;
    const next = entries.map((entry) => entry.item);
    next[index] = value;
    commit(next);
  };

  const drawItem = (entry: RepeaterEntry<T>) => {
    const error = errorFor(entry.key);
    const name = nameOf(entry);
    const body = render
      ? node(
          attemptRepeater(
            () =>
              render(entry.item, {
                index: entry.index,
                key: entry.key,
                update: (value) => updateAt(entry.index, value),
                remove: () => removeAt(entry.index),
                error,
                disabled: inert,
              }),
            null
          )
        )
      : null;
    return (
      <div
        data-repeater-item={entry.key}
        data-invalid={error === undefined ? undefined : ""}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1.5 rounded-[var(--radius-md)] border bg-surface-panel p-2.5",
          error === undefined ? "border-border-subtle" : "border-status-error"
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          <div data-repeater-body="" className="min-w-0 flex-1">
            {body}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {duplicate ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Duplicate ${name}`}
                disabled={inert || full}
                onClick={() => duplicateAt(entry.index)}
              >
                <CopyPlus aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${name}`}
              data-repeater-remove=""
              disabled={inert || entries.length <= floor}
              onClick={() => removeAt(entry.index)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        {error === undefined ? null : <InlineError>{error}</InlineError>}
      </div>
    );
  };

  const label = nonEmpty(ariaLabel) ?? "";
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      // Focus's last resort after a removal leaves nothing else to take it.
      tabIndex={-1}
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-2 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      {entries.length === 0 ? (
        hasContent(empty) ? (
          <div className="text-sm text-text-secondary">{node(empty)}</div>
        ) : null
      ) : reorderable === true ? (
        <SortableList
          items={entries}
          aria-label={label}
          handle
          getId={(entry: RepeaterEntry<T>) => entry.key}
          getItemLabel={(entry: RepeaterEntry<T>) => nameOf(entry)}
          isItemDisabled={() => inert}
          onChange={(next: RepeaterEntry<T>[]) => commit(next.map((entry) => entry.item))}
          renderItem={(entry: RepeaterEntry<T>) => drawItem(entry)}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.key} className="flex min-w-0">
              {drawItem(entry)}
            </li>
          ))}
        </ul>
      )}
      {create ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            data-repeater-add=""
            disabled={inert || full}
            onClick={add}
          >
            <Plus aria-hidden="true" />
            {nonEmpty(addLabel) ?? "Add item"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormErrorSummary

function readFormErrors(value: unknown): { field: string | undefined; message: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { field: string | undefined; message: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = nonEmpty(field(entry, "message"));
    if (message === undefined) continue;
    out.push({ field: nonEmpty(field(entry, "field")), message });
  }
  // The form's own problems first: they are not reachable through a control.
  return [...out.filter((entry) => !entry.field), ...out.filter((entry) => entry.field)];
}

function KitFormErrorSummary({
  errors,
  title,
  onSelect,
  autoFocus,
  className,
  ...rest
}: PluginFormErrorSummaryProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const list = readFormErrors(errors);
  const select = fn(onSelect);
  const shown = list.length > 0;
  // The focus a choice scheduled: dropped if the summary goes first, so it
  // never lands on a same-id control of whatever replaced the form.
  const frameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  useLayoutEffect(() => {
    if (shown && autoFocus === true) rootRef.current?.focus();
  }, [shown, autoFocus]);
  if (!shown) return null;
  const go = (id: string) => {
    if (select) runPluginAction("FormErrorSummary onSelect", () => select(id));
    // A frame later, so a section opened by `onSelect` has mounted its control.
    const doc = rootRef.current?.ownerDocument ?? document;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => doc.getElementById(id)?.focus());
  };
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      <Callout
        severity="error"
        title={<span id={titleId}>{nonEmpty(title) ?? "Fix these to continue"}</span>}
      >
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
          {list.map((entry, index) => (
            <li key={`${entry.field ?? ""}:${index}`}>
              {entry.field ? (
                <button
                  type="button"
                  data-error-field={entry.field}
                  onClick={() => go(entry.field!)}
                  className="rounded-[var(--radius-xs)] text-left text-text-primary underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                >
                  {entry.message}
                </button>
              ) : (
                entry.message
              )}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnsavedChangesBar

function KitUnsavedChangesBar({
  changes,
  onSave,
  onDiscard,
  saving,
  error,
  saveLabel,
  discardLabel,
  message,
  className,
  ...rest
}: PluginUnsavedChangesBarProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Which save is current: a result for an older one changes nothing.
  const sessionRef = useRef(0);
  // Held from the press, before the plugin runs: a second press, or one the
  // plugin's own code fires, is refused even before React has re-rendered.
  const lockRef = useRef(false);
  useEffect(
    () => () => {
      sessionRef.current += 1;
    },
    []
  );
  const count =
    typeof changes === "number" && Number.isFinite(changes) ? Math.max(0, Math.floor(changes)) : 0;
  // Edits gone (discarded, or saved some other way) take their failure with them.
  useEffect(() => {
    if (count === 0) setFailure(null);
  }, [count]);
  const busy = saving === true || pending;
  if (count === 0 && !busy) return null;
  const shownError = content(error) ?? failure ?? undefined;
  const save = fn(onSave);
  const discard = fn(onDiscard);
  const runSave = () => {
    if (!save || busy || lockRef.current) return;
    lockRef.current = true;
    setFailure(null);
    const session = ++sessionRef.current;
    let out: unknown;
    try {
      out = save();
    } catch (thrown) {
      lockRef.current = false;
      reportPluginFault("UnsavedChangesBar onSave threw", thrown);
      setFailure(faultMessage(thrown, "Couldn't save"));
      return;
    }
    if (!isThenable(out)) {
      lockRef.current = false;
      return;
    }
    setPending(true);
    settleThenable(out).then(
      () => {
        if (sessionRef.current !== session) return;
        lockRef.current = false;
        setPending(false);
      },
      (rejected: unknown) => {
        if (sessionRef.current !== session) return;
        lockRef.current = false;
        setPending(false);
        setFailure(faultMessage(rejected, "Couldn't save"));
      }
    );
  };
  return (
    <div
      {...pickRootProps(rest)}
      data-unsaved-changes=""
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel px-3 py-2",
        str(className)
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-text-primary">
          {hasContent(message)
            ? node(message)
            : count > 0
              ? `${pluralize(count, "unsaved change")}`
              : "Saving changes"}
        </span>
        {shownError === undefined ? null : <InlineError role="alert">{shownError}</InlineError>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !discard}
          onClick={() => {
            if (!discard) return;
            setFailure(null);
            runPluginAction("UnsavedChangesBar onDiscard", discard);
          }}
        >
          {nonEmpty(discardLabel) ?? "Discard"}
        </Button>
        <Button size="sm" loading={busy} disabled={!save || count === 0} onClick={runSave}>
          {nonEmpty(saveLabel) ?? "Save"}
        </Button>
      </div>
    </div>
  );
}

export const pluginKitWorkflowsRecords = {
  AttachmentChip: KitAttachmentChip,
  AttachmentList: KitAttachmentList,
  EntityChip: KitEntityChip,
  RepeaterField: KitRepeaterField,
  FormErrorSummary: KitFormErrorSummary,
  UnsavedChangesBar: KitUnsavedChangesBar,
};
