import { installCanopyHostWith, type CanopySessionSource } from "./host.js";
import { createLocalCanopyViewers } from "./localViewers.js";

/** Serve this host's Canopy to attached Shells that read it without a bound view. */
export function installCanopyHost(server: CanopySessionSource): () => void {
  return installCanopyHostWith(server, createLocalCanopyViewers());
}
