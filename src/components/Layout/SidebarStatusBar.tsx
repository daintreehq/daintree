import type { ReactNode } from "react";
import { ProjectResourceBadge } from "@/components/Project/ProjectResourceBadge";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { SidebarAgentUsage } from "./SidebarAgentUsage";

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
 *
 * Agent usage sits in its own foldable "Usage" section right above it
 * (#17318): a dense row per agent with a reading, and no section otherwise.
 * Beside the readout in a 200px row it would cut both down to a few
 * characters.
 */
export function SidebarStatusBar({ trailing }: { trailing?: ReactNode } = {}) {
  const holdingWakeLock = useKeepAwakeStore((state) => state.visible);

  return (
    <>
      <SidebarAgentUsage />
      <ProjectResourceBadge holdingWakeLock={holdingWakeLock} trailing={trailing} />
    </>
  );
}
