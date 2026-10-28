import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  PluginBulkAction,
  PluginBulkActionBarProps,
  PluginLoadMoreFooterProps,
  PluginOverflowToolbarItem,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { pluginKitLayoutCore } from "./PluginKitLayoutCore";
import {
  PROGRAMMATIC_FOCUS_RING,
  lastInputWasPointer,
  nounFor,
  trackLastInput,
  wholeCount,
} from "./kitPaneShared";
import { fn, hasContent, node, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";

const ErrorGlyph = SEVERITY_GLYPH.error;

// It replaces a list's bottom band rather than stacking under it: same edge,
// same hairline, different contents.
export function KitBulkActionBar({
  count,
  selection,
  noun,
  hiddenCount,
  actions,
  onClear,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginBulkActionBarProps) {
  const fromSelection = typeof selection === "object" && selection !== null ? selection : undefined;
  const selected = wholeCount(count) ?? wholeCount(fromSelection?.count) ?? 0;
  const clearSelection = fn(fromSelection?.clear);
  const clear = fn(onClear) ?? clearSelection;
  const hidden = wholeCount(hiddenCount) ?? 0;
  const visible = selected > 0;
  // Where focus came from when it entered the bar (the list, usually), and
  // whether it is inside the bar now: clearing takes the bar away, and focus
  // inside it would otherwise fall to the page.
  const cameFrom = useRef<HTMLElement | null>(null);
  const holdsFocus = useRef(false);

  useEffect(() => trackLastInput(), []);

  useLayoutEffect(() => {
    if (visible || !holdsFocus.current) return;
    holdsFocus.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = cameFrom.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true, focusVisible: !lastInputWasPointer() });
    }
  }, [visible]);

  if (!visible) return null;
  // The toolbar validates each action itself; the bar only asks for words.
  const items: PluginOverflowToolbarItem[] = Array.isArray(actions)
    ? actions.map((action: PluginBulkAction) => ({
        ...action,
        type: "action" as const,
        showLabel: true,
        tooltip: false as const,
      }))
    : [];
  const Toolbar = pluginKitLayoutCore.OverflowToolbar;
  const word = nounFor(noun, selected, "item");
  return (
    <div
      {...pickRootProps(rest)}
      role="group"
      aria-label={nonEmpty(ariaLabel) ?? "Bulk actions"}
      data-bulk-action-bar=""
      onFocus={(event) => {
        holdsFocus.current = true;
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) {
          cameFrom.current = from;
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) holdsFocus.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && clear) {
          event.preventDefault();
          clear();
        }
      }}
      className={cn(
        "flex h-9 min-w-0 shrink-0 items-center gap-2 border-t border-divider bg-surface pr-1.5 pl-3",
        str(className)
      )}
    >
      <span className="min-w-0 shrink truncate text-xs text-text-secondary tabular-nums">
        <span className="font-medium text-text-primary">{selected}</span> {word} selected
        {hidden > 0 ? ` · ${hidden} not shown` : ""}
      </span>
      {items.length > 0 ? (
        <Toolbar
          items={items}
          aria-label="Selection actions"
          className="min-w-0 flex-1 justify-end"
        />
      ) : (
        <span className="flex-1" />
      )}
      {clear ? (
        <DismissButton
          aria-label="Clear selection"
          tooltip="Clear selection"
          onClick={() => clear()}
        />
      ) : null}
    </div>
  );
}

export function KitLoadMoreFooter({
  status,
  onLoadMore,
  loadedCount,
  totalCount,
  noun,
  error,
  autoLoad,
  label,
  className,
  ...rest
}: PluginLoadMoreFooterProps) {
  const state = oneOf(status, ["idle", "loading", "error", "done"] as const) ?? "idle";
  const load = fn(onLoadMore);
  const loaded = wholeCount(loadedCount);
  const total = wholeCount(totalCount);
  const auto = autoLoad === true;
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  const focusWasInside = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  });

  // A fresh observer each time the footer goes back to idle reports whether
  // it is still in view, so a page too short to push it out loads the next.
  useEffect(() => {
    const el = rootRef.current;
    if (!auto || state !== "idle" || !el || typeof IntersectionObserver === "undefined") return;
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired || !loadRef.current || !entries.some((entry) => entry.isIntersecting)) return;
        fired = true;
        loadRef.current?.();
      },
      { rootMargin: "0px 0px 160px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [auto, state]);

  // The button that had focus goes away when the list runs out or fails:
  // keep focus in the footer (on Retry, or the footer itself).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !focusWasInside.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && el.contains(active)) return;
    focusWasInside.current = false;
    const retry = el.querySelector<HTMLElement>("button");
    (retry ?? el).focus({ preventScroll: true });
  }, [state]);

  const word = (count: number) => nounFor(noun, count, "item");
  const progress =
    loaded !== undefined && total !== undefined && total > 0
      ? `${loaded.toLocaleString()} of ${total.toLocaleString()}`
      : undefined;
  let body: ReactNode;
  let spoken: string;
  if (state === "done") {
    const all = total ?? loaded;
    spoken =
      all !== undefined && all > 0
        ? `All ${all.toLocaleString()} ${word(all)} loaded`
        : "All loaded";
    body = <span>{spoken}</span>;
  } else if (state === "error") {
    const message = hasContent(error) ? node(error) : "Couldn't load more";
    spoken = typeof message === "string" ? message : "Couldn't load more";
    body = (
      <>
        <ErrorGlyph aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-status-error" />
        <span className="min-w-0 truncate">{message}</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={!load}
          onClick={() => load?.()}
          className="shrink-0"
        >
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </>
    );
  } else {
    spoken = state === "loading" ? "Loading more" : "";
    body = (
      <>
        <Button
          variant="ghost"
          size="xs"
          loading={state === "loading"}
          disabled={!load}
          onClick={() => load?.()}
        >
          {nonEmpty(label) ?? "Load more"}
        </Button>
        {progress ? <span className="tabular-nums">{progress}</span> : null}
      </>
    );
  }
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      tabIndex={-1}
      aria-busy={state === "loading" || undefined}
      data-load-more={state}
      onFocus={() => {
        focusWasInside.current = true;
      }}
      onBlur={(event) => {
        // A button that unmounts under focus blurs to nowhere; only focus
        // that moved somewhere else has left the footer.
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) focusWasInside.current = false;
      }}
      className={cn(
        "flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-1.5 text-xs text-text-secondary",
        PROGRAMMATIC_FOCUS_RING,
        str(className)
      )}
    >
      {body}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </div>
  );
}
