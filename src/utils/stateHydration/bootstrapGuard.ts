import { keybindingService } from "@/services/KeybindingService";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useProjectStore } from "@/store/projectStore";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { withRendererSpan } from "@/utils/performance";
import { PERF_MARKS } from "@shared/perf/marks";

let hydrationBootstrapPromise: Promise<void> | null = null;

export async function ensureHydrationBootstrap(): Promise<void> {
  if (!hydrationBootstrapPromise) {
    hydrationBootstrapPromise = (async () => {
      // The batched app:boot payload carries keybinding overrides, the
      // user-agent registry, and the full project list as ride-along fields
      // (#10390). When present, seed the renderer stores directly instead of
      // firing the standalone IPC pair. The fields are undefined on older
      // main processes and the safe-boot { ok: false } fallback, where the
      // original IPC pull path runs unchanged.
      const safeBoot = await getSafeBootPromise();
      const boot = safeBoot.ok ? safeBoot.result : null;

      if (boot?.projects !== undefined) {
        const bootProjects = boot.projects;
        const bootCurrentProject = boot.project ?? null;
        useProjectStore.setState((state) => ({
          projects: bootProjects,
          currentProject: bootCurrentProject ?? state.currentProject,
          isBootstrapped: true,
        }));
      }

      await Promise.all([
        withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP_LOAD_OVERRIDES, () =>
          boot?.keybindingOverrides !== undefined
            ? Promise.resolve(keybindingService.applyOverrides(boot.keybindingOverrides))
            : keybindingService.loadOverrides()
        ),
        withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP_INIT_USER_AGENTS, () => {
          if (boot?.userAgentRegistry !== undefined) {
            useUserAgentRegistryStore.getState().seedRegistry(boot.userAgentRegistry);
            return Promise.resolve();
          }
          return useUserAgentRegistryStore.getState().initialize();
        }),
      ]);
    })().catch((error) => {
      hydrationBootstrapPromise = null;
      throw error;
    });
  }

  await hydrationBootstrapPromise;
}

export function __resetBootstrapForTests(): void {
  hydrationBootstrapPromise = null;
}
