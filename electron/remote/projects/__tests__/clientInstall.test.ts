import { describe, expect, it, vi } from "vitest";

vi.mock("../../../services/projectAcrossHosts/index.js", () => ({
  getProjectAcrossHostsService: () => ({
    identify: async () => ({
      remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree.git" }],
      committedProjectId: null,
    }),
    find: async () => [
      {
        projectId: "l1",
        path: "/Users/greg/daintree",
        name: "daintree",
        remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree.git" }],
        source: "registered",
        matchedBy: "remote-url",
        lastOpenedAt: null,
      },
    ],
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

  it("finds the window's project's copy on the host it is switching to, without dialling either", async () => {
    const connectAndWait = vi.fn(async () => "ready" as never);
    const remotes = [{ name: "origin", url: "https://github.com/daintreehq/daintree.git" }];
    const studio3 = {
      isOpen: true,
      call: vi.fn(async (method: string) =>
        method === "projects.identify"
          ? { remotes, committedProjectId: "c-1" }
          : [
              {
                projectId: "p3",
                path: "/srv/daintree",
                name: "daintree",
                remotes,
                source: "registered",
                matchedBy: "remote-url",
                lastOpenedAt: null,
              },
              // The same committed id, but no shared remote: another repository.
              {
                projectId: "p4",
                path: "/srv/fork",
                name: "fork",
                remotes: [{ name: "origin", url: "https://github.com/someone/fork.git" }],
                source: "registered",
                matchedBy: "committed-id",
                lastOpenedAt: null,
              },
              {
                projectId: null,
                path: "/srv/scan/daintree",
                name: "daintree",
                remotes,
                source: "on-disk",
                matchedBy: "remote-url",
                lastOpenedAt: null,
              },
            ]
      ),
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
      service.copiesOn({ hostId: "local", projectId: "p1" }, "studio-03")
    ).resolves.toEqual([{ projectId: "p3", name: "daintree", path: "/srv/daintree" }]);
    expect(studio3.call).toHaveBeenCalledWith(
      "projects.find",
      { remoteUrls: ["https://github.com/daintreehq/daintree.git"], committedProjectId: null },
      {}
    );

    // From a window on the host: its project is identified there, its copy found here.
    studio3.call.mockClear();
    await expect(
      service.copiesOn({ hostId: "studio-03", projectId: "p3" }, "local")
    ).resolves.toEqual([{ projectId: "l1", name: "daintree", path: "/Users/greg/daintree" }]);
    expect(studio3.call).toHaveBeenCalledWith("projects.identify", { projectId: "p3" }, {});

    // Already on that host: nothing to look for, and nothing is asked.
    studio3.call.mockClear();
    await expect(
      service.copiesOn({ hostId: "studio-03", projectId: "p3" }, "studio-03")
    ).resolves.toEqual([]);
    expect(studio3.call).not.toHaveBeenCalled();

    // Neither end connected: it can't say, and it never dials to find out.
    await expect(service.copiesOn({ hostId: "local", projectId: "p1" }, "studio-04")).resolves.toBe(
      null
    );
    await expect(service.copiesOn({ hostId: "studio-04", projectId: "p1" }, "local")).resolves.toBe(
      null
    );
    await expect(service.copiesOn({ hostId: "local", projectId: "p1" }, "nowhere")).resolves.toBe(
      null
    );
    expect(connectAndWait).not.toHaveBeenCalled();
  });
});
