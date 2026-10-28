import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { VoicePaneHostsClient } from "./client.js";

/** Shell side: dictation into a host's pane reads that pane from the host. */
export function installVoicePaneHostsClient(deps: {
  sessionFor(hostId: HostId): LinkSession | null;
}): () => void {
  return registerRemoteService("voicePaneHosts", new VoicePaneHostsClient(deps));
}
