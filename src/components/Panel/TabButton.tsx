import React, {
  useCallback,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  forwardRef,
} from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { m, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import type { PanelKind, AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DocumentTabClose,
  DocumentTabIndicator,
  documentTabClassName,
} from "@/components/ui/document-tab";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { DURATION_100 } from "@/lib/animationUtils";

export interface TabInfo {
  id: string;
  /** Display title for the tab slot — already variant-resolved by the mapping site (compact task-first in grid strips, identity in dock). */
  title: string;
  /** Full composed title ("Claude: fix auth tests") for the hover tooltip when it differs from the compact slot text. */
  fullTitle?: string;
  chrome: TerminalChromeDescriptor;
  kind: PanelKind;
  agentState?: AgentState;
  /** The agent the terminal was launched with; survives exit, unlike `chrome.isAgent`. */
  launchAgentId?: string;
  isActive: boolean;
  presetColor?: string;
  isUsingFallback?: boolean;
  fallbackTooltip?: string;
  hasDangerousFlags?: boolean;
}

export interface TabButtonProps {
  id: string;
  title: string;
  fullTitle?: string;
  chrome: TerminalChromeDescriptor;
  kind: PanelKind;
  agentState?: AgentState;
  isActive: boolean;
  presetColor?: string;
  onClick: () => void;
  onClose: () => void;
  sortableListeners?: DraggableSyntheticListeners;
  sortableAttributes?: DraggableAttributes;
  onRename?: (newTitle: string) => void;
  isUsingFallback?: boolean;
  fallbackTooltip?: string;
  hasDangerousFlags?: boolean;
  /** The id of the region this tab switches — `aria-controls`, per the APG tabs pattern. */
  tabPanelId?: string;
  /**
   * The overflow observer could not fit this tab. It stays in layout so the
   * observer keeps measuring it, but it is not painted — a clipped fragment at
   * the strip's edge reads as a stray glyph. Never true for the active tab.
   */
  parked?: boolean;
}

/** The DOM id a tab carries, so the panel it controls can name it back. */
export function tabDomId(tabId: string): string {
  return `panel-tab-${tabId}`;
}

const TabButtonComponent = forwardRef<HTMLDivElement, TabButtonProps>(function TabButtonComponent(
  {
    id,
    title,
    fullTitle,
    chrome,
    kind,
    agentState,
    isActive,
    presetColor,
    onClick,
    onClose,
    sortableListeners,
    sortableAttributes,
    onRename,
    isUsingFallback,
    fallbackTooltip,
    hasDangerousFlags,
    tabPanelId,
    parked = false,
  },
  ref
) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  // Where the rename field sits: over the label's own box. The field is a
  // sibling of the tab rather than inside it — a focusable input inside
  // `role="tab"` is the nesting ARIA forbids — so it is positioned onto the
  // label's slot instead of replacing it.
  const [editBox, setEditBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!isEditing || !label) {
      setEditBox(null);
      return;
    }
    setEditBox({
      left: label.offsetLeft,
      top: label.offsetTop,
      width: label.offsetWidth,
      height: label.offsetHeight,
    });
  }, [isEditing]);
  const didCommitOrCancelRef = useRef(false);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && editBox && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing, editBox]);

  // Sync edit value when title changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title);
    }
  }, [title, isEditing]);

  // Listen for rename events from context menu
  useEffect(() => {
    if (!onRename) return;

    const handleRenameEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        setEditValue(title);
        setIsEditing(true);
        didCommitOrCancelRef.current = false;
      }
    };

    const controller = new AbortController();
    window.addEventListener("daintree:rename-terminal", handleRenameEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, title, onRename]);

  // For sortable tabs, merge attributes but filter out conflicting role/tabIndex
  const mergedAttributes = sortableAttributes
    ? Object.fromEntries(
        Object.entries(sortableAttributes).filter(([key]) => key !== "role" && key !== "tabIndex")
      )
    : {};

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onRename) {
        setEditValue(title);
        setIsEditing(true);
        didCommitOrCancelRef.current = false;
      }
    },
    [onRename, title]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      // Enter and Escape unmount the field; hand focus back to its tab so a
      // keyboard rename ends where it started rather than on the body.
      const tab = e.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"]');
      const returnFocus = () => requestAnimationFrame(() => tab?.focus());
      if (e.key === "Enter") {
        // Don't intercept Enter while an IME composition is being committed.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        const trimmed = editValue.trim();
        if (trimmed !== title) {
          // Empty commit is an explicit reset to the identity-derived default.
          onRename?.(trimmed);
        }
        didCommitOrCancelRef.current = true;
        setIsEditing(false);
        returnFocus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditValue(title);
        didCommitOrCancelRef.current = true;
        setIsEditing(false);
        returnFocus();
      }
    },
    [editValue, title, onRename]
  );

  const handleInputBlur = useCallback(() => {
    // Only commit on blur if Enter/Escape didn't already handle it. Blur with
    // an empty value cancels (intent is ambiguous) — only Enter resets.
    if (!didCommitOrCancelRef.current) {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== title) {
        onRename?.(trimmed);
      }
    }
    setIsEditing(false);
  }, [editValue, title, onRename]);

  const handleInputClick = useCallback((e: React.MouseEvent) => {
    // Prevent click from bubbling to tab click handler
    e.stopPropagation();
  }, []);

  const handleInputDoubleClick = useCallback((e: React.MouseEvent) => {
    // Prevent double-click from bubbling to header and triggering maximize
    e.stopPropagation();
  }, []);

  const handleInputPointerDown = useCallback((e: React.PointerEvent) => {
    // Prevent drag handle from capturing input interactions
    e.stopPropagation();
  }, []);

  // The tab-reorder DndContext uses a raw TouchSensor, which activates on
  // touchstart and deliberately ignores the tab strip's [data-no-dnd]. Without
  // this, a long-press to select text in the rename field starts a tab drag —
  // the touch twin of the panel-header bug.
  const handleInputTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
  }, []);

  // Handle main click - enter edit mode if not already editing, or trigger standard click
  const handleClick = useCallback(() => {
    if (isEditing) return;
    onClick();
  }, [isEditing, onClick]);

  // dnd-kit's KeyboardSensor activator arrives via sortableListeners.onKeyDown
  // and would otherwise clobber tab activation (both want Space/Enter). Split
  // it out and compose: Space/Enter on an inactive tab activates it (APG
  // manual activation); on the already-active tab they fall through to the
  // sensor so the focused tab can be picked up and reordered without a mouse.
  const { onKeyDown: sortableKeyDownListener, ...sortablePointerListeners } =
    sortableListeners ?? {};
  const sortableKeyDown = sortableKeyDownListener as ((e: React.KeyboardEvent) => void) | undefined;
  const sortablePointerDown = sortablePointerListeners.onPointerDown as
    ((e: React.PointerEvent) => void) | undefined;

  // Composes the guard with dnd-kit's sortable activator. Spreading
  // `sortablePointerListeners` would clobber a plain onPointerDown prop, so the
  // tab div renders this AFTER the spread to win the prop race: stopPropagation
  // keeps the pointerdown from leaking to ancestors, then we hand off to the
  // sortable sensor so tab reorder still picks up. (The outer panel-move drag is
  // already blocked by [data-no-dnd] on the tab strip, which gates its
  // mousedown-based sensor; this guards the pointer path too.)
  const handleTabPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      sortablePointerDown?.(e);
    },
    [sortablePointerDown]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        if (isActive && sortableKeyDown) {
          sortableKeyDown(e);
          return;
        }
        e.preventDefault();
        onClick();
      }
    },
    [isActive, onClick, sortableKeyDown]
  );

  const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;

  return (
    <div className="relative flex">
      <Tooltip autoDismiss={false}>
        <TooltipTrigger asChild>
          <div
            ref={ref}
            id={tabDomId(id)}
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId}
            aria-keyshortcuts="Delete"
            data-document-tab=""
            data-tab-parked={parked || undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            className={cn(documentTabClassName(isActive), "px-2 py-1", parked && "invisible")}
            data-tab-id={id}
            {...mergedAttributes}
            {...sortablePointerListeners}
            onPointerDown={handleTabPointerDown}
          >
            {isActive && <DocumentTabIndicator />}
            <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5">
              <TerminalIcon
                kind={kind}
                chrome={chrome}
                className="w-3.5 h-3.5"
                brandColor={presetColor ?? chrome.color}
              />
            </span>

            <span
              ref={labelRef}
              className={cn(
                "truncate max-w-[100px] inline-block border border-transparent px-1",
                onRename && "cursor-text",
                // Holds the label's slot while the rename field sits over it.
                isEditing && "invisible min-w-[60px]"
              )}
              onDoubleClick={handleDoubleClick}
            >
              {title}
            </span>

            {/* Visually-hidden state text so the agent state icon (aria-hidden, decorative)
              is announced as part of the tab's accessible name. */}
            {displayAgentState && (
              <span className="sr-only">Agent {getEffectiveStateLabel(displayAgentState)}</span>
            )}

            {document.body.dataset.performanceMode === "true" ? (
              displayAgentState &&
              StateIcon && (
                <StateIcon
                  className={cn(
                    "w-3 h-3 shrink-0",
                    getEffectiveStateColor(displayAgentState),
                    displayAgentState === "working" && "animate-spin-slow",
                    "motion-reduce:animate-none"
                  )}
                  aria-hidden="true"
                />
              )
            ) : (
              <AnimatePresence initial={false} mode="wait">
                {displayAgentState && StateIcon && (
                  <m.span
                    key={displayAgentState}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ duration: DURATION_100 / 1000, ease: [0.16, 1, 0.3, 1] }}
                    className="inline-flex shrink-0"
                  >
                    <StateIcon
                      className={cn(
                        "w-3 h-3",
                        getEffectiveStateColor(displayAgentState),
                        displayAgentState === "working" && "animate-spin-slow",
                        "motion-reduce:animate-none"
                      )}
                      aria-hidden="true"
                    />
                  </m.span>
                )}
              </AnimatePresence>
            )}

            {isUsingFallback && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle
                    className="w-3 h-3 shrink-0 text-status-warning"
                    aria-label="Running on fallback preset"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {fallbackTooltip ?? "Running on fallback preset — original provider unavailable"}
                </TooltipContent>
              </Tooltip>
            )}

            {hasDangerousFlags && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="status-mark w-2 h-2 rounded-full bg-status-danger shrink-0"
                    aria-label="Launched with dangerous permissions"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Launched with dangerous permissions — agent can modify files without prompting
                </TooltipContent>
              </Tooltip>
            )}

            {/* A 24px target on a 24px tab: -my-1 lets it span the tab's height and
              -mr-1.5 gives most of its width back. */}
            <DocumentTabClose
              title={title}
              isActive={isActive}
              onClose={onClose}
              className="-my-1 -mr-1.5"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {onRename ? `${fullTitle ?? title} — Double-click to rename` : (fullTitle ?? title)}
        </TooltipContent>
      </Tooltip>
      {isEditing && editBox && (
        <m.input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          onClick={handleInputClick}
          onDoubleClick={handleInputDoubleClick}
          onPointerDown={handleInputPointerDown}
          onTouchStart={handleInputTouchStart}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.1 }}
          style={editBox}
          className="absolute text-xs font-medium bg-overlay-soft border border-transparent px-1 text-text-primary select-text focus:outline-hidden"
          aria-label={`Rename tab ${title}`}
        />
      )}
    </div>
  );
});

export const TabButton = TabButtonComponent;
