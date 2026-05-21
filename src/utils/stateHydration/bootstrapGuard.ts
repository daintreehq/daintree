import { keybindingService } from "@/services/KeybindingService";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { withRendererSpan } from "@/utils/performance";
import { PERF_MARKS } from "@shared/perf/marks";

let hydrationBootstrapPromise: Promise<void> | null = null;

export async function ensureHydrationBootstrap(): Promise<void> {
  if (!hydrationBootstrapPromise) {
    hydrationBootstrapPromise = Promise.all([
      withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP_LOAD_OVERRIDES, () =>
        keybindingService.loadOverrides()
      ),
      withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP_INIT_USER_AGENTS, () =>
        useUserAgentRegistryStore.getState().initialize()
      ),
    ])
      .then(() => undefined)
      .catch((error) => {
        hydrationBootstrapPromise = null;
        throw error;
      });
  }

  await hydrationBootstrapPromise;
}

export function __resetBootstrapForTests(): void {
  hydrationBootstrapPromise = null;
}
