import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import type {
  PluginComposerProps,
  PluginMentionSuggestion,
  PluginMentionTextareaProps,
} from "@shared/types/plugin-sdk-react";
import { AutocompleteMenu, type AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { textareaVariants } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stepListboxCursor } from "@/hooks/useListboxCursor";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileMatchesAccept } from "./PluginKitInputs";
import {
  field,
  fn,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  str,
  useKitOwnerAttributes,
  wholeLimit,
  rowCount,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { isThenable, reportPluginFault, settleThenable } from "./kitDiagnostics";
import { invalidProp, useKitFieldControl } from "./kitField";
import { AttachmentChipView, readAttachmentList } from "./PluginKitWorkflows";
import { pickAria, joinIds, safely, attempt } from "./kitTextInputHelpers";

/**
 * Hands `element` to a ref the plugin passed, whichever kind it is. Runs in
 * React's commit phase, so a throwing callback or a frozen object is logged
 * rather than allowed to tear the view down.
 */
function assignRef<T>(ref: Ref<T> | undefined, element: T | null): void {
  try {
    if (typeof ref === "function") ref(element);
    else if (typeof ref === "object" && ref !== null) {
      (ref as { current: T | null }).current = element;
    }
  } catch (error) {
    reportPluginFault("ref threw", error);
  }
}

// Mention autocomplete.

interface MentionTriggerSpec {
  char: string;
  title?: string;
  emptyMessage: string;
  atStart: boolean;
}

interface MentionSession {
  char: string;
  /** Index of the trigger character. */
  start: number;
  query: string;
}

const MAX_SUGGESTIONS = 50;
const MAX_QUERY = 64;
const VIEWPORT_MARGIN = 8;
const MENU_MAX_WIDTH = 420;
/** Room above the line the menu needs before it would rather open below. */
const MENU_ROOM = 240;

function readTriggers(value: unknown): MentionTriggerSpec[] {
  if (!Array.isArray(value)) return [];
  const out: MentionTriggerSpec[] = [];
  for (const entry of value) {
    const spec: unknown = typeof entry === "string" ? { char: entry } : entry;
    if (typeof spec !== "object" || spec === null) continue;
    const char = str(field(spec, "char"));
    // One UTF-16 unit, which is what the caret scan compares.
    if (char === undefined || char.length !== 1 || /\s/.test(char)) continue;
    if (out.some((existing) => existing.char === char)) continue;
    out.push({
      char,
      title: nonEmpty(field(spec, "title")),
      emptyMessage: nonEmpty(field(spec, "emptyMessage")) ?? "No matches",
      atStart: field(spec, "atStart") === true,
    });
  }
  return out;
}

function readSuggestions(value: unknown): PluginMentionSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginMentionSuggestion[] = [];
  for (const entry of value) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = nonEmpty(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      insertText: nonEmpty(field(entry, "insertText")),
      description: nonEmpty(field(entry, "description")),
      badge: nonEmpty(field(entry, "badge")),
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

/**
 * The trigger the caret sits in: the nearest trigger character before it with
 * no whitespace between, standing at the start of the text or after
 * whitespace (only at the very start, for an `atStart` trigger).
 */
export function findMentionSession(
  text: string,
  caret: number,
  triggers: readonly Pick<MentionTriggerSpec, "char" | "atStart">[]
): MentionSession | null {
  if (triggers.length === 0) return null;
  for (let at = caret - 1; at >= 0 && caret - at <= MAX_QUERY + 1; at--) {
    const ch = text[at]!;
    if (/\s/.test(ch)) return null;
    const trigger = triggers.find((candidate) => candidate.char === ch);
    if (!trigger) continue;
    const boundary = trigger.atStart ? at === 0 : at === 0 || /\s/.test(text[at - 1]!);
    if (boundary) return { char: ch, start: at, query: text.slice(at + 1, caret) };
  }
  return null;
}

/**
 * `text` with the session's trigger and query replaced by the suggestion, and
 * where the caret goes: after the inserted token and the one space that
 * separates it from what follows.
 */
export function insertMention(
  text: string,
  session: MentionSession,
  suggestion: Pick<PluginMentionSuggestion, "label" | "insertText">
): { text: string; caret: number } {
  const token = nonEmpty(suggestion.insertText) ?? `${session.char}${suggestion.label}`;
  const before = text.slice(0, session.start);
  const after = text.slice(session.start + 1 + session.query.length);
  const spaced = token.endsWith(" ") || after.startsWith(" ");
  const piece = spaced ? token : `${token} `;
  const skip = !token.endsWith(" ") && after.startsWith(" ") ? 1 : 0;
  return { text: before + piece + after, caret: before.length + piece.length + skip };
}

function sessionKey(session: MentionSession): string {
  return `${session.char}\u0000${session.query}`;
}

const MIRRORED_STYLES = [
  "box-sizing",
  "width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "tab-size",
] as const;

function lineHeightOf(style: CSSStyleDeclaration): number {
  const line = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(line) && line > 0) return line;
  const size = Number.parseFloat(style.fontSize);
  return Number.isFinite(size) && size > 0 ? size * 1.5 : 20;
}

/** Where character `index` of a textarea draws, relative to its border box. */
function caretBox(textarea: HTMLTextAreaElement, index: number) {
  const doc = textarea.ownerDocument;
  const style = doc.defaultView?.getComputedStyle(textarea);
  if (!style) return { left: 0, top: 0, height: 20 };
  const mirror = doc.createElement("div");
  for (const prop of MIRRORED_STYLES) mirror.style.setProperty(prop, style.getPropertyValue(prop));
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, index);
  const marker = doc.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const box = {
    left: marker.offsetLeft + borderLeft - textarea.scrollLeft,
    top: marker.offsetTop + borderTop - textarea.scrollTop,
    height: lineHeightOf(style),
  };
  mirror.remove();
  return box;
}

interface MenuPosition {
  left: number;
  top: number;
  height: number;
  /** The menu's width: the host's 420px, or less in a narrower field. */
  width: number;
  placement: "above" | "below";
}

/**
 * The menu starts at the trigger, the way the host composer's does, and
 * stays within the field's own width where it can. It hangs off the line
 * the trigger is on, or off the whole of `frame` when there is one (a
 * composer's shell), so it never covers the shell's chips or edge. Above
 * unless there is plainly more room below, since a composer usually sits at
 * the bottom of its pane.
 */
function menuPosition(
  textarea: HTMLTextAreaElement,
  start: number,
  frame?: HTMLElement | null
): MenuPosition {
  const rect = textarea.getBoundingClientRect();
  const bounds = frame?.getBoundingClientRect() ?? rect;
  const caret = caretBox(textarea, start);
  const view = textarea.ownerDocument.defaultView;
  const viewWidth = view?.innerWidth ?? 1024;
  const viewHeight = view?.innerHeight ?? 768;
  const width = Math.min(
    MENU_MAX_WIDTH,
    viewWidth - VIEWPORT_MARGIN * 2,
    Math.max(240, bounds.width)
  );
  const lineTop = Math.min(
    Math.max(rect.top + caret.top, rect.top),
    Math.max(rect.top, rect.bottom - caret.height)
  );
  const top = frame ? bounds.top : lineTop;
  const height = frame ? bounds.height : caret.height;
  const floor = Math.max(VIEWPORT_MARGIN, frame ? bounds.left : rect.left - VIEWPORT_MARGIN);
  const ceiling = Math.min(
    viewWidth - width - VIEWPORT_MARGIN,
    Math.max(floor, bounds.right - width)
  );
  // The viewport has the last word: a field near the window's edge lends the
  // menu room to its left rather than letting it run off screen.
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      Math.max(floor, Math.min(rect.left + caret.left - VIEWPORT_MARGIN, ceiling)),
      viewWidth - width - VIEWPORT_MARGIN
    )
  );
  const above = top - VIEWPORT_MARGIN;
  const below = viewHeight - top - height - VIEWPORT_MARGIN;
  return {
    left,
    top,
    height,
    width,
    placement: above >= MENU_ROOM || above >= below ? "above" : "below",
  };
}

/** Grows the textarea with its text between `minRows` and `maxRows`, then scrolls. */
function fitTextarea(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return;
  const line = lineHeightOf(style);
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const border =
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0);
  const min = line * minRows + padding + border;
  const max = line * maxRows + padding + border;
  el.style.height = "auto";
  const natural = el.scrollHeight + border;
  el.style.height = `${Math.min(Math.max(natural, min), max)}px`;
  el.style.overflowY = natural > max ? "auto" : "hidden";
}

/** The next row the arrows land on, stepping over disabled ones. */
function stepEnabled(
  key: string,
  index: number,
  items: readonly PluginMentionSuggestion[]
): number | null {
  let at = index;
  for (let tries = 0; tries < items.length; tries++) {
    const next = stepListboxCursor(key, at, items.length, { wrap: true });
    if (next === null) return null;
    if (!items[next]?.disabled) return next;
    at = next;
  }
  return null;
}

function firstEnabled(items: readonly PluginMentionSuggestion[]): number {
  const index = items.findIndex((item) => !item.disabled);
  return index < 0 ? 0 : index;
}

interface MentionFieldProps extends PluginMentionTextareaProps {
  /** `bare` drops the field chrome, for a textarea inside a shell that draws it. */
  chrome?: "field" | "bare";
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  defaultMinRows?: number;
  defaultMaxRows?: number;
  /** The element the menu hangs off instead of the trigger's line. */
  menuFrame?: RefObject<HTMLElement | null>;
}

const BARE_TEXTAREA_CLASS =
  "block w-full resize-none border-0 bg-transparent p-0 text-sm text-text-primary placeholder:text-text-placeholder disabled:cursor-not-allowed";

function MentionField(props: MentionFieldProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    triggers,
    getSuggestions,
    onSuggestionInsert,
    onKeyDown,
    onBlur,
    onFocus,
    placeholder,
    name,
    disabled,
    readOnly,
    autoFocus,
    spellCheck,
    maxLength,
    invalid,
    minRows,
    maxRows,
    variant,
    density,
    ref,
    className,
    chrome = "field",
    onPaste,
    defaultMinRows = 1,
    defaultMaxRows = 8,
    menuFrame,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => str(defaultValue) ?? "");
  const text = controlled ? (str(value) ?? "") : own;
  const [session, setSession] = useState<MentionSession | null>(null);
  const [items, setItems] = useState<PluginMentionSuggestion[]>([]);
  const [itemsKey, setItemsKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  // The trigger Escape closed; the menu stays shut until the caret leaves it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const requestRef = useRef(0);
  const caretRef = useRef<{ text: string; caret: number } | null>(null);
  const listboxId = useId();
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const triggerList = readTriggers(triggers);
  const load = fn(getSuggestions);
  const inserted = fn(onSuggestionInsert);
  const handleValue = fn(onValueChange);
  const handleKeyDown = fn(onKeyDown);
  const handleBlur = fn(onBlur);
  const handleFocus = fn(onFocus);
  const limit = wholeLimit(maxLength, Number.MAX_SAFE_INTEGER);
  // At least one row: a fraction such as 0.5 floors to nothing.
  const rowsMin = rowCount(minRows, 100) ?? defaultMinRows;
  const rowsMax = Math.max(rowsMin, rowCount(maxRows, 100) ?? defaultMaxRows);
  const inert = disabled === true || readOnly === true;
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(props, invalidProp(invalid));

  const trigger = session ? triggerList.find((entry) => entry.char === session.char) : undefined;
  const fresh = session !== null && itemsKey === sessionKey(session);
  const stale = session !== null && (loading || !fresh);
  // A parent that replaces the text under an open menu (a reset, a rejected
  // edit) leaves the session pointing at text that is no longer there.
  const live =
    session !== null &&
    text.slice(session.start, session.start + 1 + session.query.length) ===
      `${session.char}${session.query}`;
  const open = live && trigger !== undefined && load !== undefined && !inert;
  const shownItems = open ? items : [];
  const active = open && !stale ? shownItems[selected] : undefined;
  const actionable = active && !active.disabled ? active : undefined;

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    fitTextarea(el, rowsMin, rowsMax);
    const pending = caretRef.current;
    if (pending && el.value === pending.text) {
      caretRef.current = null;
      el.setSelectionRange(pending.caret, pending.caret);
    }
  }, [text, rowsMin, rowsMax]);

  // A narrower field wraps the text onto more lines.
  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitTextarea(el, rowsMin, rowsMax);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowsMin, rowsMax]);

  const sessionStart = session?.start ?? null;
  useEffect(() => {
    if (sessionStart === null) return;
    const el = innerRef.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const place = () => setPosition(menuPosition(el, sessionStart, menuFrame?.current));
    view.addEventListener("resize", place);
    view.addEventListener("scroll", place, true);
    // A pane resized while the menu is open narrows the field under it.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    observer?.observe(menuFrame?.current ?? el);
    return () => {
      view.removeEventListener("resize", place);
      view.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [sessionStart, menuFrame]);

  const request = (next: MentionSession) => {
    const seq = ++requestRef.current;
    const key = sessionKey(next);
    const settle = (list: unknown) => {
      if (requestRef.current !== seq) return;
      const read = readSuggestions(list);
      setItems(read);
      setItemsKey(key);
      setLoading(false);
      setSelected(firstEnabled(read));
    };
    if (!load) return;
    const outcome = attempt(() => load(next.char, next.query));
    if (!outcome.ok) {
      reportPluginFault("MentionTextarea getSuggestions threw", outcome.error);
      settle([]);
      return;
    }
    if (isThenable(outcome.value)) {
      setLoading(true);
      settleThenable(outcome.value).then(settle, (error: unknown) => {
        reportPluginFault("MentionTextarea getSuggestions rejected", error);
        settle([]);
      });
      return;
    }
    settle(outcome.value);
  };

  const close = () => {
    requestRef.current++;
    setSession(null);
    setLoading(false);
  };

  const sync = (el: HTMLTextAreaElement) => {
    const collapsed = el.selectionStart === el.selectionEnd;
    const found =
      collapsed && triggerList.length > 0 && !inert
        ? findMentionSession(el.value, el.selectionStart, triggerList)
        : null;
    if (found === null || found.start !== dismissed) setDismissed(null);
    const next = found && found.start !== dismissed ? found : null;
    if (next === null) {
      if (session !== null) close();
      return;
    }
    if (
      session &&
      session.char === next.char &&
      session.start === next.start &&
      session.query === next.query
    ) {
      return;
    }
    setSession(next);
    setPosition(menuPosition(el, next.start, menuFrame?.current));
    request(next);
  };

  const change = (next: string) => {
    if (!controlled) setOwn(next);
    safely("MentionTextarea onValueChange", handleValue, next);
  };

  const insert = (suggestion: PluginMentionSuggestion) => {
    if (!session || !open) return;
    const result = insertMention(text, session, suggestion);
    if (limit !== undefined && result.text.length > limit) {
      close();
      return;
    }
    caretRef.current = result;
    close();
    change(result.text);
    safely("MentionTextarea onSuggestionInsert", inserted, suggestion, session.char);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !event.nativeEvent.isComposing) {
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (bare && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const next = stepEnabled(event.key, selected, shownItems);
        if (next !== null) {
          event.preventDefault();
          setSelected(next);
          return;
        }
      }
      if (bare && (event.key === "Enter" || event.key === "Tab") && actionable) {
        event.preventDefault();
        insert(actionable);
        return;
      }
      // Rows still on their way: Enter waits for them rather than acting on
      // the half-typed query (sending it, in a Composer). An empty or
      // all-disabled result lets the key through.
      if (bare && event.key === "Enter" && stale) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        // The menu's Escape, not the pane's or the dialog's around it.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(session?.start ?? null);
        close();
        return;
      }
    }
    safely("MentionTextarea onKeyDown", handleKeyDown, event);
  };

  // A row shows the token it inserts ("/explain", "@alice"), as the host's
  // own menu does, unless the plugin inserts something else.
  const menuItems: AutocompleteItem[] = shownItems.map((item) => ({
    key: item.id,
    label: item.insertText ? item.label : `${session?.char ?? ""}${item.label}`,
    insertText: item.insertText ?? `${session?.char ?? ""}${item.label}`,
    description: item.description,
    badge: item.badge,
    disabled: item.disabled,
  }));
  const staleKeys = stale ? new Set(menuItems.map((item) => item.key)) : undefined;
  const activeIndex = actionable ? selected : -1;

  const textareaClass =
    chrome === "bare"
      ? cn(BARE_TEXTAREA_CLASS, variant === "code" && "font-mono text-xs")
      : textareaVariants({
          density: oneOf(density, ["default", "compact"] as const),
          variant: oneOf(variant, ["default", "code"] as const),
          resize: "none",
          invalid: shownInvalid,
        });

  return (
    <>
      <textarea
        {...pickRootProps(props, { aria: true })}
        {...controlProps}
        ref={(element) => {
          innerRef.current = element;
          assignRef(ref, element);
        }}
        // A textarea keeps its textbox role (ARIA in HTML allows no other);
        // the suggestions are tied to it by `aria-controls` and the active
        // row by `aria-activedescendant`, both valid on a textbox.
        aria-autocomplete={triggerList.length > 0 ? "list" : undefined}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        value={text}
        rows={rowsMin}
        name={str(name)}
        placeholder={str(placeholder)}
        disabled={disabled === true}
        readOnly={readOnly === true}
        autoFocus={autoFocus === true}
        spellCheck={typeof spellCheck === "boolean" ? spellCheck : undefined}
        maxLength={limit}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          caretRef.current = null;
          change(event.target.value);
          sync(event.target);
        }}
        onSelect={(event) => sync(event.currentTarget)}
        onKeyDown={keyDown}
        onPaste={onPaste}
        onFocus={() => safely("MentionTextarea onFocus", handleFocus)}
        onBlur={() => {
          close();
          setDismissed(null);
          safely("MentionTextarea onBlur", handleBlur);
        }}
        // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- a bare textarea sits in a shell that paints the ring for it via has-[textarea:focus-visible]
        className={cn(textareaClass, chrome === "bare" && "outline-hidden", str(className))}
      />
      {position && typeof document !== "undefined"
        ? createPortal(
            <div
              {...owner}
              className={cn("fixed z-[var(--z-popover)]", overlayZ)}
              style={{
                left: position.left,
                top: position.top,
                height: position.height,
                width: 0,
              }}
            >
              <AutocompleteMenu
                isOpen={open}
                items={menuItems}
                selectedIndex={selected}
                isLoading={loading}
                staleKeys={staleKeys}
                onSelect={(item) => {
                  const suggestion = shownItems.find((entry) => entry.id === item.key);
                  if (suggestion && !suggestion.disabled) insert(suggestion);
                }}
                onHoverIndex={(index) => {
                  if (!shownItems[index]?.disabled) setSelected(index);
                }}
                style={
                  position.placement === "below"
                    ? {
                        left: 0,
                        top: "100%",
                        bottom: "auto",
                        marginTop: 4,
                        width: position.width,
                      }
                    : { left: 0, marginBottom: 4, width: position.width }
                }
                listboxId={listboxId}
                title={trigger?.title}
                ariaLabel={trigger?.title ?? "Suggestions"}
                emptyMessage={trigger?.emptyMessage ?? "No matches"}
              />
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function KitMentionTextarea(props: PluginMentionTextareaProps) {
  return <MentionField {...props} chrome="field" />;
}

// The composer.

/** An attachment as read from the plugin; the icon is narrowed where it is drawn. */

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function KitComposer(props: PluginComposerProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onSubmit,
    submitOn,
    busy,
    onStop,
    disabled,
    placeholder,
    triggers,
    getSuggestions,
    onSuggestionInsert,
    attachments,
    onRemoveAttachment,
    onAttach,
    accept,
    maxLength,
    toolbar,
    submitLabel,
    minRows,
    maxRows,
    autoFocus,
    ref,
    className,
  } = props;
  const overlayZ = useKitOverlayZClass();
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => str(defaultValue) ?? "");
  const text = controlled ? (str(value) ?? "") : own;
  const [dragDepth, setDragDepth] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLUListElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const countId = useId();
  const submit = fn(onSubmit);
  const stop = fn(onStop);
  const attach = fn(onAttach);
  const removeAttachment = fn(onRemoveAttachment);
  const handleValue = fn(onValueChange);
  const inert = disabled === true;
  const working = busy === true;
  const acceptText = nonEmpty(accept);
  const chips = readAttachmentList(attachments);
  const limit = wholeLimit(maxLength, Number.MAX_SAFE_INTEGER);
  const sendOnEnter = oneOf(submitOn, ["mod+enter", "enter"] as const) === "enter";
  const canSend = !inert && !working && (text.trim() !== "" || chips.length > 0);
  const dragging = dragDepth > 0 && attach !== undefined && !inert;
  const showCount = limit !== undefined && text.length >= limit * 0.8;
  const label = nonEmpty(submitLabel) ?? "Send";
  const sendCombo = sendOnEnter ? "Enter" : "Cmd+Enter";
  const sendKeys = sendOnEnter ? "Enter" : isMac() ? "Meta+Enter" : "Control+Enter";

  const change = (next: string) => {
    if (!controlled) setOwn(next);
    safely("Composer onValueChange", handleValue, next);
  };
  const send = () => {
    if (!canSend) return;
    safely("Composer onSubmit", submit, text);
  };
  const halt = () => safely("Composer onStop", stop);
  const take = (list: ArrayLike<File> | null | undefined) => {
    if (!attach || !list) return;
    const files = Array.from(list).filter((file) => fileMatchesAccept(file, acceptText));
    if (files.length > 0) safely("Composer onAttach", attach, files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      const mod = event.metaKey || event.ctrlKey;
      const plain = !mod && !event.shiftKey && !event.altKey;
      if (mod || (sendOnEnter && plain)) {
        event.preventDefault();
        send();
      }
      return;
    }
  };

  const remove = (id: string, index: number, button: HTMLButtonElement) => {
    // The chip's button is about to go: focus moves to the next chip's, or to
    // the text after the last.
    if (button.ownerDocument.activeElement === button) {
      const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-attachment-remove]"
      );
      (buttons?.[index + 1] ?? textareaRef.current)?.focus();
    }
    safely("Composer onRemoveAttachment", removeAttachment, id);
  };

  return (
    <div
      {...pickRootProps(props)}
      ref={shellRef}
      data-busy={working ? "" : undefined}
      data-drag-over={dragging ? "" : undefined}
      aria-disabled={inert ? true : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-md)] border bg-surface-input px-2.5 pt-2 pb-1.5 transition-[border-color,background-color,box-shadow] duration-150 ease-out",
        // The host composer's focus: the shell's own edge takes the accent
        // and a one-pixel halo, rather than a second outline around it.
        "has-[textarea:focus-visible]:border-[color-mix(in_oklab,var(--color-accent-primary)_70%,var(--color-border-input))] has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-[color-mix(in_oklab,var(--color-accent-primary)_25%,transparent)]",
        dragging ? "border-text-secondary bg-overlay-soft" : "border-border-input",
        inert ? "cursor-not-allowed opacity-50" : "cursor-text",
        str(className)
      )}
      onKeyDown={(event) => {
        // Escape stops from anywhere in the composer, Stop itself included.
        // An open suggestion menu takes its own Escape first and stops it
        // here.
        if (event.key !== "Escape" || !working || !stop || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        halt();
      }}
      onPointerDown={(event) => {
        // A press on the shell's padding puts the caret in the text.
        if (event.target !== event.currentTarget || inert) return;
        event.preventDefault();
        textareaRef.current?.focus();
      }}
      onDragEnter={(event) => {
        if (!attach || inert || !carriesFiles(event)) return;
        event.preventDefault();
        setDragDepth((n) => n + 1);
      }}
      onDragOver={(event) => {
        if (!attach || inert || !carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        setDragDepth((n) => Math.max(0, n - 1));
      }}
      onDrop={(event) => {
        if (!attach || inert || !carriesFiles(event)) return;
        event.preventDefault();
        setDragDepth(0);
        take(event.dataTransfer.files);
      }}
    >
      {chips.length > 0 ? (
        <ul ref={chipsRef} aria-label="Attachments" className="flex min-w-0 flex-wrap gap-1">
          {chips.map((chip, index) => (
            <li key={chip.id} className="flex min-w-0">
              <AttachmentChipView
                attachment={chip}
                disabled={inert}
                onRemove={removeAttachment ? (button) => remove(chip.id, index, button) : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <MentionField
        {...pickAria(props)}
        chrome="bare"
        menuFrame={shellRef}
        ref={(element) => {
          textareaRef.current = element;
          assignRef(ref, element);
        }}
        value={text}
        onValueChange={change}
        triggers={triggers}
        getSuggestions={getSuggestions}
        onSuggestionInsert={onSuggestionInsert}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (!attach) return;
          const files = event.clipboardData.files;
          if (files.length === 0) return;
          event.preventDefault();
          take(files);
        }}
        placeholder={str(placeholder)}
        disabled={inert}
        autoFocus={autoFocus === true}
        maxLength={limit}
        minRows={minRows}
        maxRows={maxRows}
        defaultMinRows={2}
        defaultMaxRows={10}
        aria-label={str(props["aria-label"]) ?? "Message"}
        aria-describedby={joinIds([
          str(props["aria-describedby"]),
          showCount ? countId : undefined,
        ])}
        aria-keyshortcuts={sendKeys}
      />
      <div className="flex min-h-7 min-w-0 items-center gap-1">
        {attach ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* The host composer's accessory control: a 24px round glyph. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Attach files"
                  disabled={inert}
                  onClick={() => fileRef.current?.click()}
                  className="rounded-full [&_svg]:size-3.5"
                >
                  <Paperclip aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className={overlayZ}>
                Attach files
              </TooltipContent>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              hidden
              tabIndex={-1}
              multiple
              accept={acceptText}
              disabled={inert}
              onChange={(event) => {
                const files = event.target.files ? Array.from(event.target.files) : [];
                // Cleared first, so choosing the same file again still reports it.
                event.target.value = "";
                take(files);
              }}
            />
          </>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-1">{node(toolbar)}</div>
        {showCount ? (
          <span
            id={countId}
            className={cn(
              "shrink-0 px-1 text-2xs tabular-nums",
              text.length >= (limit ?? 0) ? "text-text-primary" : "text-text-secondary"
            )}
          >
            <span aria-hidden="true">
              {text.length.toLocaleString()} / {(limit ?? 0).toLocaleString()}
            </span>
            <span className="sr-only">{`${text.length} of ${limit ?? 0} characters`}</span>
          </span>
        ) : null}
        {/* One button that changes between Send and Stop, so a keyboard user
            who sent from it is still on it when it becomes Stop. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={working ? "outline" : "contrast"}
              size="sm"
              disabled={working ? inert || !stop : !canSend}
              aria-keyshortcuts={working ? "Escape" : sendKeys}
              onClick={working ? halt : send}
            >
              {working ? (
                <Square aria-hidden="true" className="fill-current" />
              ) : (
                <ArrowUp aria-hidden="true" />
              )}
              {working ? "Stop" : label}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className={overlayZ}>
            <span className="inline-flex items-center gap-2">
              {working ? "Stop" : label}
              <KbdChord shortcut={working ? "Escape" : sendCombo} density="compact" />
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {working ? "Working" : ""}
      </span>
    </div>
  );
}
