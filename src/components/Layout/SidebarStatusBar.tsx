import { ProjectResourceBadge } from "@/components/Project";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";

/**
 * The sidebar's footer row: one ambient readout of what Daintree is doing.
 *
 * The keep-awake hold used to ride here as its own coffee-cup button beside the
 * readout. It is the same fact the readout's mark now carries — main raises the
 * power-save blocker precisely while agents are working — so expressing it twice
 * cost a permanent unlabelled glyph to say what a filled dot says for free. The
 * detail and its settings route moved into the readout's popover, which is where
 * the rest of the footer's explanation already lives.
 *
 * `working` is the hold itself rather than a re-derivation of it: `isBlocking`
 * is main's own answer to "is there work in flight", already gated through the
 * Doherty rise in `useKeepAwakeSync` so a hold shorter than 400ms never blinks
 * the mark. When the user has turned keep-awake off the hold is always false and
 * says nothing about work, so the badge falls back to process presence.
 */
export function SidebarStatusBar() {
  const holdingWakeLock = useKeepAwakeStore((state) => state.visible);
  const keepAwakeEnabled = useKeepAwakeStore((state) => state.state?.config.enabled ?? true);

  return <ProjectResourceBadge working={keepAwakeEnabled ? holdingWakeLock : null} />;
}
