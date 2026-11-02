import { isLinux, isMac, isWindows } from "@/lib/platform";
import type { ScheduleOsJobContext, ScheduleOsJobKind } from "@shared/utils/scheduleOsJob";

/**
 * The kind of OS job this machine has: main's word once its status has
 * answered, and until then the platform the view runs on, so copy that
 * depends on it doesn't wait for the read.
 */
export function scheduleOsJobKindHere(
  context: ScheduleOsJobContext | null
): ScheduleOsJobKind | null {
  if (context) return context.kind;
  if (isMac()) return "launch-agent";
  if (isWindows()) return "task-scheduler";
  if (isLinux()) return "systemd-timer";
  return null;
}
