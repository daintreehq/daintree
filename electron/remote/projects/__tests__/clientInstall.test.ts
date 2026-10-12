import { describe, expect, it, vi } from "vitest";

vi.mock("../../../services/projectAcrossHosts/index.js", () => ({
  getProjectAcrossHostsService: () => ({}),
}));

import { createHostSwitchService } from "../clientInstall.js";

function serviceFor(readiness: string) {
  return createHostSwitchService({
    client: {
      connectAndWait: vi.fn(async () => readiness as never),
      getWindowHost: vi.fn(() => ({ hostId: "local" }) as never),
      list: vi.fn(() => [{ descriptor: { id: "studio-03", name: "Studio 3" } }] as never),
    },
    sessionFor: () => null,
  });
}

describe("createHostSwitchService", () => {
  it("names a host whose Daintree isn't in Host mode, rather than calling it unreachable", async () => {
    await expect(
      serviceFor("host-mode-off").pickerRoots({ toHostId: "studio-03" })
    ).rejects.toMatchObject({
      code: "HOST_MODE_OFF",
      userMessage: "Daintree isn't running in Host mode on Studio 3. Set it up to work there.",
    });
  });

  it("still says unreachable for a host that never answered", async () => {
    await expect(
      serviceFor("timeout").pickerRoots({ toHostId: "studio-03" })
    ).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });
});
