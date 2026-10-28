import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentType,
} from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";
import { OPEN_SIDEBAR_VIEW_SWITCHER_EVENT } from "@/lib/sidebarViews";
import { SidebarViewSwitcherContext, type SidebarViewSwitcherModel } from "./sidebarViewContext";

/**
 * The trigger of whichever switcher is mounted. Only one ever is: a header
 * draws the switcher only while its own view shows, and the hidden one's falls
 * back to a plain heading.
 */
let mountedTrigger: HTMLButtonElement | null = null;

/**
 * A focus hand-off owed across a layer change. Picking a view in the other
 * layer retires the trigger the menu would hand focus back to — it goes inert
 * with the worktree list, or unmounts with the plugin view — so the switcher
 * that takes its place has to be focused instead, ringed only if the pick
 * came from the keyboard.
 */
let pendingHandOff: { focusVisible?: boolean } | null = null;

export function requestSidebarViewFocusHandOff(handOff: { focusVisible?: boolean } = {}): void {
  pendingHandOff = handOff;
}

export function takeSidebarViewFocusHandOff(): { focusVisible?: boolean } | null {
  const handOff = pendingHandOff;
  pendingHandOff = null;
  return handOff;
}

export function getMountedSidebarViewTrigger(): HTMLButtonElement | null {
  return mountedTrigger?.isConnected ? mountedTrigger : null;
}

/** Test-only: forget the mounted trigger and any owed hand-off. */
export function _resetSidebarViewSwitcherForTest(): void {
  mountedTrigger = null;
  pendingHandOff = null;
}

function setMountedTrigger(node: HTMLButtonElement | null): void {
  // Attach and detach can land in either order across a layer change; only a
  // node that has left the document gives the slot up.
  if (node !== null) mountedTrigger = node;
  else if (mountedTrigger !== null && !mountedTrigger.isConnected) mountedTrigger = null;
}

/**
 * A sidebar header's title. With no plugin sidebar view on offer it is the
 * plain heading it always was; with one, the heading holds the switcher
 * between views — but only in the header of the view that shows, so exactly
 * one switcher is ever mounted.
 */
export function SidebarViewHeading({
  viewId = WORKTREES_SIDEBAR_VIEW_ID,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"h2">, "children"> & {
  /** The view this header belongs to; the built-in one unless it is a plugin's header. */
  viewId?: string;
  /** The view's name: the heading's text, and the switcher's while there is one. */
  children: string;
}) {
  const model = useContext(SidebarViewSwitcherContext);
  if (model === null || model.options.length < 2 || model.activeId !== viewId) {
    return (
      <h2 className={className} {...props}>
        {children}
      </h2>
    );
  }
  return (
    // Not clipped: the trigger's hover fill and focus ring reach past the text
    // into the header row's padding. Free to shrink, even where the plain
    // heading may not: at the sidebar's minimum width the trigger's chevron and
    // padding must give way to the actions beside it, and the trigger
    // truncates the name itself.
    <h2 className={cn(className, "flex min-w-0 shrink overflow-visible")} {...props}>
      <SidebarViewSwitcher model={model} title={children} />
    </h2>
  );
}

function SidebarViewSwitcher({ model, title }: { model: SidebarViewSwitcherModel; title: string }) {
  const [open, setOpen] = useState(false);
  // Whether the pick about to land came from a pointer, so a hand-off to the
  // other layer's switcher rings it only for the keyboard.
  const pointerPickRef = useRef(false);
  const { options, activeId, builtIn, choose } = model;

  useEffect(() => {
    const openSwitcher = () => setOpen(true);
    window.addEventListener(OPEN_SIDEBAR_VIEW_SWITCHER_EVENT, openSwitcher);
    return () => window.removeEventListener(OPEN_SIDEBAR_VIEW_SWITCHER_EVENT, openSwitcher);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) pointerPickRef.current = false;
    setOpen(next);
  }, []);

  const handleValueChange = useCallback(
    (viewId: string) => {
      // The shown view may be the default rather than a pick; choosing it is
      // what makes it the user's own.
      if (viewId === activeId) {
        choose(viewId);
        return;
      }
      const activeIsBuiltIn = activeId === WORKTREES_SIDEBAR_VIEW_ID;
      const nextIsBuiltIn = viewId === WORKTREES_SIDEBAR_VIEW_ID;
      if (activeIsBuiltIn || nextIsBuiltIn) {
        requestSidebarViewFocusHandOff({ focusVisible: !pointerPickRef.current });
      }
      choose(viewId);
    },
    [activeId, choose]
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={setMountedTrigger}
          variant="ghost"
          aria-label={`${title}, sidebar view`}
          data-testid="sidebar-view-switcher"
          className={cn(
            // The heading's own type, so the title reads the same as the plain
            // heading it replaces; inset by its padding so the text stays put.
            "-ml-1.5 h-6 min-w-0 max-w-full gap-1 px-1.5 text-sm font-semibold tracking-wide text-text-primary hover:text-text-primary",
            "[&_svg]:size-3.5"
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDown aria-hidden="true" className="text-text-secondary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-w-[min(18rem,calc(100vw-2rem))]"
        onPointerDown={() => {
          pointerPickRef.current = true;
        }}
        // Capture, not bubble: Radix selects an item from its own keydown, so a
        // bubbling handler would learn about the keyboard only after the pick.
        onKeyDownCapture={() => {
          pointerPickRef.current = false;
        }}
      >
        <DropdownMenuRadioGroup
          aria-label="Sidebar views"
          value={activeId}
          onValueChange={handleValueChange}
        >
          {options.map((option) =>
            option.view === null ? (
              <BuiltInViewItem key={option.id} title={builtIn.title} icon={builtIn.icon} />
            ) : (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                aria-label={`${option.view.title}, from ${option.view.pluginName}`}
                data-testid={`sidebar-view-option-${option.id}`}
              >
                <SidebarViewOptionLabel
                  icon={resolvePluginIcon(option.view.iconId)}
                  title={option.view.title}
                  detail={option.view.pluginName}
                />
              </DropdownMenuRadioItem>
            )
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The built-in entry, with the count of agents waiting on the user, so a
 * plugin view never hides an agent that is asking for something. Mounted only
 * while the menu is open, so the count costs nothing the rest of the time.
 */
function BuiltInViewItem({
  title,
  icon,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
}) {
  const { waitingCount } = useTerminalNotificationCounts();
  return (
    <DropdownMenuRadioItem
      value={WORKTREES_SIDEBAR_VIEW_ID}
      aria-label={
        waitingCount > 0
          ? `${title}, ${pluralize(waitingCount, "agent is", "agents are")} waiting`
          : title
      }
      data-testid={`sidebar-view-option-${WORKTREES_SIDEBAR_VIEW_ID}`}
    >
      <SidebarViewOptionLabel icon={icon} title={title} />
      {waitingCount > 0 && <DropdownMenuMeta>{`${waitingCount} waiting`}</DropdownMenuMeta>}
    </DropdownMenuRadioItem>
  );
}

function SidebarViewOptionLabel({
  icon: Icon,
  title,
  detail,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="flex shrink-0">
        <Icon className="h-3.5 w-3.5 text-text-secondary" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {detail !== undefined && (
          <span className="truncate text-2xs text-text-secondary">{detail}</span>
        )}
      </span>
    </span>
  );
}
