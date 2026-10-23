import { installCanopyHostWith, type CanopySessionSource } from "./host.js";
import { createLocalCanopyViewers } from "./localViewers.js";

/** Serve this host's Canopy to attached Shells that read it without a bound view. */
export function installCanopyHost(server: CanopySessionSource): () => void {
  return installCanopyHostWith(server, createLocalCanopyViewers(), {
    // Loaded on the first read: a host nobody picks an assistant on reads none.
    readAgents: async (options) => {
      const { getLocalAgentDirectory } =
        await import("../../services/assistants/localAgentDirectory.js");
      return getLocalAgentDirectory().read(options);
    },
  });
}
