import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/**
 * The escalated recovery every error fallback offers. Falls back to the raw
 * bridge when the action can't dispatch — the thing that crashed may be what
 * the action system depends on, and this button has to do something.
 */
export function reloadWindow(): void {
  safeFireAndForget(
    actionService
      .dispatch("window.reload", undefined, { source: "user" })
      .then((result) => (result.ok ? undefined : window.electron?.window?.reload?.())),
    { context: "Error fallback reload window" }
  );
}
