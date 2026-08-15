import { afterEach } from "vitest";
import { registerProjectCrudHandlers as registerProjectCrudHandlersRaw } from "../../projectCrud/index.js";
import type { HandlerDependencies } from "../../../types.js";

/**
 * Registration harness for suites that exercise the project CRUD handlers.
 *
 * `registerProjectCrudHandlers` is not just a handler registration: it starts a
 * real `ProjectStatsService`, `FleetSnapshotService`, and
 * `CompletionAcknowledgementService`, and returns the disposer that stops them.
 * Suites routinely dropped that disposer, so every registration leaked live
 * pollers for the remainder of the file.
 *
 * That leak is not inert. The pollers run on a 5-second *aligned* cadence, so
 * the first tick lands at the next wall-clock boundary and can fire
 * immediately. When one fires it computes and broadcasts, reaching whatever the
 * suite mocked — and a mock that omits an export it never expected to need
 * rejects. Because the rejection only lands if a tick beats teardown, the
 * failure appears on a loaded CI runner and not locally, which is how it
 * reached `develop` as an intermittent red rather than a broken test.
 *
 * Use this instead of importing the registrar directly: it registers exactly as
 * before, and disposes after each test.
 */
export function createProjectCrudRegistrar(): (deps: HandlerDependencies) => () => void {
  const pending: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of pending.splice(0)) dispose();
  });

  return (deps: HandlerDependencies) => {
    const dispose = registerProjectCrudHandlersRaw(deps);
    let disposed = false;
    // Idempotent: some suites dispose mid-test to assert post-stop behaviour,
    // and the sweep above must not then stop an already-stopped service.
    const disposeOnce = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    pending.push(disposeOnce);
    return disposeOnce;
  };
}
