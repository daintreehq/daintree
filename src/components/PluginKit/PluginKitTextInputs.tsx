import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowUp,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import type {
  PluginComposerProps,
  PluginInlineEditProps,
  PluginKeyValueEditorProps,
  PluginKeyValuePair,
  PluginListEditorProps,
  PluginMentionSuggestion,
  PluginMentionTextareaProps,
  PluginSecretInputProps,
  PluginShortcutRecorderProps,
} from "@shared/types/plugin-sdk-react";
import { AutocompleteMenu, type AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import {
  inlineRenameFieldClassName,
  inlineRenameFieldInputProps,
} from "@/components/Panel/inlineRenameField";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { inputVariants } from "@/components/ui/input";
import { KbdChord } from "@/components/ui/Kbd";
import { Spinner } from "@/components/ui/Spinner";
import { textareaVariants } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { stepListboxCursor } from "@/hooks/useListboxCursor";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  CHORD_TIMEOUT_MS,
  keybindingService,
  normalizeKeyForBinding,
} from "@/services/KeybindingService";
import { fileMatchesAccept } from "./PluginKitInputs";
import { pluginKitDnd } from "./PluginKitDnd";
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
import {
  isThenable,
  reportPluginFault,
  settleThenable,
  runPluginAction,
  faultMessage,
} from "./kitDiagnostics";
import { invalidProp, useKitFieldControl } from "./kitField";
import { AttachmentChipView, readAttachmentList } from "./PluginKitWorkflows";

const SortableList = pluginKitDnd.SortableList;

/** Only the `aria-*` attributes, for a control inside a root that takes the rest. */
function pickAria(props: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(pickRootProps(props, { aria: true }))) {
    if (key.startsWith("aria-")) out[key] = value;
  }
  return out;
}

/** Space-separated ids for `aria-describedby`, or nothing when there are none. */
function joinIds(ids: readonly (string | undefined)[]): string | undefined {
  const joined = ids.filter((id) => id !== undefined && id !== "").join(" ");
  return joined === "" ? undefined : joined;
}

/** Hands `element` to a ref the plugin passed, whichever kind it is. */
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

/** Calls a plugin callback, reporting a throw or rejection instead of letting it reach React. */
function safely<A extends unknown[]>(
  label: string,
  callback: ((...args: A) => unknown) | undefined,
  ...args: A
): void {
  if (callback) runPluginAction(label, () => callback(...args));
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Runs a plugin callback without letting its throw reach React. */
function attempt(run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * A validator's verdict: a non-empty message refuses, anything else accepts.
 * A validator that throws refuses with `onThrow`, so a broken check never
 * lets a value through; a warning lookup passes `null` to show nothing.
 */
function verdict(
  check: ((value: string) => unknown) | undefined,
  value: string,
  onThrow: string | null = "Couldn't check this value"
): string | null {
  if (!check) return null;
  const outcome = attempt(() => check(value));
  if (!outcome.ok) {
    reportPluginFault("validator threw", outcome.error);
    return onThrow;
  }
  return nonEmpty(outcome.value)?.trim() || null;
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

function KitMentionTextarea(props: PluginMentionTextareaProps) {
  return <MentionField {...props} chrome="field" />;
}

// The composer.

/** An attachment as read from the plugin; the icon is narrowed where it is drawn. */

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function KitComposer(props: PluginComposerProps) {
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

// Inline rename.

const INLINE_SIZE = {
  sm: { text: "text-xs font-medium", box: "h-6 leading-6" },
  md: { text: "text-sm font-medium", box: "h-7 leading-7" },
  lg: { text: "text-base font-semibold", box: "h-8 leading-8" },
} as const;

function selectForEdit(input: HTMLInputElement, mode: "all" | "stem" | "end"): void {
  const length = input.value.length;
  if (mode === "end") {
    input.setSelectionRange(length, length);
    return;
  }
  if (mode === "stem") {
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : length);
    return;
  }
  input.select();
}

function KitInlineEdit(props: PluginInlineEditProps) {
  const {
    value,
    onCommit,
    validate,
    allowEmpty,
    placeholder,
    blurAction,
    activation,
    selectOnEdit,
    editing,
    onEditingChange,
    maxLength,
    disabled,
    size,
    className,
  } = props;
  const current = str(value) ?? "";
  const controlled = typeof editing === "boolean";
  const [ownEditing, setOwnEditing] = useState(false);
  const isEditing = (controlled ? editing : ownEditing) && disabled !== true;
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const showPending = useDohertyGate(pending);
  const [wasEditing, setWasEditing] = useState(isEditing);
  // Each edit is its own session: a commit still out when it ends (a
  // controlled close, a re-open) must not settle the next one.
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  // Set while plugin code runs, so a blur it causes cannot commit twice.
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLSpanElement>(null);
  // Focus goes back to the text only when the keyboard ended the edit; a
  // blur has already put it somewhere the user chose.
  const refocusRef = useRef(false);
  const errorId = useId();
  const commit = fn(onCommit);
  const check = fn(validate);
  const changeEditing = fn(onEditingChange);
  const label = nonEmpty(props["aria-label"]) ?? "Name";
  const shown = current === "" ? str(placeholder) : current;
  const sizing = INLINE_SIZE[oneOf(size, ["sm", "md", "lg"] as const) ?? "sm"];
  const mode = oneOf(selectOnEdit, ["all", "stem", "end"] as const) ?? "all";
  const onDouble = activation === "doubleClick";
  const cancelOnBlur = blurAction === "cancel";
  const limit = wholeLimit(maxLength, 10_000);

  // A controlled edit that starts from outside still begins from the value.
  if (wasEditing !== isEditing) {
    setWasEditing(isEditing);
    setGeneration((n) => n + 1);
    setPending(false);
    if (isEditing) {
      setDraft(current);
      setError(null);
    }
  }

  useLayoutEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  useLayoutEffect(() => {
    if (isEditing) {
      const input = inputRef.current;
      if (input) {
        input.focus();
        selectForEdit(input, mode);
      }
    } else if (refocusRef.current) {
      refocusRef.current = false;
      displayRef.current?.focus();
    }
  }, [isEditing, mode]);

  const setEditing = (next: boolean) => {
    if (!controlled) setOwnEditing(next);
    safely("InlineEdit onEditingChange", changeEditing, next);
  };
  const begin = () => {
    if (disabled === true || isEditing) return;
    setDraft(current);
    setError(null);
    setEditing(true);
  };
  const finish = (refocus: boolean) => {
    refocusRef.current = refocus;
    setError(null);
    setPending(false);
    setEditing(false);
  };
  const submit = (fromBlur: boolean) => {
    if (pending || submittingRef.current) return;
    const next = draft.trim();
    if (next === current) {
      finish(!fromBlur);
      return;
    }
    if (next === "" && allowEmpty !== true) {
      // Leaving an emptied field puts the name back, as the pane title does.
      if (fromBlur) finish(false);
      else setError("Enter a name");
      return;
    }
    const refused = verdict(check, next);
    if (refused) {
      setError(refused);
      return;
    }
    if (!commit) {
      finish(!fromBlur);
      return;
    }
    submittingRef.current = true;
    const outcome = attempt(() => commit(next));
    submittingRef.current = false;
    if (!outcome.ok) {
      setError(faultMessage(outcome.error, "Couldn't rename"));
      return;
    }
    if (!isThenable(outcome.value)) {
      finish(!fromBlur);
      return;
    }
    setPending(true);
    setError(null);
    const started = generation;
    const stillHere = () => {
      const input = inputRef.current;
      const active = input?.ownerDocument.activeElement;
      return !!input && (active === input || active === input.ownerDocument.body || !active);
    };
    settleThenable(outcome.value).then(
      () => {
        // Focus goes back to the text only if the user is still here;
        // someone who tabbed on while it saved keeps their place.
        if (generationRef.current === started) finish(!fromBlur && stillHere());
      },
      (reason: unknown) => {
        if (generationRef.current !== started) return;
        setPending(false);
        setError(faultMessage(reason, "Couldn't rename"));
        if (stillHere()) inputRef.current?.focus();
      }
    );
  };
  const cancel = (refocus: boolean) => {
    if (pending) return;
    finish(refocus);
  };

  if (!isEditing) {
    return (
      <span
        {...pickRootProps(props)}
        ref={displayRef}
        role="button"
        tabIndex={disabled === true ? -1 : 0}
        aria-disabled={disabled === true ? true : undefined}
        aria-label={`${label}: ${shown ?? "empty"}`}
        aria-keyshortcuts="F2"
        onClick={onDouble ? undefined : begin}
        onDoubleClick={onDouble ? begin : undefined}
        onKeyDown={(event) => {
          // A button's keys (Enter, Space) plus F2, the rename key. Space is
          // taken on keydown so it neither scrolls the pane nor types itself
          // into the field it opens.
          if (event.key === "F2" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            begin();
          }
        }}
        className={cn(
          // No negative margin: it would take 8px off the width the text
          // claims from its container, and a `truncate` title (a PaneHeader's)
          // would then clip it with room to spare. The text, the sizer and
          // the field below all share one box, so nothing shifts on edit.
          "inline-block max-w-full min-w-0 truncate rounded-sm border border-transparent px-1 align-middle transition-colors duration-150 ease-out",
          sizing.text,
          sizing.box,
          current === "" ? "text-text-secondary" : "text-text-primary",
          disabled === true
            ? "cursor-default opacity-50"
            : "cursor-text hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
          str(className)
        )}
      >
        {shown ?? " "}
      </span>
    );
  }

  return (
    <span
      {...pickRootProps(props)}
      className={cn("inline-flex max-w-full min-w-0 flex-col items-start gap-1", str(className))}
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
        <span className="inline-grid max-w-full min-w-0">
          <span
            aria-hidden="true"
            className={cn(
              "invisible col-start-1 row-start-1 block min-w-[6ch] truncate whitespace-pre border border-transparent px-1",
              sizing.text,
              sizing.box
            )}
          >
            {draft === "" ? (str(placeholder) ?? " ") : draft}
          </span>
          <input
            {...inlineRenameFieldInputProps}
            ref={inputRef}
            // No intrinsic width of its own: the sizer text sets the box, as
            // in the pane title's rename.
            size={1}
            value={draft}
            maxLength={limit}
            readOnly={pending}
            placeholder={str(placeholder)}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            aria-busy={pending ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                submit(false);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel(true);
              }
            }}
            onBlur={() => {
              if (pending) return;
              if (cancelOnBlur) cancel(false);
              else submit(true);
            }}
            className={cn(
              inlineRenameFieldClassName,
              "col-start-1 row-start-1 w-full min-w-0",
              sizing.text,
              sizing.box,
              error && "border-status-error focus-visible:border-status-error"
            )}
          />
        </span>
        {showPending ? <Spinner size="xs" className="shrink-0 text-text-secondary" /> : null}
      </span>
      {error ? (
        <InlineError id={errorId} as="span">
          {error}
        </InlineError>
      ) : null}
    </span>
  );
}

// Secrets.

const DOTS = "••••••••";

function KitSecretInput(props: PluginSecretInputProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    stored,
    storedHint,
    onReplace,
    onCancelReplace,
    onClear,
    onSubmit,
    allowCopy,
    revealable,
    placeholder,
    name,
    disabled,
    invalid,
    autoFocus,
    density,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => str(defaultValue) ?? "");
  const text = controlled ? (str(value) ?? "") : own;
  const [shown, setShown] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // What gets focus once the other state has mounted: the empty field after
  // Replace, or Replace again after backing out of it.
  const [focusTarget, setFocusTarget] = useState<"field" | "replace" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Each Replace is a session; a save still out when it ends is ignored.
  const replaceSessionRef = useRef(0);
  // The save in flight, if any: the session it belongs to. Only that save
  // may end the pending state or close the field.
  const savingRef = useRef<{ session: number } | null>(null);
  // A save that settles once the field is gone changes nothing, and calls no
  // plugin callback.
  useEffect(
    () => () => {
      savingRef.current = null;
    },
    []
  );
  const [saving, setSaving] = useState(false);
  // A save under 400ms shows nothing, per the app's loading gate.
  const showSaving = useDohertyGate(saving);
  const handleValue = fn(onValueChange);
  const replace = fn(onReplace);
  const cancelReplace = fn(onCancelReplace);
  const clear = fn(onClear);
  const submit = fn(onSubmit);
  const inert = disabled === true;
  const compact = oneOf(density, ["default", "compact"] as const) === "compact";
  const hint = nonEmpty(storedHint)?.slice(-6);
  const showStored = stored === true && !replacing;
  const canReveal = revealable !== false;
  // Turning `revealable` off hides a value that was showing.
  const revealed = canReveal && shown;
  const label = str(props["aria-label"]);
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(props, invalidProp(invalid));

  // A secret saved while the field was open (the save went through) shows as
  // saved again.
  const [wasStored, setWasStored] = useState(stored === true);
  if (wasStored !== (stored === true)) {
    setWasStored(stored === true);
    if (stored === true) {
      // The draft that was saved is not kept behind the saved state.
      setReplacing(false);
      setShown(false);
      if (!controlled) setOwn("");
    }
  }

  useLayoutEffect(() => {
    if (focusTarget === null) return;
    setFocusTarget(null);
    (focusTarget === "field" ? inputRef : replaceRef).current?.focus();
  }, [focusTarget]);

  const change = (next: string) => {
    if (!controlled) setOwn(next);
    safely("SecretInput onValueChange", handleValue, next);
  };
  // Every save is tracked the same way, first or replacement: a promise holds
  // the field read-only until it settles, and a throw or a rejection keeps
  // the typed value to try again. Only a replacement saved while `stored`
  // stays true (the usual case: a token swapped for a new one) then goes back
  // to the saved state on its own.
  const submitDraft = () => {
    // One save at a time: a second Enter while one is out does nothing.
    if (savingRef.current) return;
    const outcome = attempt(() => submit?.(text));
    if (!outcome.ok) {
      reportPluginFault("SecretInput onSubmit threw", outcome.error);
      return;
    }
    const replacingStored = replacing && stored === true;
    const close = () => {
      if (!replacingStored) return;
      // Focus follows to Replace only if the user is still in the field;
      // someone who moved on while it saved keeps their place.
      const input = inputRef.current;
      const active = input?.ownerDocument.activeElement;
      const stillHere =
        !!input && (active === input || active === input.ownerDocument.body || !active);
      change("");
      setReplacing(false);
      setShown(false);
      if (stillHere) setFocusTarget("replace");
    };
    if (!isThenable(outcome.value)) {
      close();
      return;
    }
    // While it saves the field holds read-only, so the value that lands is
    // the value that was typed; Cancel stays available.
    const token = { session: replaceSessionRef.current };
    savingRef.current = token;
    setSaving(true);
    const settle = (saved: boolean) => {
      // A save that lands after the user backed out, or started another
      // replace, changes nothing in the field they are in now.
      if (savingRef.current !== token) return;
      savingRef.current = null;
      setSaving(false);
      if (saved && replaceSessionRef.current === token.session) close();
    };
    settleThenable(outcome.value).then(
      () => settle(true),
      () => settle(false)
    );
  };
  const backOut = () => {
    replaceSessionRef.current++;
    savingRef.current = null;
    setSaving(false);
    change("");
    setReplacing(false);
    setShown(false);
    setFocusTarget("replace");
    safely("SecretInput onCancelReplace", cancelReplace);
  };

  if (showStored) {
    return (
      <div
        {...pickRootProps(props)}
        role="group"
        aria-label={label}
        aria-labelledby={str(props["aria-labelledby"])}
        aria-describedby={str(props["aria-describedby"])}
        className={cn("flex min-w-0 items-center gap-2", str(className))}
      >
        <div
          data-secret-stored=""
          className={cn(
            inputVariants({ density: compact ? "compact" : "default" }),
            "flex min-w-0 flex-1 items-center gap-2 text-text-secondary",
            inert && "opacity-50"
          )}
        >
          <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">Saved</span>
          <span aria-hidden="true" className="min-w-0 truncate font-mono tracking-wider">
            {DOTS}
            {hint}
          </span>
          {hint ? <span className="sr-only">{`ending in ${hint}`}</span> : null}
        </div>
        <Button
          ref={replaceRef}
          type="button"
          variant="outline"
          size={compact ? "xs" : "sm"}
          disabled={inert}
          onClick={() => {
            replaceSessionRef.current++;
            savingRef.current = null;
            setSaving(false);
            change("");
            setReplacing(true);
            setShown(false);
            setFocusTarget("field");
            safely("SecretInput onReplace", replace);
          }}
        >
          Replace
        </Button>
        {clear ? (
          <Button
            type="button"
            variant="ghost-danger"
            size={compact ? "xs" : "sm"}
            disabled={inert}
            onClick={() => safely("SecretInput onClear", clear)}
          >
            Clear
          </Button>
        ) : null}
      </div>
    );
  }

  const blockCopy = allowCopy !== true;
  return (
    <div
      {...pickRootProps(props)}
      className={cn("flex min-w-0 items-center gap-2", str(className))}
    >
      <div className="relative min-w-0 flex-1">
        <input
          {...pickAria(props)}
          {...controlProps}
          ref={inputRef}
          type={revealed ? "text" : "password"}
          value={text}
          name={str(name)}
          placeholder={
            str(placeholder) ??
            (replacing ? "Paste a new value to replace the saved one" : undefined)
          }
          disabled={inert}
          readOnly={saving}
          aria-busy={saving ? true : undefined}
          autoFocus={autoFocus === true}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-secret-revealed={revealed ? "" : undefined}
          onChange={(event) => change(event.target.value)}
          onCopy={blockCopy ? (event) => event.preventDefault() : undefined}
          onCut={blockCopy ? (event) => event.preventDefault() : undefined}
          onDragStart={blockCopy ? (event) => event.preventDefault() : undefined}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && submit) {
              event.preventDefault();
              submitDraft();
            } else if (event.key === "Escape" && replacing) {
              event.preventDefault();
              event.stopPropagation();
              backOut();
            }
          }}
          className={cn(
            inputVariants({
              density: compact ? "compact" : "default",
              invalid: shownInvalid,
            }),
            "font-mono placeholder:font-sans",
            canReveal && (compact ? "pr-8" : "pr-9")
          )}
        />
        {canReveal ? (
          // A glyph inside the field, not a Button: the pressed Button's
          // ring and fill drew a second box against the field's own edge.
          // The eye itself says which state it is in, and 24px is the
          // target floor.
          <button
            type="button"
            disabled={inert}
            aria-label="Show value"
            aria-pressed={revealed}
            // The field keeps focus, so a blur-to-save around it never fires.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShown((open) => !open)}
            className={cn(
              "absolute top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-hover hover:text-text-primary focus-visible:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary disabled:pointer-events-none [&_svg]:size-3.5",
              compact ? "right-px" : "right-1"
            )}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {showSaving ? <Spinner size="xs" className="shrink-0 text-text-secondary" /> : null}
      {replacing ? (
        <Button
          type="button"
          variant="ghost"
          size={compact ? "xs" : "sm"}
          disabled={inert}
          onClick={backOut}
        >
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

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

const REMOVE_ROW_CLASS =
  "h-6 w-6 shrink-0 text-text-secondary hover:text-text-primary [&_svg]:size-3.5";

/**
 * Key, value and the row's actions, as one grid the column heads share, so
 * a head sits over its fields whatever the actions column holds.
 */
const KV_GRID = "grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5";

/** A column head over a compact field: its text on the field text's own left edge. */
const KV_HEAD = "min-w-0 truncate pl-[calc(0.5rem+1px)]";

function KitKeyValueEditor(props: PluginKeyValueEditorProps) {
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
    const room = limit === undefined ? parsed.length : limit - rows.length + (fill ? 1 : 0);
    const incoming = parsed.slice(0, Math.max(0, room)).map((pair, at) => ({
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

function KitListEditor(props: PluginListEditorProps) {
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
    const room = limit === undefined ? lines.length : limit - rows.length + (fill ? 1 : 0);
    const incoming = lines
      .slice(0, Math.max(0, room))
      .map((line, at) => ({ id: fill && at === 0 ? row.id : newId(), value: line }));
    update(
      fill
        ? [...rows.slice(0, index), ...incoming, ...rows.slice(index + 1)]
        : [...rows.slice(0, index + 1), ...incoming, ...rows.slice(index + 1)]
    );
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
    </div>
  );
}

// Shortcut recording.

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS", "Hyper", "Super"]);
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/** The modifiers an event reports as down, in the order a combo spells them. */
function heldModifiers(event: KeyboardEvent<HTMLElement>, mac: boolean): string[] {
  const parts: string[] = [];
  if (mac && event.metaKey) parts.push("Cmd");
  // Control is its own modifier on macOS; elsewhere it is the primary one.
  if (mac && event.ctrlKey) parts.push("Ctrl");
  if (!mac && event.ctrlKey) parts.push("Cmd");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  return parts;
}

function hasCommandModifier(combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (FUNCTION_KEY.test(key)) return true;
  return parts.slice(0, -1).some((part) => part === "Cmd" || part === "Ctrl" || part === "Alt");
}

const CHORD_WINDOW_STYLE: CSSProperties & Record<"--chord-window", string> = {
  "--chord-window": `${CHORD_TIMEOUT_MS}ms`,
};

const RECORDER_FIELD =
  "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border transition-colors duration-150 ease-out";

/** The heights of `Input`'s two densities, so a recorder lines up with the fields beside it. */
const RECORDER_DENSITY = {
  default: "min-h-[2.125rem] px-3 text-sm",
  compact: "min-h-[1.625rem] px-2 text-xs",
} as const;

function findHostConflicts(combo: string): ReturnType<typeof keybindingService.findConflicts> {
  try {
    return keybindingService.findConflicts(combo);
  } catch (error) {
    reportPluginFault("ShortcutRecorder conflict lookup failed", error);
    return [];
  }
}

function hostConflict(combo: string): string | null {
  const conflicts = findHostConflicts(combo);
  if (conflicts.length === 0) return null;
  const exact = conflicts.find((conflict) => conflict.kind !== "shadowed") ?? conflicts[0]!;
  const name = exact.description || exact.actionId;
  const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : "";
  return exact.kind === "shadowed"
    ? `Overlaps Daintree's shortcut for ${name}${more}`
    : `Daintree uses this for ${name}${more}; its shortcut wins`;
}

function KitShortcutRecorder(props: PluginShortcutRecorderProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    allowChords,
    requireModifier,
    validate,
    getConflict,
    checkHostConflicts,
    placeholder,
    disabled,
    density,
    className,
  } = props;
  const compact = oneOf(density, ["default", "compact"] as const) === "compact";
  const chipDensity = compact ? "compact" : "default";
  const fieldRef = useRef<HTMLDivElement>(null);
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<string | null>(() => nonEmpty(defaultValue) ?? null);
  const combo = controlled ? (nonEmpty(value) ?? null) : own;
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [firstStep, setFirstStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusId = useId();
  const errorId = useId();
  const conflictId = useId();
  const handleValue = fn(onValueChange);
  const check = fn(validate);
  const conflictOf = fn(getConflict);
  const inert = disabled === true;
  const mac = isMac();
  // A div, which a `<label htmlFor>` cannot name: a vertical FormField names
  // it through `aria-labelledby` instead.
  const { controlProps } = useKitFieldControl(props, error ? true : undefined, false);

  // Disabled mid-recording: the recording, and any chord half-pressed, end.
  if (inert && (recording || firstStep !== null)) {
    setRecording(false);
    setFirstStep(null);
    setHeld([]);
  }

  useEffect(() => {
    if (!recording) return;
    // The app's own shortcuts stand down while a combo is being recorded.
    const release = keybindingService.beginShortcutCapture();
    // Held keys can't be seen once the window loses focus, and a chord
    // window must not finish while another app is in front: recording ends,
    // and the shortcut it had stays.
    const view = fieldRef.current?.ownerDocument.defaultView;
    const cancel = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setFirstStep(null);
      setHeld([]);
      setRecording(false);
    };
    view?.addEventListener("blur", cancel);
    return () => {
      view?.removeEventListener("blur", cancel);
      release();
    };
  }, [recording]);

  useEffect(() => {
    if (!inert || timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [inert]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const stopTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const setCombo = (next: string | null) => {
    if (!controlled) setOwn(next);
    safely("ShortcutRecorder onValueChange", handleValue, next);
  };
  const finish = (steps: readonly string[]) => {
    stopTimer();
    setFirstStep(null);
    setHeld([]);
    const next = steps.join(" ");
    const refused = verdict(check, next);
    if (refused) {
      setError(refused);
      return;
    }
    setError(null);
    setRecording(false);
    setCombo(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inert || event.repeat || event.nativeEvent.isComposing) return;
    // AltGr types a character; the host's matcher never fires on it either.
    if (!mac && event.nativeEvent.getModifierState?.("AltGraph")) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // Tab always moves on: a recorder that kept it would trap the keyboard.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (firstStep) finish([firstStep]);
      return;
    }
    if (!recording) {
      if (plain && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        setError(null);
        setRecording(true);
      } else if (plain && (event.key === "Backspace" || event.key === "Delete") && combo) {
        event.preventDefault();
        setCombo(null);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && plain) {
      stopTimer();
      setFirstStep(null);
      setHeld([]);
      setError(null);
      setRecording(false);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && plain && !firstStep) {
      setError(null);
      setCombo(null);
      return;
    }
    const parts = heldModifiers(event, mac);
    const normalized = normalizeKeyForBinding(event.nativeEvent);
    // A letter is spelled as the app's own bindings spell it ("Cmd+K").
    const key = normalized.length === 1 ? normalized.toUpperCase() : normalized;
    if (MODIFIER_KEYS.has(key) || MODIFIER_KEYS.has(event.key)) {
      setHeld(parts);
      return;
    }
    const step = [...parts, key].join("+");
    if (!firstStep && requireModifier !== false && !hasCommandModifier(step)) {
      setHeld([]);
      setError(
        mac
          ? "Include ⌘, ⌃ or ⌥, so the shortcut doesn't type into text fields"
          : "Include Ctrl or Alt, so the shortcut doesn't type into text fields"
      );
      return;
    }
    if (firstStep) {
      finish([firstStep, step]);
      return;
    }
    if (allowChords === true) {
      setFirstStep(step);
      setHeld([]);
      setError(null);
      stopTimer();
      timerRef.current = setTimeout(() => finish([step]), CHORD_TIMEOUT_MS);
      return;
    }
    finish([step]);
  };

  // The warnings follow what is in force until a new shortcut is under way,
  // then its first step: never the shortcut it is replacing, and no line
  // that comes and goes (moving the fields below) just because the field
  // took focus.
  const shownCombo = recording && firstStep !== null ? firstStep : combo;
  const hostWarning = shownCombo && checkHostConflicts !== false ? hostConflict(shownCombo) : null;
  const ownWarning = shownCombo ? verdict(conflictOf, shownCombo, null) : null;
  const warnings = [ownWarning, hostWarning].filter((line): line is string => line !== null);
  const describedBy = joinIds([
    // Inside a FormField the field's ids already include the caller's.
    str(field(controlProps, "aria-describedby")) ?? str(props["aria-describedby"]),
    error ? errorId : undefined,
    warnings.length > 0 ? conflictId : undefined,
    statusId,
  ]);

  let content: ReactNode;
  let status: string;
  if (recording && firstStep) {
    status = "Press the second key, or wait to finish";
    content = (
      <>
        <KbdChord shortcut={firstStep} foreground="primary" density={chipDensity} />
        <span className="truncate text-xs text-text-secondary">Press second key or wait</span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-md)]"
        >
          <span
            className="absolute inset-x-0 bottom-0 h-0.5 bg-text-secondary animate-chord-window"
            style={CHORD_WINDOW_STYLE}
          />
        </span>
      </>
    );
  } else if (recording && held.length > 0) {
    status = "Now press a key";
    content = (
      <>
        <KbdChord shortcut={held.join("+")} foreground="primary" density={chipDensity} />
        <span className="truncate text-xs text-text-secondary">Now press a key</span>
      </>
    );
  } else if (recording) {
    status = "Recording. Press a shortcut, Escape to stop";
    content = (
      <span className="truncate">
        Press a shortcut
        <span className="text-text-secondary"> · Esc to stop</span>
      </span>
    );
  } else if (combo) {
    status = "";
    content = <KbdChord shortcut={combo} foreground="primary" density={chipDensity} />;
  } else {
    status = "";
    content = (
      <span className="truncate text-text-secondary">{nonEmpty(placeholder) ?? "Not set"}</span>
    );
  }

  return (
    <div {...pickRootProps(props)} className={cn("grid min-w-0 gap-1.5", str(className))}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          {...pickAria(props)}
          {...controlProps}
          role="button"
          tabIndex={inert ? -1 : 0}
          aria-disabled={inert ? true : undefined}
          aria-pressed={recording}
          aria-describedby={describedBy}
          aria-label={
            str(props["aria-label"]) === undefined && !field(controlProps, "aria-labelledby")
              ? "Shortcut"
              : str(props["aria-label"])
          }
          data-recording={recording ? "" : undefined}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (recording && !firstStep) setHeld(heldModifiers(event, mac));
          }}
          onFocus={() => {
            if (!inert) setRecording(true);
          }}
          onClick={() => {
            if (!inert) setRecording(true);
          }}
          onBlur={() => {
            if (firstStep) finish([firstStep]);
            stopTimer();
            setHeld([]);
            setRecording(false);
          }}
          ref={fieldRef}
          className={cn(
            RECORDER_FIELD,
            RECORDER_DENSITY[compact ? "compact" : "default"],
            "relative select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
            recording
              ? "border-border-strong bg-overlay-subtle text-text-primary"
              : "border-border-input bg-surface-input text-text-primary hover:border-border-strong",
            error && "border-status-error",
            inert ? "cursor-not-allowed opacity-50" : "cursor-pointer"
          )}
        >
          {content}
        </div>
        {combo && !inert ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear shortcut"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              // The button goes with the shortcut; a keyboard user lands on
              // the field, ready to record the next one.
              const hadFocus =
                event.currentTarget.ownerDocument.activeElement === event.currentTarget;
              stopTimer();
              setFirstStep(null);
              setHeld([]);
              setError(null);
              setCombo(null);
              if (hadFocus) fieldRef.current?.focus();
            }}
            className={REMOVE_ROW_CLASS}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </span>
      {error ? (
        <InlineError id={errorId} role="alert">
          {error}
        </InlineError>
      ) : null}
      {warnings.length > 0 ? (
        <div id={conflictId} className="grid gap-1">
          {warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 text-xs text-text-primary">
              <AlertTriangle
                aria-hidden="true"
                className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
              />
              <span className="min-w-0">{warning}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const pluginKitTextInputs = {
  MentionTextarea: KitMentionTextarea,
  Composer: KitComposer,
  InlineEdit: KitInlineEdit,
  KeyValueEditor: KitKeyValueEditor,
  ListEditor: KitListEditor,
  SecretInput: KitSecretInput,
  ShortcutRecorder: KitShortcutRecorder,
};
