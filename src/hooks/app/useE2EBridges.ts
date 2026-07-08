import { useEffect } from "react";
import { useErrorStore, useDiagnosticsStore, usePerformanceModeStore } from "@/store";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import { usePerfMetricsStore } from "@/store/perfMetricsStore";
import { installE2EActionDispatchBridge } from "@/services/ActionService";
import { loadE2ENotificationBackdoor } from "@/lazyPanels";

/**
 * Installs the E2E renderer backdoors: the ActionService dispatch bridge
 * (unconditional) and the store accessors gated on the preload-injected
 * `__DAINTREE_E2E_MODE__` flag (set only under DAINTREE_E2E_MODE=1 on
 * non-packaged builds) so none of these attach in production sessions.
 */
export function useE2EBridges(): void {
  useEffect(() => {
    installE2EActionDispatchBridge();
  }, []);

  useEffect(() => {
    // All E2E renderer backdoors are gated on the preload-injected
    // __DAINTREE_E2E_MODE__ flag (set only under DAINTREE_E2E_MODE=1 on
    // non-packaged builds) so none of these store accessors attach in
    // production sessions.
    if (window.__DAINTREE_E2E_MODE__ === true) {
      window.__DAINTREE_E2E_ERROR_STORE__ = () =>
        useErrorStore.getState().errors.map((e) => ({
          id: e.id,
          source: e.source,
          message: e.message,
          fromPreviousSession: e.fromPreviousSession,
        }));
      window.__DAINTREE_E2E_ADD_ERROR__ = (message: string) => {
        useErrorStore.getState().addError({
          type: "unknown",
          message,
          retryability: "none",
          source: "e2e-test",
        });
      };
      window.__DAINTREE_E2E_CLEAR_ERRORS__ = () => {
        useErrorStore.getState().reset();
      };
      // Parks a synthetic in-repo recipe stale-write conflict so E2E can exercise
      // the RecipeConflictDialog without racing a real on-disk file mutation. The
      // returned promise resolves with the user's choice; tests don't await it —
      // they assert the dialog renders and that reload/overwrite dismiss it.
      window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__ = (recipeName: string) => {
        void useRecipeConflictStore.getState().requestConflict({
          recipeId: `inrepo-${recipeName}`,
          recipeName,
          updates: { name: recipeName },
        });
      };

      // Per-window store accessors for the multi-window isolation spec (#9599).
      // Each project view is its own V8 context, so these Zustand singletons are
      // per-window — mutating one window's store must not leak into another's.
      window.__DAINTREE_E2E_DIAGNOSTICS_STATE__ = () => ({
        isOpen: useDiagnosticsStore.getState().isOpen,
      });
      window.__DAINTREE_E2E_OPEN_DIAGNOSTICS__ = () => useDiagnosticsStore.getState().openDock();
      window.__DAINTREE_E2E_PERF_METRICS_STATE__ = () => {
        const s = usePerfMetricsStore.getState();
        return { fps: s.fps, lafCount30s: s.lafCount30s, cls30s: s.cls30s };
      };
      window.__DAINTREE_E2E_SET_PERF_METRIC__ = (fps: number) =>
        usePerfMetricsStore.getState().setLiveMetrics({ fps, lafCount30s: 0, cls30s: 0 });
      window.__DAINTREE_E2E_PERF_MODE_STATE__ = () => ({
        performanceMode: usePerformanceModeStore.getState().performanceMode,
      });
      window.__DAINTREE_E2E_SET_PERF_MODE__ = (enabled: boolean) =>
        usePerformanceModeStore.getState().setPerformanceMode(enabled);

      // Lazy-load the notification backdoor only under E2E so its module closure
      // stays out of the production first-paint chunk. Fire-and-forget: the helper
      // side in e2e/helpers/notifications.ts waits for __daintreeNotificationsE2E
      // before use, so the async resolve doesn't need to block the effect.
      void loadE2ENotificationBackdoor()
        .then(({ installE2ENotificationBackdoor }) => {
          installE2ENotificationBackdoor();
        })
        .catch(() => {});
    }

    return () => {
      delete window.__DAINTREE_E2E_ERROR_STORE__;
      delete window.__DAINTREE_E2E_ADD_ERROR__;
      delete window.__DAINTREE_E2E_CLEAR_ERRORS__;
      delete window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__;
      delete window.__DAINTREE_E2E_DIAGNOSTICS_STATE__;
      delete window.__DAINTREE_E2E_OPEN_DIAGNOSTICS__;
      delete window.__DAINTREE_E2E_PERF_METRICS_STATE__;
      delete window.__DAINTREE_E2E_SET_PERF_METRIC__;
      delete window.__DAINTREE_E2E_PERF_MODE_STATE__;
      delete window.__DAINTREE_E2E_SET_PERF_MODE__;
      delete window.__daintreeNotificationsE2E;
    };
  }, []);
}
