import { HelpSessionController } from "./HelpSessionController";

/**
 * One live `HelpSessionController` per assistant lane, for the lifetime of the
 * project view (#12108).
 *
 * A registry rather than component state because a background lane still needs
 * a running controller. Its MCP subscriptions are what surface a tool-call
 * approval, a tier-mismatch prompt or a session-revoked banner, and its idle
 * timer is what hibernates it — none of which can happen if the controller is
 * torn down whenever its tab is not the one on screen. Holding controllers in
 * `useState` inside the visible body would do exactly that, and switching tabs
 * would also lose the lane's in-memory launch phase and banners.
 *
 * Module scope is per project view: each project gets its own renderer context,
 * which is the same granularity `helpPanelStore` already has.
 */
const controllers = new Map<number, HelpSessionController>();

export function acquireHelpSessionController(slot: number): HelpSessionController {
  let controller = controllers.get(slot);
  if (!controller) {
    controller = new HelpSessionController(slot);
    controllers.set(slot, controller);
  }
  return controller;
}

/**
 * Drop a lane's controller once the lane itself is gone.
 *
 * Only for a lane the user actually closed. `stop()` deliberately does NOT end
 * the session — it just disarms listeners — so the caller must have revoked
 * and killed the backend first; releasing without that would leave a running
 * agent with nothing listening to it.
 */
export function releaseHelpSessionController(slot: number): void {
  const controller = controllers.get(slot);
  if (!controller) return;
  controllers.delete(slot);
  controller.stop();
}

export function __resetHelpSessionControllersForTests(): void {
  for (const controller of controllers.values()) controller.stop();
  controllers.clear();
}
