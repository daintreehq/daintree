import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
} from "lucide-react";
import type { PluginDrawerProps, PluginDrawerToggleProps } from "@shared/types/plugin-sdk-react";
import { CountBadge } from "@/components/ui/badge";
import { DismissButton } from "@/components/ui/DismissButton";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { OVERLAY_SHEET_SHADOW_CLASS } from "@/components/ui/floatingSurface";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { cn } from "@/lib/utils";
import { sizedIcon } from "./PluginKitPatterns";
import { useKitOverlayZClass } from "./kitScope";
import {
  PROGRAMMATIC_FOCUS_RING,
  SIDES,
  lastInputWasPointer,
  trackLastInput,
  wholeCount,
  type Side,
} from "./kitPaneShared";
import { fn, hasContent, node, nonEmpty, oneOf, pickRootProps, positive, str } from "./kitProps";

const DRAWER_DEFAULT_PX = 320;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** What Tab can reach inside `root`: not inert, not hidden, not taken out of the order. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el instanceof HTMLInputElement && el.type === "hidden") &&
      !el.closest("[inert],[hidden],[aria-hidden='true']") &&
      // Unrendered (display: none up the tree); absent where the DOM has no layout.
      (typeof el.checkVisibility !== "function" || el.checkVisibility())
  );
}

const DRAWER_EDGE_CLASS: Record<Side, string> = {
  right: "inset-y-0 right-0 border-l",
  left: "inset-y-0 left-0 border-r",
  top: "inset-x-0 top-0 border-b",
  bottom: "inset-x-0 bottom-0 border-t",
};

const DRAWER_HIDDEN_CLASS: Record<Side, string> = {
  right: "translate-x-full",
  left: "-translate-x-full",
  top: "-translate-y-full",
  bottom: "translate-y-full",
};

// A push drawer sits beside the content, on its side of the row or column.
const DRAWER_FLOW_CLASS: Record<Side, string> = {
  right: "flex-row",
  left: "flex-row-reverse",
  top: "flex-col-reverse",
  bottom: "flex-col",
};

export function KitDrawer({
  open,
  onOpenChange,
  children,
  panel,
  title,
  "aria-label": ariaLabel,
  actions,
  footer,
  side,
  mode,
  modal,
  size,
  panelId,
  className,
  ...rest
}: PluginDrawerProps) {
  const baseId = useId();
  const isOpen = open === true;
  const edge = oneOf(side, SIDES) ?? "right";
  const vertical = edge === "top" || edge === "bottom";
  const push = oneOf(mode, ["overlay", "push"] as const) === "push";
  const isModal = !push && modal !== false;
  const px = positive(size, 4096) ?? DRAWER_DEFAULT_PX;
  const id = nonEmpty(panelId) ?? `${baseId}drawer`;
  const titleId = `${baseId}title`;
  const change = fn(onOpenChange);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const pointerClose = useRef(false);
  const openedAtMount = useRef(isOpen);

  useEffect(() => trackLastInput(), []);
  const titleText = str(title);
  const name = nonEmpty(ariaLabel) ?? (titleText ? undefined : "Drawer");

  const close = (byPointer: boolean) => {
    pointerClose.current = byPointer;
    change?.(false);
  };

  // Opening takes focus into the drawer (its first control when modal, else
  // the drawer itself); closing hands it back to what had it, ringless after
  // a pointer close, as the host's overlays do.
  // Read before focus fixup can move focus off an opener the open drawer
  // has just made inert.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    returnTo.current =
      active instanceof HTMLElement && !(panelRef.current?.contains(active) ?? false)
        ? active
        : null;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      openedAtMount.current = false;
      return;
    }
    const panelEl = panelRef.current;
    // A drawer restored open with its view has nothing to answer: focus stays
    // where the view put it until the user opens a drawer themselves.
    const restored = openedAtMount.current;
    openedAtMount.current = false;
    if (!restored && panelEl && !panelEl.contains(document.activeElement)) {
      // The body's first control, not the header's Close: a drawer opens to
      // be used, and Escape already closes it.
      const body = panelEl.querySelector<HTMLElement>("[data-drawer-body]");
      const first = isModal
        ? ((body ? focusablesIn(body)[0] : undefined) ?? focusablesIn(panelEl)[0])
        : undefined;
      // Opened from a click, focus lands without a ring, as the host's
      // overlays do; opened from the keyboard, the ring shows where it went.
      (first ?? panelEl).focus({ preventScroll: true, focusVisible: !lastInputWasPointer() });
    }
    return () => {
      const now = document.activeElement;
      const inside = now === null || now === document.body || (panelEl?.contains(now) ?? false);
      const target = returnTo.current;
      if (inside && target?.isConnected) {
        // The opener's tooltip must not open on focus handed back to it.
        armTooltipFocusSuppression();
        target.focus({ preventScroll: true, focusVisible: !pointerClose.current });
      }
      pointerClose.current = false;
    };
  }, [isOpen, isModal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      return;
    }
    if (event.key !== "Tab" || !isModal) return;
    const items = focusablesIn(event.currentTarget);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const extent: CSSProperties = vertical
    ? { height: px, maxHeight: "90%" }
    : { width: px, maxWidth: "90%" };
  const header = hasContent(title) ? (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider pr-1.5 pl-3">
      <h2
        id={titleId}
        className="m-0 min-w-0 flex-1 truncate text-xs font-medium text-text-primary"
      >
        {node(title)}
      </h2>
      {hasContent(actions) ? (
        <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
      ) : null}
      <DismissButton
        aria-label={titleText ? `Close ${titleText}` : "Close drawer"}
        tooltip="Close"
        onClick={(event) => close(event.detail > 0)}
      />
    </div>
  ) : null;
  const drawer = (
    <div
      ref={panelRef}
      id={id}
      role={isModal ? "dialog" : "complementary"}
      aria-labelledby={name ? undefined : titleId}
      aria-label={name}
      tabIndex={-1}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      data-drawer-panel={edge}
      onKeyDown={handleKeyDown}
      style={extent}
      className={cn(
        "flex min-h-0 min-w-0 flex-col text-text-primary",
        PROGRAMMATIC_FOCUS_RING,
        push
          ? cn(
              "relative shrink-0 border-divider bg-surface-panel",
              { right: "border-l", left: "border-r", top: "border-b", bottom: "border-t" }[edge],
              !isOpen && "hidden"
            )
          : cn(
              "absolute z-20 border-border-default bg-surface-panel-elevated",
              isModal ? OVERLAY_SHEET_SHADOW_CLASS : "shadow-[var(--theme-shadow-floating)]",
              DRAWER_EDGE_CLASS[edge],
              // Visibility rides the slide, so a closing drawer stays painted
              // until it is off the edge and then leaves the tab order.
              "transition-[translate,visibility] ease-out motion-reduce:transition-none",
              isOpen
                ? "visible duration-200"
                : cn("invisible duration-[120ms]", DRAWER_HIDDEN_CLASS[edge])
            )
      )}
    >
      {header}
      <ScrollShadow
        data-drawer-body=""
        className="min-h-0 flex-1"
        scrollClassName="flex min-w-0 flex-col"
      >
        {node(panel)}
      </ScrollShadow>
      {hasContent(footer) ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-divider px-3 py-2">
          {node(footer)}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      {...pickRootProps(rest)}
      data-drawer-mode={push ? "push" : "overlay"}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden",
        push ? DRAWER_FLOW_CLASS[edge] : "flex-col",
        str(className)
      )}
    >
      <div
        data-drawer-content=""
        inert={isModal && isOpen}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {node(children)}
      </div>
      {isModal ? (
        <div
          aria-hidden="true"
          data-drawer-scrim=""
          onMouseDown={(event) => {
            if (event.button === 0) close(true);
          }}
          className={cn(
            // The host's modal scrim, as its dialogs and in-pane webview dialog use.
            "absolute inset-0 z-10 bg-scrim-medium transition-opacity ease-out motion-reduce:transition-none",
            isOpen ? "opacity-100 duration-200" : "pointer-events-none opacity-0 duration-[120ms]"
          )}
        />
      ) : null}
      {drawer}
    </div>
  );
}

const DRAWER_GLYPHS = {
  right: [PanelRightOpen, PanelRightClose],
  left: [PanelLeftOpen, PanelLeftClose],
  top: [PanelTopOpen, PanelTopClose],
  bottom: [PanelBottomOpen, PanelBottomClose],
} as const;

// The name is the drawer, not the next action, so it holds still while the
// state travels on `aria-expanded`.
export function KitDrawerToggle({
  open,
  onOpenChange,
  label,
  controls,
  icon,
  side,
  showLabel,
  badge,
  disabled,
  className,
  ...rest
}: PluginDrawerToggleProps) {
  const overlayZ = useKitOverlayZClass();
  const isOpen = open === true;
  const change = fn(onOpenChange);
  const name = str(label) ?? "";
  const count = wholeCount(badge);
  const [OpenGlyph, CloseGlyph] = DRAWER_GLYPHS[oneOf(side, SIDES) ?? "right"];
  const Glyph = isOpen ? CloseGlyph : OpenGlyph;
  const glyph =
    icon !== undefined ? (
      sizedIcon(icon, PANE_TOOLBAR_ICON_CLASS)
    ) : (
      <Glyph aria-hidden="true" className={PANE_TOOLBAR_ICON_CLASS} />
    );
  const withLabel = showLabel === true;
  const badgeNode =
    count !== undefined && count > 0 ? <CountBadge aria-hidden="true">{count}</CountBadge> : null;
  const button = (
    <button
      {...pickRootProps(rest)}
      type="button"
      aria-label={withLabel ? undefined : count ? `${name} (${count})` : name}
      aria-expanded={isOpen}
      aria-controls={nonEmpty(controls)}
      disabled={disabled === true}
      onClick={() => change?.(!isOpen)}
      className={cn(
        withLabel ? PANE_TOOLBAR_TEXT_BUTTON_CLASS : PANE_TOOLBAR_ICON_BUTTON_CLASS,
        !withLabel && badgeNode && "gap-1 pr-1",
        str(className)
      )}
    >
      {glyph}
      {withLabel ? <span>{name}</span> : null}
      {badgeNode}
    </button>
  );
  if (withLabel || name === "") return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {name}
      </TooltipContent>
    </Tooltip>
  );
}
