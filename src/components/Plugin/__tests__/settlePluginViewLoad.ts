import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Let a plugin view's load path run until `assertion` holds, then flush React.
 *
 * With activation, the kit and the styles mocked to settled promises, what a
 * mount still waits on is the attempt's dynamic imports: the kit chunk and the
 * view module, which the module runner resolves over RPC to the main vitest
 * process on its own schedule. On a loaded machine that takes as long as it
 * takes, so `waitFor`'s one-second deadline turns load into failures. Here each
 * round waits the pending imports out on the real clock (fake timers cannot
 * stall it), bounded only by a give-up well inside the test timeout.
 *
 * React runs outside `act()` while the load is pending, the way `waitFor` lets
 * it, since work queued inside an async `act()` scope would not flush until
 * that scope ended. Pair it with the skeleton gate switched off (the
 * `useDeferredLoading` mocks in the callers): the gate and its floor are the
 * other timers between a settled load and its view, and a load slowed past the
 * gate would hold the view back behind the floor.
 */
/** Below vitest.config.ts's 15 s testTimeout, which does not stop this loop. */
const GIVE_UP_MS = 10_000;

export async function settlePluginViewLoad(assertion: () => void): Promise<void> {
  let lastError: unknown = null;
  const holds = (): boolean => {
    try {
      assertion();
      return true;
    } catch (error) {
      lastError = error;
      return false;
    }
  };
  const previous: unknown = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  const start = performance.now();
  try {
    while (!holds()) {
      // Not a pacing deadline: a load that settles never gets near it. It
      // exists so an assertion that can never hold fails with its own message,
      // inside the test's timeout, and the act flag is put back.
      if (performance.now() - start > GIVE_UP_MS) throw lastError;
      await vi.dynamicImportSettled();
    }
  } finally {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
  await act(async () => {});
}
