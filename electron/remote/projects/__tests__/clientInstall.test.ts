import { describe, expect, it, vi } from "vitest";

vi.mock("../../../services/projectAcrossHosts/index.js", () => ({
  getProjectAcrossHostsService: () => ({
    identify: async () => ({
      remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree.git" }],
      committedProjectId: null,
    }),
  }),
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

  it("doesn't ask to set up a host it has reached before: its Daintree isn't listening", async () => {
    const service = createHostSwitchService({
      client: {
        connectAndWait: vi.fn(async () => "host-mode-off" as never),
        getWindowHost: vi.fn(() => ({ hostId: "local" }) as never),
        list: vi.fn(
          () => [{ descriptor: { id: "studio-03", name: "Studio 3", lastSeenAt: 1_000 } }] as never
        ),
      },
      sessionFor: () => null,
    });
    await expect(service.pickerRoots({ toHostId: "studio-03" })).rejects.toMatchObject({
      code: "HOST_MODE_OFF",
      userMessage: "Daintree isn't listening on Studio 3. Try again once it's running there.",
    });
  });

  it("says ssh couldn't log in, in its own words, rather than unreachable", async () => {
    const service = createHostSwitchService({
      client: {
        connectAndWait: vi.fn(async () => "stopped-retrying" as never),
        getWindowHost: vi.fn(() => ({ hostId: "local" }) as never),
        list: vi.fn(
          () =>
            [
              {
                descriptor: { id: "studio-03", name: "Studio 3" },
                connection: {
                  status: "unreachable",
                  lastSeenAt: null,
                  detail: "Host key verification failed.",
                  stoppedRetrying: true,
                },
              },
            ] as never
        ),
      },
      sessionFor: () => null,
    });
    await expect(service.pickerRoots({ toHostId: "studio-03" })).rejects.toMatchObject({
      code: "HOST_SSH_ACCESS_DENIED",
      userMessage: "ssh couldn't log in to Studio 3: Host key verification failed.",
    });
  });

  it("still says unreachable for a host that never answered", async () => {
    await expect(
      serviceFor("timeout").pickerRoots({ toHostId: "studio-03" })
    ).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });

  // An idle release closes hosts one after another; a lookup that reaches
  // one just closed must not dial it straight back (#13926).
  it("asks only connected hosts which have the project, and never dials one that isn't", async () => {
    const connectAndWait = vi.fn(async () => "ready" as never);
    const studio3 = {
      isOpen: true,
      call: vi.fn(async () => [
        {
          projectId: "p3",
          path: "/srv/daintree",
          name: "daintree",
          remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree.git" }],
          source: "registered",
          matchedBy: "remote-url",
          lastOpenedAt: null,
        },
      ]),
    };
    const service = createHostSwitchService({
      client: {
        connectAndWait,
        getWindowHost: vi.fn(() => ({ hostId: "local" }) as never),
        list: vi.fn(
          () =>
            [
              { descriptor: { id: "studio-03", name: "Studio 3" } },
              { descriptor: { id: "studio-04", name: "Studio 4" } },
            ] as never
        ),
      },
      sessionFor: (hostId) => (hostId === "studio-03" ? (studio3 as never) : null),
    });
    await expect(
      service.locate({ senderWebContentsId: 1 } as never, {
        fromHostId: "local",
        projectId: "p1",
        toHostIds: ["studio-03", "studio-04"],
      })
    ).resolves.toEqual([
      {
        hostId: "studio-03",
        projects: [{ projectId: "p3", name: "daintree", path: "/srv/daintree" }],
      },
      { hostId: "studio-04", projects: null },
    ]);
    expect(connectAndWait).not.toHaveBeenCalled();
  });

  it("doesn't dial the window's own host to say what its project is", async () => {
    const connectAndWait = vi.fn(async () => "ready" as never);
    const service = createHostSwitchService({
      client: {
        connectAndWait,
        getWindowHost: vi.fn(() => ({ hostId: "studio-03" }) as never),
        list: vi.fn(() => [{ descriptor: { id: "studio-03", name: "Studio 3" } }] as never),
      },
      sessionFor: () => null,
    });
    await expect(
      service.locate({ senderWebContentsId: 1 } as never, {
        fromHostId: "studio-03",
        projectId: "p1",
        toHostIds: ["local"],
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(connectAndWait).not.toHaveBeenCalled();
  });
});
