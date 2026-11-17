import { afterEach, describe, expect, it, vi } from "vitest";

type Loader = ((hostId: string) => Promise<unknown>) | null;
const setHostProjectsLoader = vi.hoisted(() => vi.fn<(loader: Loader) => void>());
const forgetHostProjects = vi.hoisted(() => vi.fn<(hostId: string) => void>());
vi.mock("../hostProjects", () => ({ setHostProjectsLoader, forgetHostProjects }));

import { installHostProjectsLoader } from "../installHostProjectsLoader";

const originalElectron = (globalThis as { window?: unknown }).window;

function setElectron(electron: unknown): void {
  (globalThis as { window?: unknown }).window = { electron };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalElectron;
  vi.clearAllMocks();
});

describe("installHostProjectsLoader", () => {
  it("lists a host's projects through remoteHosts.listHostProjects", async () => {
    const projects = [{ id: "p1", name: "App", path: "/srv/app" }];
    const listHostProjects = vi.fn(async () => projects);
    setElectron({ remoteHosts: { listHostProjects } });

    const uninstall = installHostProjectsLoader();
    const loader = setHostProjectsLoader.mock.calls[0]![0]!;
    await expect(loader("studio-01")).resolves.toBe(projects);
    expect(listHostProjects).toHaveBeenCalledWith({ hostId: "studio-01" });
    await expect(loader("local")).resolves.toBe(projects);
    expect(listHostProjects).toHaveBeenLastCalledWith({ hostId: "local" });

    uninstall();
    expect(setHostProjectsLoader).toHaveBeenLastCalledWith(null);
  });

  it("drops a forgotten host's lists until it is uninstalled", () => {
    let listener: ((event: { type: string; hostId?: string }) => void) | null = null;
    const off = vi.fn(() => {
      listener = null;
    });
    setElectron({
      remoteHosts: {
        listHostProjects: vi.fn(async () => []),
        onEvent: (callback: typeof listener) => {
          listener = callback;
          return off;
        },
      },
    });

    const uninstall = installHostProjectsLoader();
    listener!({ type: "connection-changed", hostId: "studio-01" });
    expect(forgetHostProjects).not.toHaveBeenCalled();
    listener!({ type: "host-forgotten", hostId: "studio-01" });
    expect(forgetHostProjects).toHaveBeenCalledWith("studio-01");

    uninstall();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("installs nothing when the bridge has no listing", () => {
    setElectron({ remoteHosts: {} });
    installHostProjectsLoader()();
    expect(setHostProjectsLoader).not.toHaveBeenCalled();
  });
});
