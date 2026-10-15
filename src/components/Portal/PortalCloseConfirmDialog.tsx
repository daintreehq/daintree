import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PortalTab } from "@shared/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { KBD_CLASS } from "@/components/ui/Kbd";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TRUNCATION_DISCLOSURE_ATTR } from "@/lib/accessibility";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import {
  usePortalPendingCloseStore,
  type PortalPendingCloseSnapshot,
} from "@/store/portalPendingCloseStore";
import { PortalIcon } from "./PortalIcon";

interface DialogCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

export function buildCopy(pending: PortalPendingCloseSnapshot): DialogCopy {
  const count = pending.tabsToClose.length;
  const willClose = `${pluralize(count, "tab will close", "tabs will close")}.`;
  const confirmLabel = `Close ${pluralize(count, "portal tab")}`;
  // Closing a tab destroys its page, so whatever was typed into it and not yet
  // saved by the site goes with the history.
  switch (pending.kind) {
    case "closeAll":
      return {
        title: "Close all portal tabs?",
        description: `Every portal tab closes, discarding its navigation history and anything unsaved on the page. ${willClose}`,
        confirmLabel,
      };
    case "closeOthers":
      return {
        title: "Close other portal tabs?",
        // The kept tab is the one the user invoked from (right-clicked tab
        // or active tab) — not necessarily the active one — so name neither;
        // the list below shows exactly which tabs close.
        description: `Every other portal tab closes, discarding its navigation history and anything unsaved on the page. ${willClose}`,
        confirmLabel,
      };
    case "closeToRight":
      return {
        title: "Close tabs to the right?",
        description: `Every portal tab to the right closes, discarding its navigation history and anything unsaved on the page. ${willClose}`,
        confirmLabel,
      };
  }
}

interface TabAddress {
  /** Subdomains, which give way first when the host itself is too long. */
  hostHead: string;
  /** The registrable-looking tail and port, cut only once the head is gone. */
  hostTail: string;
  /** Path, query and hash. */
  rest: string;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Web addresses lead with the host (port kept: two dev servers differ only
 * there) and drop the scheme and `www.`. Anything else — about:, file:, a
 * value that doesn't parse — returns null and is shown whole, since there the
 * scheme is the identity.
 */
export function splitTabAddress(url: string): TabAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.replace(/^www\./, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  const labels = IPV4_RE.test(hostname) ? [hostname] : hostname.split(".");
  const tailLabels = labels.length > 2 ? labels.slice(-2) : labels;
  const headLabels = labels.slice(0, labels.length - tailLabels.length);
  return {
    hostHead: headLabels.length > 0 ? `${headLabels.join(".")}.` : "",
    hostTail: `${tailLabels.join(".")}${port}`,
    rest: `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}

interface ClosingTabRowProps {
  tab: PortalTab;
  /** Some row in the list is clipped, so the list takes part in keyboard focus. */
  inspectable: boolean;
  isTabStop: boolean;
  /** More than one row, so the arrow keys have somewhere to go. */
  hasSiblings: boolean;
  onClippedChange: (tabId: string, clipped: boolean) => void;
  onFocusRow: (tabId: string) => void;
}

function ClosingTabRow({
  tab,
  inspectable,
  isTabStop,
  hasSiblings,
  onClippedChange,
  onFocusRow,
}: ClosingTabRowProps) {
  const title = tab.title.trim();
  const address = tab.url ? splitTabAddress(tab.url) : null;
  const { ref: titleRef, isTruncated: titleCut } = useTruncationDetection();
  const { ref: headRef, isTruncated: headCut } = useTruncationDetection();
  const { ref: tailRef, isTruncated: tailCut } = useTruncationDetection();
  const { ref: restRef, isTruncated: restCut } = useTruncationDetection();
  const { ref: rawRef, isTruncated: rawCut } = useTruncationDetection();
  const clipped = titleCut || headCut || tailCut || restCut || rawCut;
  const [hasFocus, setHasFocus] = useState(false);

  useEffect(() => {
    onClippedChange(tab.id, clipped);
  }, [onClippedChange, tab.id, clipped]);

  // A blank tab has a store title ("New tab") but nothing on it; that and a
  // page that never set a title both read as placeholders, not page names.
  const isPlaceholder = !title || !tab.url;

  return (
    <TruncatedTooltip
      isTruncated={clipped}
      focusable={false}
      side="top"
      align="start"
      content={
        <span className="flex flex-col gap-0.5">
          <span className="[overflow-wrap:anywhere]">{title || "Untitled"}</span>
          {tab.url && (
            <span className="text-text-secondary [overflow-wrap:anywhere]">{tab.url}</span>
          )}
          {/* Only for the keyboard: the list is one tab stop, and this is where
              it says how to reach the other rows. */}
          {hasFocus && hasSiblings && (
            <span className="mt-1.5 inline-flex items-baseline text-text-secondary">
              <span className="sr-only">Up or Down arrow:</span>
              {/* Sans, as KbdChord sets arrow glyphs: the mono face has none and
                  its fallback draws them at half height. */}
              <kbd aria-hidden="true" className={cn(KBD_CLASS, "font-sans")}>
                ↑
              </kbd>
              <kbd aria-hidden="true" className={cn(KBD_CLASS, "ml-1 font-sans")}>
                ↓
              </kbd>
              <span className="ml-1.5">Move between tabs</span>
            </span>
          )}
        </span>
      }
    >
      <li
        tabIndex={inspectable ? (isTabStop ? 0 : -1) : undefined}
        {...(inspectable ? { [TRUNCATION_DISCLOSURE_ATTR]: "" } : {})}
        onFocus={(event) => {
          // A click focuses the row too; the arrow hint is for the keyboard.
          setHasFocus(event.currentTarget.matches(":focus-visible"));
          onFocusRow(tab.id);
        }}
        onBlur={() => setHasFocus(false)}
        // The end rows take the frame's inner radius so their inset focus
        // outline follows its rounded corners instead of cutting across them.
        className="flex min-w-0 items-start gap-2.5 px-3 py-2 focus-visible:-outline-offset-2 first:rounded-t-[calc(var(--radius-md)-1px)] last:rounded-b-[calc(var(--radius-md)-1px)]"
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-3.5 shrink-0 items-center justify-center text-text-secondary"
        >
          <PortalIcon icon={tab.icon ?? "globe"} size="tab" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            ref={titleRef}
            className={cn(
              "truncate text-sm leading-5",
              isPlaceholder ? "text-text-secondary" : "text-text-primary"
            )}
          >
            {title || "Untitled"}
          </span>
          {tab.url &&
            (address ? (
              <span className="flex min-w-0 text-xs leading-4 text-text-secondary">
                {address.hostHead && (
                  <span ref={headRef} className="min-w-0 truncate font-medium">
                    {address.hostHead}
                  </span>
                )}
                <span ref={tailRef} className="max-w-full shrink-0 truncate font-medium">
                  {address.hostTail}
                </span>
                {address.rest && (
                  <span ref={restRef} className="min-w-0 shrink-[1000] truncate">
                    {address.rest}
                  </span>
                )}
              </span>
            ) : (
              <span ref={rawRef} className="truncate text-xs leading-4 text-text-secondary">
                {tab.url}
              </span>
            ))}
        </span>
      </li>
    </TruncatedTooltip>
  );
}

/**
 * The tabs about to close, title over address. No scroller of its own: a long
 * list grows the dialog body, which already scrolls with edge shadows. When any
 * row is clipped the list becomes one tab stop, and the arrow keys walk the rows
 * so each clipped one can show its full title and URL without a tab stop per row.
 */
function ClosingTabsPreview({ tabs }: { tabs: PortalTab[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [clippedIds, setClippedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);

  const handleClippedChange = useCallback((tabId: string, clipped: boolean) => {
    setClippedIds((prev) => {
      if (prev.has(tabId) === clipped) return prev;
      const next = new Set(prev);
      if (clipped) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const inspectable = clippedIds.size > 0;
  const tabStopId = cursorId ?? tabs.find((tab) => clippedIds.has(tab.id))?.id ?? null;

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLLIElement>(":scope > li") ?? []);
    const current = rows.findIndex((row) => row === document.activeElement);
    if (current === -1) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(current + 1, rows.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(current - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <ul
      ref={listRef}
      aria-label="Tabs that will close"
      onKeyDown={inspectable ? handleKeyDown : undefined}
      className="divide-y divide-divider rounded-[var(--radius-md)] border border-divider bg-surface-canvas/40"
      data-testid="portal-close-preview"
    >
      {tabs.map((tab) => (
        <ClosingTabRow
          key={tab.id}
          tab={tab}
          inspectable={inspectable}
          isTabStop={tab.id === tabStopId}
          hasSiblings={tabs.length > 1}
          onClippedChange={handleClippedChange}
          onFocusRow={setCursorId}
        />
      ))}
    </ul>
  );
}

/**
 * App-level confirm-dialog host for bulk portal-tab closes dispatched at the
 * 3+-tab escalation threshold (from a keybinding, the action palette, or the
 * portal toolbar). Subscribes to `portalPendingCloseStore` and re-dispatches
 * the matching action with `{ confirmed: true }` on confirm. Mounted in
 * `AppLayout` rather than `PortalDock` because the portal panel can be hidden
 * when the action fires.
 */
export function PortalCloseConfirmDialog(): ReactElement | null {
  const pending = usePortalPendingCloseStore((s) => s.pending);
  const clear = usePortalPendingCloseStore((s) => s.clear);

  const handleConfirm = useCallback(() => {
    if (pending === null) return;
    switch (pending.kind) {
      case "closeAll":
        void actionService.dispatch("portal.closeAllTabs", { confirmed: true }, { source: "user" });
        break;
      case "closeOthers":
        // Defensive: without the kept tab the action would fall back to the
        // active tab, which may have changed since the dialog opened.
        if (!pending.keepTabId) break;
        void actionService.dispatch(
          "portal.closeOthers",
          { tabId: pending.keepTabId, confirmed: true },
          { source: "user" }
        );
        break;
      case "closeToRight":
        // Defensive: without the anchor tab the action would fall back to the
        // active tab, which may have changed since the dialog opened.
        if (!pending.keepTabId) break;
        void actionService.dispatch(
          "portal.closeToRight",
          { tabId: pending.keepTabId, confirmed: true },
          { source: "user" }
        );
        break;
    }
    clear();
  }, [pending, clear]);

  if (pending === null) return null;

  const copy = buildCopy(pending);

  return (
    <ConfirmDialog
      isOpen
      onClose={clear}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      variant="destructive"
      // Scrollable list of the tabs being closed — a dialog, not an
      // alertdialog, which APG reserves for a brief message read whole.
      hasPreview={pending.tabsToClose.length > 0}
      // A list body: the 16px edge fade, so the row under it still reads as a
      // row rather than as disabled content.
      compactBodyShadow
      onConfirm={handleConfirm}
    >
      {pending.tabsToClose.length > 0 && <ClosingTabsPreview tabs={pending.tabsToClose} />}
    </ConfirmDialog>
  );
}
