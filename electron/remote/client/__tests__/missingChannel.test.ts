import { describe, expect, it } from "vitest";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import type { HostHandshakeInfo } from "../../../../shared/types/remoteHosts.js";
import { explainMissingChannel } from "../missingChannel.js";

const REMOTE: HostHandshakeInfo = {
  version: "0.47.0-dev.20261022",
  commit: "01f9de735f0000",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
};

const CHANNEL = "plugin:project-surface-choices-get";

function refusal(message: string, code = "CHANNEL_NOT_REMOTABLE"): IpcEnvelope {
  return { __daintreeIpcEnvelope: true, ok: false, error: { name: "AppError", message, code } };
}

const VERSION = {
  kind: "version",
  local: "0.46.0-dev.20261021",
  remote: "0.47.0-dev.20261022",
} as const;

describe("explainMissingChannel", () => {
  it("names the host and both versions for either refusal a host gives a channel its build lacks", () => {
    for (const reason of ["is not classified", "has no context handler on this host"]) {
      const explained = explainMissingChannel(
        refusal(`Channel ${CHANNEL} ${reason}`),
        CHANNEL,
        "studio-01",
        VERSION,
        REMOTE
      );
      expect(explained.ok).toBe(false);
      if (explained.ok) return;
      expect(explained.error.code).toBe("HOST_BUILD_SKEW");
      // The host's own words stay in the diagnostic.
      expect(explained.error.message).toBe(
        `Channel ${CHANNEL} ${reason}: studio-01 runs 0.47.0-dev.20261022, this machine runs 0.46.0-dev.20261021`
      );
      expect(explained.error.userMessage).toBe(
        "studio-01 runs Daintree 0.47.0-dev.20261022 and this machine runs 0.46.0-dev.20261021. This needs both on the same build."
      );
    }
  });

  it("names short commits when only the commit differs", () => {
    const explained = explainMissingChannel(
      refusal(`Channel ${CHANNEL} is not classified`),
      CHANNEL,
      "studio-01",
      { kind: "commit", local: "90cea899c8aaaa", remote: "01f9de735f0000" },
      REMOTE
    );
    if (explained.ok) throw new Error("expected a refusal");
    expect(explained.error.userMessage).toContain(
      "studio-01 runs Daintree 0.47.0-dev.20261022 (01f9de7) and this machine runs 0.47.0-dev.20261022 (90cea89)"
    );
  });

  it("leaves the refusal alone when the builds match", () => {
    const envelope = refusal(`Channel ${CHANNEL} is not classified`);
    expect(explainMissingChannel(envelope, CHANNEL, "studio-01", null, REMOTE)).toBe(envelope);
  });

  it("leaves every other answer alone", () => {
    const answers: IpcEnvelope[] = [
      { __daintreeIpcEnvelope: true, ok: true, data: 1 },
      refusal(`Channel ${CHANNEL} is answered by the Shell, not a host`),
      refusal(`Channel ${CHANNEL} is hybrid and not admitted for link calls`),
      refusal(`Channel ${CHANNEL} is not classified`, "INTERNAL"),
      // A refusal about some other channel than the one this call sent.
      refusal("Channel plugin:other is not classified"),
    ];
    for (const envelope of answers) {
      expect(explainMissingChannel(envelope, CHANNEL, "studio-01", VERSION, REMOTE)).toBe(envelope);
    }
  });
});
