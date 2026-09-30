import type { PluginAnnounceOptions } from "@shared/types/plugin-sdk-react";
import { withPluginKit } from "./kit";

function announce(message: string, options?: PluginAnnounceOptions): void {
  withPluginKit((kit) => kit.announce(message, options));
}

/**
 * A function that speaks a message to assistive tech through the host's
 * announcer, the one the kit's own controls use. Stable across renders, so it
 * is safe in effect dependencies. A hook so it can take view context later
 * without a breaking change.
 */
export function useAnnounce(): (message: string, options?: PluginAnnounceOptions) => void {
  return announce;
}
