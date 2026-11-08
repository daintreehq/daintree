import type { KeyboardEvent } from "react";
import type { PluginCanopyHostedViewDescriptor } from "@shared/types/plugin";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { radixLayerWasOpenWhenEscapePressed } from "@/lib/dialogEscapeBackstop";
import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";

let kitHostInstalled = false;

/**
 * The kit's host for this window, installed once, before the first plugin view
 * draws: a kit control reads its host as it renders and never re-reads it. It
 * stays for the window's life, as the project window's does.
 */
export function installCanopyPluginKitHost(): void {
  if (kitHostInstalled) return;
  kitHostInstalled = true;
  installAppPluginKitHost();
}

/**
 * A plugin view in Canopy's pane, mounted as the toolbar popover mounts one:
 * the panel's module with no panel record, its state kept for the window.
 *
 * Escape inside the view is the view's: an edit of its own may want it, and
 * it never closes Canopy. One the view leaves alone takes the keyboard back to
 * its row, as Escape from an agent's pane does. A dialog or menu the view
 * opened sits in a portal outside this box, and its Escape passes on to its
 * own handling untouched, though React bubbles it through here.
 */
export function CanopyPluginView({
  view,
  onShowInbox,
  onEscape,
}: {
  view: PluginCanopyHostedViewDescriptor;
  onShowInbox: () => void;
  onEscape: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.stopPropagation();
    if (event.defaultPrevented || radixLayerWasOpenWhenEscapePressed()) return;
    event.preventDefault();
    onEscape();
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-canopy-plugin-view=""
      onKeyDown={onKeyDown}
    >
      <PluginHostedView
        key={view.id}
        source={{ from: "hosted", view }}
        host="canopy"
        mountId={`canopy:${view.id}`}
        onRequestClose={onShowInbox}
        requestCloseLabel="Show inbox"
        className="min-h-0 flex-1"
        testId="canopy-plugin-view"
      />
    </div>
  );
}
