import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useProjectStore } from "@/store/projectStore";

/**
 * One grid-bar notice for every terminal in this project view whose stall
 * outlived automatic recovery (#16498). Terminals that escalate while the
 * notice is up update its count in place rather than posting their own, and a
 * dismissed notice stays dismissed until every terminal has recovered: the
 * next stall after that is a new incident and posts again.
 *
 * Module state is per project view, since each view has its own V8 context.
 */
const escalated = new Set<string>();
let noticeId: string | null = null;
// The incident's inbox key, fixed when it starts. Project-scoped because the
// inbox is shared across windows, and another project's incident must not
// archive this one's row.
let noticeKey: string | null = null;

function noticeMessage(count: number): string {
  return count === 1
    ? "An automatic refresh didn't clear it. Use Retry in the terminal."
    : `It affects ${pluralize(count, "terminal")}, and an automatic refresh didn't clear it. Use Retry in each one.`;
}

function liveNotice(id: string) {
  return useNotificationStore.getState().notifications.find((n) => n.id === id && !n.dismissed);
}

function updateNoticeCount(): void {
  const message = noticeMessage(escalated.size);
  // No live row means the user dismissed it, and this incident doesn't post again.
  if (noticeId !== null && liveNotice(noticeId)) {
    useNotificationStore.getState().updateNotification(noticeId, { message });
  }
  // The inbox row outlives a dismissed bar, and exists even when quiet hours
  // kept the bar from showing at all.
  const history = useNotificationHistoryStore.getState();
  const entry = history.entries.find((e) => e.supersedeKey === noticeKey && !e.archivedAt);
  if (entry) history.updateEntryMessage(entry.id, message);
}

export function reportTerminalStallEscalated(terminalId: string): void {
  if (escalated.has(terminalId)) return;
  escalated.add(terminalId);
  if (escalated.size > 1) {
    updateNoticeCount();
    return;
  }
  const projectId = useProjectStore.getState().currentProject?.id;
  noticeKey = projectId ? `terminal-output-stalled:${projectId}` : "terminal-output-stalled";
  noticeId =
    notify({
      type: "warning",
      priority: "low",
      placement: "grid-bar",
      title: "Terminal output stalled",
      message: noticeMessage(1),
      supersedeKey: noticeKey,
      context: projectId ? { eventKind: "recovery", projectId } : { eventKind: "recovery" },
    }) || null;
}

export function clearTerminalStallEscalation(terminalId: string): void {
  if (!escalated.delete(terminalId)) return;
  if (escalated.size > 0) {
    updateNoticeCount();
    return;
  }
  if (noticeId !== null && liveNotice(noticeId)) {
    useNotificationStore.getState().removeNotification(noticeId);
  }
  noticeId = null;
  noticeKey = null;
}

export function __resetTerminalStallNoticeForTests(): void {
  escalated.clear();
  noticeId = null;
  noticeKey = null;
}
