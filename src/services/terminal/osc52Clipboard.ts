import type { ManagedTerminal } from "./types";
import {
  OSC52_GESTURE_WINDOW_MS,
  judgeOsc52Write,
  parseOsc52,
  sanitizeForNotice,
  summarizeOsc52Text,
  type Osc52Verdict,
} from "./osc52";
import { useOsc52ClipboardStore } from "@/store/osc52ClipboardStore";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { usePanelStore } from "@/store/panelStore";
import {
  useNotificationStore,
  type NotificationAction,
  type NotificationType,
} from "@/store/notificationStore";
import { TOAST_DURATION } from "@/lib/notify";
import { writeMainClipboard } from "@/lib/mainClipboard";
import { pluralize } from "@/lib/pluralize";
import { logWarn } from "@/utils/logger";

/**
 * Handles one OSC 52 sequence (#17327). Off, every write is dropped silently,
 * as it always was. On, a plain shell's write lands only while its pane is
 * focused and the user pressed a key or clicked in it moments ago, and every
 * write, honoured or blocked, gets a notice naming the pane and showing what
 * it carried, so an overwrite is never silent.
 */
export type Osc52Pane = Pick<
  ManagedTerminal,
  | "id"
  | "runtimeAgentId"
  | "isFocused"
  | "lastUserGestureAt"
  | "isSerializedRestoreInProgress"
  | "scrollbackRestoreState"
>;

export function handleOsc52(managed: Osc52Pane, data: string): void {
  if (!useOsc52ClipboardStore.getState().enabled) return;
  // Runtime identity, read per sequence: a shell an agent is detected in
  // stops being honoured at once. Agent output is the untrusted source.
  if (managed.runtimeAgentId) return;
  // A restore replays output nobody just asked for.
  if (managed.isSerializedRestoreInProgress || managed.scrollbackRestoreState === "in-progress") {
    return;
  }

  const request = parseOsc52(data);
  if (request.kind === "ignore") return;

  const verdict = judgeOsc52Write({
    // A cached project view keeps its pane focused and keeps parsing, but
    // nobody can see the notice there.
    focused: managed.isFocused && isProjectViewObservable(),
    lastGestureAt: managed.lastUserGestureAt,
    now: performance.now(),
  });
  const paneId = managed.id;
  if (verdict !== "allow") {
    // Nothing was going to land and nobody asked for it: no notice for a
    // malformed write outside the window.
    if (request.kind === "write") showBlocked(paneId, request.text, verdict);
    return;
  }
  if (request.kind === "invalid") {
    showNotice(paneId, {
      type: "warning",
      title: `Couldn't copy from ${paneName(paneId)}`,
      message:
        request.reason === "too-large"
          ? "The program sent more text than one copy can carry (about 1 MB)."
          : "The program sent text that isn't valid base64-encoded UTF-8.",
    });
    return;
  }
  writeClipboard(paneId, request.text);
}

function writeClipboard(paneId: string, text: string): void {
  void writeMainClipboard(text).then(
    () => {
      const { preview, characters, lines } = summarizeOsc52Text(text);
      showNotice(paneId, {
        type: "info",
        title: `Copied from ${paneName(paneId)}`,
        message: `“${preview}” · ${pluralize(characters, "character")} · ${pluralize(lines, "line")}`,
      });
    },
    (error: unknown) => {
      // Never the text: terminal contents stay out of logs.
      logWarn("[OSC52] Clipboard write failed", { paneId, error: String(error) });
      showNotice(paneId, {
        type: "error",
        title: `Couldn't copy from ${paneName(paneId)}`,
        message: "The clipboard didn't accept the text.",
        action: { label: "Retry", onClick: () => writeClipboard(paneId, text) },
      });
    }
  );
}

function showBlocked(paneId: string, text: string, verdict: Exclude<Osc52Verdict, "allow">) {
  const { preview, characters, lines } = summarizeOsc52Text(text);
  const why =
    verdict === "not-focused"
      ? "it isn't the focused panel"
      : `nothing was typed or clicked in it in the last ${OSC52_GESTURE_WINDOW_MS / 1000} seconds`;
  showNotice(paneId, {
    type: "warning",
    title: "Clipboard write blocked",
    message: `${paneName(paneId)} tried to copy “${preview}” (${pluralize(characters, "character")} · ${pluralize(lines, "line")}), but ${why}.`,
    // Clicking it is the gesture the write was missing.
    action: { label: "Copy anyway", onClick: () => writeClipboard(paneId, text) },
  });
}

function paneName(paneId: string): string {
  const title = usePanelStore.getState().panelsById[paneId]?.title;
  const name = typeof title === "string" ? sanitizeForNotice(title, 40) : "";
  return name || "Terminal";
}

interface Notice {
  type: NotificationType;
  title: string;
  message: string;
  action?: NotificationAction;
}

/**
 * Straight to the toast store, past notify()'s mute and quiet-hours gates:
 * this notice is what keeps a clipboard overwrite from being silent, so it
 * can't be switched off separately from the feature. Never written to the
 * inbox either, since it carries clipboard contents. One per pane: a newer
 * one replaces it.
 */
function showNotice(paneId: string, notice: Notice): void {
  const store = useNotificationStore.getState();
  const replaceKey = `osc52:${paneId}`;
  for (const live of store.notifications) {
    if (live.replaceKey === replaceKey && !live.dismissed) store.dismissNotification(live.id);
  }
  store.addNotification({
    ...notice,
    priority: "high",
    duration: TOAST_DURATION[notice.type],
    replaceKey,
    context: { panelId: paneId },
  });
}
