import type { Page } from "@playwright/test";
import type { ActionDispatchResult, ActionSource } from "../../shared/types/actions";

export type ActionResult<T = unknown> = ActionDispatchResult<T>;

export interface DispatchActionOptions {
  /**
   * The dispatch source the action sees. Typed loosely because specs also
   * pass sources the hook accepts outside the product union.
   */
  source?: ActionSource | (string & {});
  /** Pre-confirm an action that would otherwise stop for confirmation. */
  confirmed?: boolean;
}

/**
 * Dispatch an action through the renderer's `__daintreeDispatchAction` test
 * hook and return the ActionService result as-is — check `ok` yourself.
 *
 * A backdoor: use it to set a scene, not as the gesture a test is about. A
 * test of an action's user entry point goes through the menu, palette or
 * keybinding. Throws when the hook is missing rather than returning a result
 * that looks like an action failure.
 */
export async function dispatchAction<T = unknown>(
  page: Page,
  actionId: string,
  args?: unknown,
  options?: DispatchActionOptions
): Promise<ActionResult<T>> {
  return (await page.evaluate(
    async ([id, actionArgs, dispatchOptions]) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: DispatchActionOptions
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("__daintreeDispatchAction is not available");
      }
      return dispatch(id, actionArgs, dispatchOptions);
    },
    [actionId, args, options] as const
  )) as ActionResult<T>;
}
