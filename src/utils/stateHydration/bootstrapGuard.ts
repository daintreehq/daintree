import { keybindingService } from "@/services/KeybindingService";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";

let hydrationBootstrapPromise: Promise<void> | null = null;

export async function ensureHydrationBootstrap(): Promise<void> {
  if (!hydrationBootstrapPromise) {
    hydrationBootstrapPromise = Promise.all([
      keybindingService.loadOverrides(),
      useUserAgentRegistryStore.getState().initialize(),
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
