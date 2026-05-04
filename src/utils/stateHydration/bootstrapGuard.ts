import { keybindingService } from "@/services/KeybindingService";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";

let hydrationBootstrapPromise: Promise<void> | null = null;

export async function ensureHydrationBootstrap(): Promise<void> {
  if (!hydrationBootstrapPromise) {
    hydrationBootstrapPromise = (async () => {
      await keybindingService.loadOverrides();
      await useUserAgentRegistryStore.getState().initialize();
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
