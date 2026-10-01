import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { Bold, Code, Italic, Link as LinkIcon, List, ListOrdered } from "lucide-react";
import type {
  PluginCodeEditorProps,
  PluginDiffViewProps,
  PluginMarkdownEditorMode,
  PluginMarkdownEditorProps,
} from "@shared/types/plugin-sdk-react";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/textarea";
import { UnderlineTabs } from "@/components/ui/UnderlineTabs";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { cn } from "@/lib/utils";
import { Markdown } from "@/pluginUi/Markdown";
import { keybindingService } from "@/services/KeybindingService";
import { hotkeyHostBinding } from "./PluginKitHooksFeedback";
import { pluginKitPatterns } from "./PluginKitPatterns";
import {
  applyMarkdownEdit,
  formatMarkdown,
  type MarkdownEdit,
  type MarkdownFormat,
} from "./kitMarkdownFormat";
import { fn, node, nonEmpty, oneOf, pickRootProps, positive, str, rowCount } from "./kitProps";
import { invalidProp } from "./kitField";

// The editing surfaces: CodeEditor and DiffView are the host's own CodeMirror
// editor and diff viewer behind a lazy chunk each (neither may load with the
// kit), and MarkdownEditor is the host's comment field — a Textarea, as the
// diff notes composer uses — with a toolbar and a rendered preview.

const LazyCodeEditor = lazy(() => import("./kitCodeEditor"));
const LazyDiffView = lazy(() => import("./kitDiffView"));

// The file viewer's line box at text-sm: CodeMirror's content line plus its
// 4px top and bottom padding, so the skeleton holds the loaded editor's height.
const EDITOR_LINE_PX = 20;
const EDITOR_PADDING_PX = 8;
const MAX_HEIGHT_PX = 100_000;

function lineCount(text: string): number {
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
}

function fitLines(px: number): number {
  return Math.max(1, Math.floor((px - EDITOR_PADDING_PX) / EDITOR_LINE_PX));
}

/** As many skeleton lines as the text will draw, inside the height bounds. */
function skeletonLineCount(
  textLines: number,
  min: number | undefined,
  max: number | undefined
): number {
  const floor = min === undefined ? 1 : fitLines(min);
  const ceiling = max === undefined ? 24 : Math.min(fitLines(max), 24);
  return Math.max(floor, Math.min(textLines, ceiling));
}

/** The file viewer's gutter and ragged lines, the shape the editor loads into. */
function EditorSkeleton({
  lines,
  gutter,
  label,
}: {
  lines: number;
  gutter: boolean;
  label: string;
}) {
  return (
    <Skeleton
      label={label}
      className="flex min-h-0 flex-1 gap-3 overflow-hidden py-1"
      style={{ height: lines * EDITOR_LINE_PX + EDITOR_PADDING_PX }}
    >
      {gutter ? <SkeletonBone className="ml-2 w-6 shrink-0 self-stretch" /> : null}
      <SkeletonText
        lines={lines}
        className={cn("min-w-0 flex-1 pt-1", gutter ? "pr-3" : "px-3")}
        lineHeightClassName="h-3"
        gapClassName="space-y-2"
      />
    </Skeleton>
  );
}

function KitCodeEditor({
  value,
  defaultValue,
  onChange,
  language,
  readOnly,
  lineNumbers,
  wrap,
  placeholder,
  minHeight,
  maxHeight,
  onSave,
  autoFocus,
  bordered,
  "aria-label": ariaLabel,
  className,
  ref,
  ...rest
}: PluginCodeEditorProps) {
  const controlled = str(value);
  const initial = str(defaultValue) ?? "";
  const min = positive(minHeight, MAX_HEIGHT_PX);
  const max = positive(maxHeight, MAX_HEIGHT_PX);
  const gutter = lineNumbers !== false;
  const framed = bordered !== false;
  const label = nonEmpty(ariaLabel);
  const skeletonLines = skeletonLineCount(lineCount(controlled ?? initial), min, max);
  return (
    <div
      {...pickRootProps(rest)}
      data-kit-code-editor=""
      data-read-only={readOnly === true ? "" : undefined}
      className={cn(
        // Flex column so the editor fills a box sized by `className`, and
        // shrinks to scroll under `maxHeight`. CodeMirror scrolls itself, so
        // its scroller takes both axes rather than the kit's box.
        "flex min-w-0 flex-col overflow-hidden bg-surface-canvas text-sm leading-[inherit]",
        "[&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-1 [&_.cm-scroller]:overflow-auto",
        // The field's ring, drawn where the caret is: CodeMirror marks its
        // editor .cm-focused while the text has focus (the find bar's own
        // search field rings itself).
        "has-[.cm-focused]:outline has-[.cm-focused]:outline-2 has-[.cm-focused]:outline-accent-primary",
        framed
          ? "rounded-[var(--radius-lg)] border border-border-default has-[.cm-focused]:outline-offset-2"
          : "has-[.cm-focused]:-outline-offset-2",
        str(className)
      )}
      style={{ minHeight: min, maxHeight: max }}
    >
      <Suspense
        fallback={
          <EditorSkeleton
            lines={skeletonLines}
            gutter={gutter}
            label={label ? `Loading ${label}` : "Loading editor"}
          />
        }
      >
        <LazyCodeEditor
          value={controlled}
          defaultValue={initial}
          onChange={fn(onChange)}
          onSave={fn(onSave)}
          language={nonEmpty(language)}
          readOnly={readOnly === true}
          lineNumbers={gutter}
          wrap={wrap === true}
          placeholder={nonEmpty(placeholder)}
          autoFocus={autoFocus === true}
          ariaLabel={label}
          handleRef={
            typeof ref === "function" || (typeof ref === "object" && ref !== null) ? ref : undefined
          }
        />
      </Suspense>
    </div>
  );
}

function KitDiffView({
  oldText,
  newText,
  patch,
  path,
  language,
  view,
  wrap,
  context,
  hunkActions,
  onHunkAction,
  renderHunkActions,
  maxHeight,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginDiffViewProps) {
  const before = str(oldText);
  const after = str(newText);
  const lines =
    before !== undefined && after !== undefined
      ? Math.min(lineCount(after), 12)
      : Math.min(lineCount(str(patch) ?? ""), 12);
  const contextLines =
    typeof context === "number" && Number.isInteger(context) && context >= 0 && context <= 1000
      ? context
      : 3;
  const actions =
    typeof hunkActions === "function" || Array.isArray(hunkActions) ? hunkActions : undefined;
  const rootProps = pickRootProps(rest);
  return (
    <Suspense
      fallback={
        <Skeleton
          {...rootProps}
          label="Loading diff"
          className={cn(
            "min-w-0 space-y-2 rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas p-3",
            str(className)
          )}
        >
          <SkeletonBone className="h-4 w-1/3" />
          <SkeletonText lines={lines} lineHeightClassName="h-3" />
        </Skeleton>
      }
    >
      <LazyDiffView
        oldText={before}
        newText={after}
        patch={str(patch)}
        path={nonEmpty(path)}
        language={nonEmpty(language)}
        view={oneOf(view, ["unified", "split"] as const) ?? "unified"}
        wrap={wrap === true}
        context={contextLines}
        hunkActions={actions}
        onHunkAction={fn(onHunkAction)}
        renderHunkActions={fn(renderHunkActions)}
        maxHeight={positive(maxHeight, MAX_HEIGHT_PX)}
        ariaLabel={nonEmpty(ariaLabel)}
        className={str(className)}
        rootProps={rootProps}
      />
    </Suspense>
  );
}

const MODES = ["write", "preview"] as const;
const SPLIT_MIN_WIDTH = 720;

interface FormatControl {
  format: MarkdownFormat;
  label: string;
  combo: string;
  icon: ReactElement;
}

// GitHub's comment-box bindings, so a hand trained there works here. Cmd+B and
// Cmd+K are Daintree's own by default (the sidebar, the chord prefix); a combo
// the app is bound to stays the app's and is never advertised.
const FORMAT_CONTROLS: readonly FormatControl[] = [
  { format: "bold", label: "Bold", combo: "Cmd+B", icon: <Bold /> },
  { format: "italic", label: "Italic", combo: "Cmd+I", icon: <Italic /> },
  { format: "code", label: "Code", combo: "Cmd+E", icon: <Code /> },
  { format: "link", label: "Link", combo: "Cmd+K", icon: <LinkIcon /> },
  { format: "bullets", label: "Bulleted list", combo: "Cmd+Shift+8", icon: <List /> },
  { format: "numbers", label: "Numbered list", combo: "Cmd+Shift+7", icon: <ListOrdered /> },
];

function freeCombo(combo: string): string | undefined {
  return hotkeyHostBinding(combo) === null ? combo : undefined;
}

function insertNativeText(text: string): boolean {
  try {
    // Deprecated, but the only edit a text area's own undo stack records.
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

/** Applies `edit` as one native edit, so the text area's own undo takes it back in one step. */
function applyToTextarea(textarea: HTMLTextAreaElement, edit: MarkdownEdit): boolean {
  textarea.focus();
  textarea.setSelectionRange(edit.from, edit.to);
  const applied = insertNativeText(edit.insert);
  if (applied) textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  return applied;
}

function KitMarkdownEditor({
  value,
  defaultValue,
  onChange,
  placeholder,
  mode,
  defaultMode,
  onModeChange,
  layout,
  onSubmit,
  onCancel,
  minRows,
  maxRows,
  toolbar,
  footer,
  disabled,
  readOnly,
  autoFocus,
  invalid,
  basePath,
  rootPath,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginMarkdownEditorProps) {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controlled = str(value);
  const [ownText, setOwnText] = useState(() => str(defaultValue) ?? "");
  const text = controlled ?? ownText;
  const requestedMode = oneOf(mode, MODES);
  const [ownMode, setOwnMode] = useState<PluginMarkdownEditorMode>(
    () => oneOf(defaultMode, MODES) ?? "write"
  );
  const activeMode = requestedMode ?? ownMode;
  const handleChange = fn(onChange);
  const handleModeChange = fn(onModeChange);
  const handleSubmit = fn(onSubmit);
  const handleCancel = fn(onCancel);
  const inert = disabled === true;
  const locked = readOnly === true;
  const showToolbar = toolbar !== false && !inert && !locked;
  const rowsMin = rowCount(minRows, 200) ?? 3;
  const rowsMax = Math.max(rowsMin, rowCount(maxRows, 1000) ?? 16);
  const layoutMode = oneOf(layout, ["tabs", "split", "auto"] as const) ?? "tabs";

  const [wide, setWide] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (layoutMode !== "auto" || !root || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(root.getBoundingClientRect().width >= SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [layoutMode]);
  const split = layoutMode === "split" || (layoutMode === "auto" && wide);

  // The text area grows with its text between its row bounds; the preview
  // keeps the height the source had, so switching sides moves nothing below.
  const [sourceHeight, setSourceHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const measure = () => {
      // Hidden behind Preview it has no box to measure; the last height stands.
      if (textarea.closest("[hidden]")) return;
      const style = getComputedStyle(textarea);
      const line = Number.parseFloat(style.lineHeight) || 20;
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      textarea.style.height = "auto";
      const wanted = Math.min(
        Math.max(textarea.scrollHeight, rowsMin * line + padding),
        rowsMax * line + padding
      );
      textarea.style.height = `${wanted}px`;
      textarea.style.overflowY = textarea.scrollHeight > wanted + 1 ? "auto" : "hidden";
      setSourceHeight(wanted);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // A narrower pane wraps more lines: measure again when the width moves
    // (the height this sets fires the observer too, and is ignored).
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = textarea.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      measure();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [text, rowsMin, rowsMax, activeMode, split]);

  const setText = (next: string) => {
    if (controlled === undefined) setOwnText(next);
    handleChange?.(next);
  };

  const setMode = (next: PluginMarkdownEditorMode) => {
    if (next === activeMode) return;
    if (requestedMode === undefined) setOwnMode(next);
    handleModeChange?.(next);
  };

  const pendingSelection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const textarea = textareaRef.current;
    if (!selection || !textarea) return;
    pendingSelection.current = null;
    textarea.setSelectionRange(selection[0], selection[1]);
  }, [text]);

  const format = (kind: MarkdownFormat) => {
    const textarea = textareaRef.current;
    if (!textarea || inert || locked) return;
    const edit = formatMarkdown(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      kind
    );
    if (applyToTextarea(textarea, edit)) return;
    // No native edit (a test DOM): set the text and put the selection back after render.
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
    setText(applyMarkdownEdit(textarea.value, edit));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && handleCancel) {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (!handleSubmit) return;
      event.preventDefault();
      handleSubmit(event.currentTarget.value);
      return;
    }
    if (!showToolbar) return;
    for (const control of FORMAT_CONTROLS) {
      if (!keybindingService.matchesEvent(event.nativeEvent, control.combo)) continue;
      // The host's capture listener has already taken a combo it is bound to
      // where it is live; one bound elsewhere is still left to the app.
      if (hotkeyHostBinding(control.combo) !== null) return;
      event.preventDefault();
      format(control.format);
      return;
    }
  };

  const tabId = (id: PluginMarkdownEditorMode) => `${baseId}-tab-${id}`;
  const panelId = (id: PluginMarkdownEditorMode) => `${baseId}-panel-${id}`;
  const label = nonEmpty(ariaLabel);

  const textarea = (
    // The host's Textarea, for its field wiring (a kit FormField's label,
    // description and error reach it), drawn without its own box: the frame
    // around the strip and the text is the field.
    <Textarea
      ref={textareaRef}
      aria-label={label}
      data-kit-markdown-source=""
      value={text}
      placeholder={str(placeholder)}
      rows={rowsMin}
      disabled={inert}
      readOnly={locked}
      autoFocus={autoFocus === true}
      invalid={invalidProp(invalid)}
      resize="none"
      spellCheck
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      // The frame draws the field's ring; the text area is its content.
      // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the frame rings it through has-[textarea:focus-visible]
      className="block rounded-none border-0 bg-transparent focus-visible:outline-hidden disabled:opacity-100"
    />
  );
  const source = split ? (
    textarea
  ) : (
    // Kept mounted behind Preview, so the text area's own undo history
    // survives a look at the preview.
    <div
      id={panelId("write")}
      role="tabpanel"
      aria-labelledby={tabId("write")}
      hidden={activeMode !== "write"}
    >
      {textarea}
    </div>
  );

  // Exactly the source's height, so switching sides moves nothing below the
  // field; a longer preview scrolls inside it. Opened straight into Preview,
  // before the source has been measured, it takes the source's first height.
  const previewHeight = sourceHeight ?? rowsMin * 20 + 16;
  const showPreview = split || activeMode === "preview";
  const preview = (
    <div
      id={split ? undefined : panelId("preview")}
      role={split ? "region" : "tabpanel"}
      aria-labelledby={split ? undefined : tabId("preview")}
      aria-label={split ? "Preview" : undefined}
      tabIndex={split ? undefined : 0}
      // Mounted behind Write too, so the Preview tab's aria-controls always
      // resolves; its content renders only while it shows.
      hidden={!showPreview}
      data-kit-markdown-preview=""
      className="min-w-0 overflow-auto px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      style={{ height: previewHeight }}
    >
      {!showPreview ? null : text.trim() === "" ? (
        <p className="text-sm text-text-secondary">Nothing to preview</p>
      ) : (
        <Markdown
          source={text}
          align="start"
          fontSize="sm"
          basePath={nonEmpty(basePath)}
          rootPath={nonEmpty(rootPath)}
        />
      )}
    </div>
  );

  const { Toolbar, ToolbarButton } = pluginKitPatterns;
  const tools =
    showToolbar && (split || activeMode === "write") ? (
      <Toolbar aria-label="Formatting" className="ml-auto pr-1">
        {FORMAT_CONTROLS.map((control) => (
          <ToolbarButton
            key={control.format}
            icon={control.icon}
            aria-label={control.label}
            tooltip={createTooltipContent(control.label, freeCombo(control.combo))}
            onClick={() => format(control.format)}
          />
        ))}
      </Toolbar>
    ) : null;

  const footerContent = node(footer);
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      data-kit-markdown-editor=""
      data-mode={split ? "split" : activeMode}
      className={cn("flex min-w-0 flex-col gap-2", str(className))}
    >
      <div
        className={cn(
          // The Textarea's field, drawn around the strip and the body so the
          // two read as one control; its ring sits on the frame.
          "flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border bg-surface-input",
          invalid === true ? "border-status-error" : "border-border-input",
          "has-[textarea:focus-visible]:outline has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-accent-primary",
          inert && "opacity-50"
        )}
      >
        <div className="flex h-8 shrink-0 items-stretch border-b border-divider">
          {split ? (
            <span className="flex items-center px-3 text-xs text-text-secondary">Write</span>
          ) : (
            <UnderlineTabs
              tabs={[
                { id: "write", label: "Write" },
                { id: "preview", label: "Preview" },
              ]}
              activeId={activeMode}
              onChange={setMode}
              aria-label="Markdown editor mode"
              tabId={tabId}
              panelId={panelId}
              density="strip"
            />
          )}
          {tools}
          {split ? (
            <span className="flex w-1/2 shrink-0 items-center border-l border-divider px-3 text-xs text-text-secondary">
              Preview
            </span>
          ) : null}
        </div>
        {split ? (
          <div className="grid min-w-0 grid-cols-2">
            {source}
            <div className="min-w-0 border-l border-divider">{preview}</div>
          </div>
        ) : (
          <>
            {source}
            {preview}
          </>
        )}
      </div>
      {footerContent === null ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2">{footerContent}</div>
      )}
    </div>
  );
}

export const pluginKitEditors = {
  CodeEditor: KitCodeEditor,
  DiffView: KitDiffView,
  MarkdownEditor: KitMarkdownEditor,
};
