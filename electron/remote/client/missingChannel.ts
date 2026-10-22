import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { HandshakeMismatch, HostHandshakeInfo } from "../../../shared/types/remoteHosts.js";
import { appErrorEnvelope } from "../link/envelopes.js";

/**
 * How a host's dispatcher refuses a channel its build doesn't serve
 * (`refuseOverLink`). Hosts already deployed answer in these words, so the
 * Shell reads them rather than waiting for a host to say it differently.
 */
const MISSING_CHANNEL_REASONS = ["is not classified", "has no context handler on this host"];

/** Each side's build as a person would name it: the version, or the commit when only that differs. */
function buildNames(
  mismatch: HandshakeMismatch,
  remote: HostHandshakeInfo
): { host: string; local: string } | null {
  switch (mismatch.kind) {
    case "version":
      return { host: mismatch.remote, local: mismatch.local };
    case "commit":
      return {
        host: `${remote.version} (${mismatch.remote.slice(0, 7)})`,
        local: `${remote.version} (${mismatch.local.slice(0, 7)})`,
      };
    case "protocol":
      // Never connected: there is no call to explain.
      return null;
  }
}

/**
 * A host on another build refusing `channel` because that build doesn't have
 * it, said as that: which host, and what each side runs. A refusal from a host
 * on this machine's own build is a defect, and keeps its words.
 */
export function explainMissingChannel(
  envelope: IpcEnvelope,
  channel: string,
  hostName: string,
  mismatch: HandshakeMismatch | null,
  remote: HostHandshakeInfo
): IpcEnvelope {
  if (envelope.ok || mismatch === null || envelope.error.code !== "CHANNEL_NOT_REMOTABLE") {
    return envelope;
  }
  const refusal = envelope.error.message;
  if (!MISSING_CHANNEL_REASONS.some((reason) => refusal === `Channel ${channel} ${reason}`)) {
    return envelope;
  }
  const builds = buildNames(mismatch, remote);
  if (builds === null) return envelope;
  return appErrorEnvelope(
    "HOST_BUILD_SKEW",
    `${refusal}: ${hostName} runs ${builds.host}, this machine runs ${builds.local}`,
    `${hostName} runs Daintree ${builds.host} and this machine runs ${builds.local}. This needs both on the same build.`
  );
}
