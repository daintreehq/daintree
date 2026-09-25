import { afterEach, describe, expect, it, vi } from "vitest";

type Loader = ((hostId: string) => Promise<unknown>) | null;
const setHostProjectsLoader = vi.hoisted(() => vi.fn<(loader: Loader) => void>());
vi.mock("../hostProjects", () => ({ setHostProjectsLoader }));

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

  it("installs nothing when the bridge has no listing", () => {
    setElectron({ remoteHosts: {} });
    installHostProjectsLoader()();
    expect(setHostProjectsLoader).not.toHaveBeenCalled();
  });
});
