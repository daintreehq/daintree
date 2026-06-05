import type { ActionRegistry } from "../actionTypes";
import { useUIStore } from "@/store/uiStore";

/**
 * UI-facing notification-inbox actions. The diagnostics-side
 * `notifications.recent` query lives in `logActions.ts`; this file owns the
 * keyboard / toolbar / agent-dispatchable surface so the inbox is reachable
 * without click-only paths (#9130).
 */
export function registerNotificationsActions(actions: ActionRegistry): void {
  actions.set("notifications.toggle", () => ({
    id: "notifications.toggle",
    title: "Toggle Notification Inbox",
    description: "Open or close the notification inbox dropdown anchored to the toolbar bell.",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // The bell's tooltip already shows the unread count; the keyboard-shortcut
    // discovery hint would pop a competing "Toggle Notification Inbox" bubble
    // on the same button at milestone click counts. Opt out.
    suppressShortcutHint: true,
    keywords: ["notifications", "inbox", "bell", "alerts"],
    run: async () => {
      useUIStore.getState().toggleNotificationCenter();
    },
  }));
}
