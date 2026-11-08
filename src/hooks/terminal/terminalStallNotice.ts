import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

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

const NOTICE_KEY = "terminal-output-stalled";

function noticeMessage(count: number): string {
  return count === 1
    ? "An automatic refresh didn't clear it. Use Retry in the terminal."
    : `It affects ${pluralize(count, "terminal")}, and an automatic refresh didn't clear it. Use Retry in each one.`;
}

function liveNotice(id: string) {
  return useNotificationStore.getState().notifications.find((n) => n.id === id && !n.dismissed);
}

function updateNoticeCount(): void {
  if (noticeId === null) return;
  const live = liveNotice(noticeId);
  // Gone means the user dismissed it, and this incident doesn't post again.
  if (!live) return;
  const message = noticeMessage(escalated.size);
  useNotificationStore.getState().updateNotification(noticeId, { message });
  if (live.historyEntryId) {
    useNotificationHistoryStore.getState().updateEntryMessage(live.historyEntryId, message);
  }
}

export function reportTerminalStallEscalated(terminalId: string): void {
  if (escalated.has(terminalId)) return;
  escalated.add(terminalId);
  if (escalated.size > 1) {
    updateNoticeCount();
    return;
  }
  noticeId =
    notify({
      type: "warning",
      priority: "low",
      placement: "grid-bar",
      title: "Terminal output stalled",
      message: noticeMessage(1),
      supersedeKey: NOTICE_KEY,
      context: { eventKind: "recovery" },
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
}

export function __resetTerminalStallNoticeForTests(): void {
  escalated.clear();
  noticeId = null;
}
