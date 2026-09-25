import type { ReactNode } from "react";
import { ProjectResourceBadge } from "@/components/Project";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";

/**
 * The sidebar's footer row: one ambient readout of what Daintree is doing.
 *
 * The keep-awake hold used to ride here as its own coffee-cup button beside the
 * readout — a permanent unlabelled glyph whose meaning is not recoverable
 * without having met the Caffeine app. Its detail and its settings route moved
 * into the readout's popover, which is where the rest of the footer's
 * explanation already lives.
 *
 * The hold does NOT drive the working mark, though it was the obvious
 * candidate: main raises the blocker while agents work, so it looked like a
 * ready-made answer. `PowerSaveBlockerService.isAllowedByPolicy` is
 * `enabled && (!onBatteryPower || config.onBattery)` with `onBattery` defaulting
 * to false, so an unplugged laptop releases the hold while agents keep working —
 * the mark would have read idle through a whole session on battery. The badge
 * reads agent activity directly instead; the hold is passed only so the popover
 * can explain itself.
 */
export function SidebarStatusBar({ trailing }: { trailing?: ReactNode } = {}) {
  const holdingWakeLock = useKeepAwakeStore((state) => state.visible);

  return <ProjectResourceBadge holdingWakeLock={holdingWakeLock} trailing={trailing} />;
}
