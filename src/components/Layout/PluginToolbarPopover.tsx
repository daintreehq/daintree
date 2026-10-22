import { useCallback, useState, type ReactNode } from "react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { PaneState } from "@/components/ui/PaneState";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { usePanelKindRegistry } from "@/hooks/useRenderableSurfaceClaim";
import {
  usePluginToolbarPopoverStore,
  type PluginToolbarPopoverOpening,
  type PluginToolbarPopoverOrigin,
} from "@/store/pluginToolbarPopoverStore";
import type {
  ToolbarButtonConfig,
  ToolbarButtonPopoverConfig,
} from "@shared/config/toolbarButtonRegistry";
import { keepOpenBehindAppDialog, yieldEscapeToFocusedDialog } from "./dockPopoverGuard";

type PopoverButtonConfig = ToolbarButtonConfig & { popover: ToolbarButtonPopoverConfig };

/** Marks the popover's content, so a close can tell whether focus was inside it. */
const POPOVER_CONTENT_ATTR = "data-plugin-toolbar-popover";

/**
 * Close the open plugin popover if the toolbar control it hangs off is about to
 * be hidden — moved into overflow, or the `…` button emptied. Its portalled
 * content would otherwise stay on screen, pinned to a control nobody can see.
 *
 * The hidden control can't take focus back either, so when focus was inside
 * the popover it goes to `successor` — wherever the command lives now —
 * instead of falling to `document.body`.
 */
export function closePluginToolbarPopoverIfHidden(
  isHidden: (opening: PluginToolbarPopoverOpening) => boolean,
  successor: (opening: PluginToolbarPopoverOpening) => HTMLElement | null
): void {
  const { opening, close } = usePluginToolbarPopoverStore.getState();
  if (opening === null || !isHidden(opening)) return;
  const active = document.activeElement;
  const focusInside =
    active instanceof Element && active.closest(`[${POPOVER_CONTENT_ATTR}]`) !== null;
  close(opening.seq, focusInside ? successor(opening) : null);
}

function isPopoverButton(config: ToolbarButtonConfig | undefined): config is PopoverButtonConfig {
  return config?.popover !== undefined;
}

/**
 * The anchored popover a plugin toolbar button opens (#13784), hung off one
 * toolbar control. The host draws the shell — size, focus return, the
 * dialog-aware dismissal — and the plugin draws only the view inside it.
 *
 * `children` holds the control: a `PopoverTrigger` around a promoted button,
 * or a `PopoverAnchor restoreFocus` around the tray's or overflow menu's own
 * trigger, which is where a popover picked from one of their rows hangs.
 *
 * Every instance reads the one opening in `usePluginToolbarPopoverStore` and
 * draws it only when it names this origin (and, for a promoted button, this
 * button), so at most one plugin popover is ever open.
 */
export function PluginToolbarPopover({
  origin,
  buttonId,
  configs,
  children,
}: {
  origin: PluginToolbarPopoverOrigin;
  /** A promoted button's own id; a menu's popover opens whichever row was picked. */
  buttonId?: string;
  configs: ReadonlyMap<string, ToolbarButtonConfig>;
  children: ReactNode;
}) {
  const opening = usePluginToolbarPopoverStore((s) => s.opening);
  const openPopover = usePluginToolbarPopoverStore((s) => s.open);
  const closePopover = usePluginToolbarPopoverStore((s) => s.close);
  const mine =
    opening !== null &&
    opening.origin === origin &&
    (buttonId === undefined || opening.buttonId === buttonId)
      ? opening
      : null;
  const isOpen = mine !== null && isPopoverButton(configs.get(mine.buttonId));

  // The last opening shown, kept through the close so the content can play its
  // exit instead of vanishing the moment the store lets go.
  const [shown, setShown] = useState<PluginToolbarPopoverOpening | null>(null);
  if (isOpen && mine !== shown) setShown(mine);
  const shownConfig = shown !== null ? configs.get(shown.buttonId) : undefined;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      if (buttonId !== undefined) openPopover(buttonId, origin);
      return;
    }
    if (mine !== null) closePopover(mine.seq);
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      {children}
      <PopoverContent
        align="end"
        aria-label={shownConfig?.label}
        data-testid="plugin-toolbar-popover"
        {...{ [POPOVER_CONTENT_ATTR]: "" }}
        // The forge dropdowns' box, so a plugin's inbox sits beside the
        // built-in ones at the same size; clamped to the room the anchor has.
        className="flex h-[min(500px,var(--radix-popover-content-available-height))] w-[min(450px,var(--radix-popover-content-available-width))] flex-col p-0"
        onInteractOutside={keepOpenBehindAppDialog}
        onEscapeKeyDown={yieldEscapeToFocusedDialog}
        onCloseAutoFocus={(event) => {
          const { opening, takeCloseFocusTarget } = usePluginToolbarPopoverStore.getState();
          const successor = takeCloseFocusTarget();
          // Replaced by another button's popover, which holds focus now.
          // Handing it back to this one's control would read there as focus
          // leaving, and close that one too.
          if (opening !== null) {
            event.preventDefault();
            return;
          }
          // Closed because its control is being hidden; see
          // `closePluginToolbarPopoverIfHidden`.
          if (successor?.isConnected) {
            event.preventDefault();
            successor.focus({ preventScroll: true });
          }
        }}
      >
        {shown !== null && isPopoverButton(shownConfig) && (
          <PluginToolbarPopoverView
            key={shown.seq}
            config={shownConfig}
            seq={shown.seq}
            onClose={closePopover}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The button's view, mounted through the shared hosted-view path as
 * `hostContext.kind: "popover"`. Keyed by the opening, so every opening is a
 * fresh mount — a popover is transient, and its view keeps no state across one.
 *
 * Only a kind the button's own plugin registered, with a module to load: the
 * id came from main, but a remote host's button must not be able to point the
 * popover at another plugin's view.
 */
function PluginToolbarPopoverView({
  config,
  seq,
  onClose,
}: {
  config: PopoverButtonConfig;
  seq: number;
  onClose: (seq?: number) => void;
}) {
  const registry = usePanelKindRegistry();
  const close = useCallback(() => onClose(seq), [onClose, seq]);
  const kind = registry[config.popover.panelKindId];
  if (
    kind === undefined ||
    kind.extensionId !== config.pluginId ||
    kind.componentPath === undefined ||
    kind.hasPty === true
  ) {
    return (
      <PaneState
        title={`${config.label} isn't available`}
        description="Its plugin hasn't loaded this view."
        className="bg-transparent"
      />
    );
  }
  return (
    <PluginHostedView
      source={{ from: "panel-kind", config: kind }}
      host="popover"
      mountId={`toolbar-popover:${config.id}`}
      onClose={close}
      className="min-h-0 flex-1"
    />
  );
}
