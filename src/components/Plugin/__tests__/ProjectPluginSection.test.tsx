// @vitest-environment jsdom
import {
  act,
  cleanup,
  render as rtlRender,
  screen,
  type RenderOptions,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginDetailPane, ProjectPluginSection } from "../ProjectPluginSection";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type { ProjectPluginInfo, ProjectPluginState } from "@shared/types/plugin";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const activateStagedProjectPlugin = vi.fn<(pluginId: string) => Promise<void>>();
const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();
const reloadProjectPlugins = vi.fn<() => Promise<void>>();

function plugin(overrides: Partial<ProjectPluginInfo> & { state: ProjectPluginState }) {
  return {
    projectId: "proj-a",
    id: "acme.dashboard",
    displayName: "Acme Dashboard",
    version: "1.2.0",
    capabilities: [],
    dirName: "dashboard",
    muted: false,
    collidesWithGlobal: false,
    ...overrides,
  } satisfies ProjectPluginInfo;
}

function button(label: string): HTMLElement {
  const match = screen.getAllByRole("button").find((el) => (el.textContent ?? "").trim() === label);
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match;
}

beforeEach(() => {
  activateStagedProjectPlugin.mockReset().mockResolvedValue(undefined);
  setProjectPluginTrust.mockReset().mockResolvedValue(undefined);
  reloadProjectPlugins.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      plugin: { activateStagedProjectPlugin, setProjectPluginTrust, reloadProjectPlugins },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

describe("ProjectPluginSection load errors", () => {
  const failed = plugin({
    state: "active",
    loadError: { message: "activate() threw: no such module", at: 1 },
  });

  it("marks an active row Error when its last run threw", () => {
    render(<ProjectPluginSection plugins={[failed]} selectedId={null} onSelect={() => {}} />);

    // Loaded and failed at once: the row keeps its active styling and gains the
    // failure signal rather than swapping to a fourth state badge.
    const row = screen.getAllByRole("listitem")[0]!;
    expect(row.textContent).toContain("Error");
    expect(row.textContent).not.toContain("Off");
    expect(row.textContent).not.toContain("Staged");
  });

  it("leaves a healthy active row unmarked", () => {
    render(
      <ProjectPluginSection
        plugins={[plugin({ state: "active" })]}
        selectedId={null}
        onSelect={() => {}}
      />
    );

    expect(screen.getAllByRole("listitem")[0]!.textContent).not.toContain("Error");
  });

  it("renders the real cause in the detail pane", () => {
    render(<ProjectPluginDetailPane plugin={failed} />);

    expect(screen.getByText(/activate\(\) threw: no such module/)).toBeTruthy();
    expect(document.body.textContent).toContain("Error");
  });

  it("shows both signals when a failed plugin also clashes on id", () => {
    render(
      <ProjectPluginDetailPane
        plugin={plugin({
          state: "active",
          collidesWithGlobal: true,
          loadError: { message: "activate() threw", at: 1 },
        })}
      />
    );

    // Two separate semantic statuses, not two competing emphases — a clash and
    // a broken run are different facts and the user needs both.
    expect(document.body.textContent).toContain("activate() threw");
    expect(document.body.textContent).toContain("An installed plugin already uses this id");
  });

  it("keeps the unreadable-manifest message distinct from a run failure", () => {
    render(
      <ProjectPluginDetailPane
        plugin={plugin({ state: "invalid", error: "bad JSON", id: "broken" })}
      />
    );

    expect(document.body.textContent).toContain("bad JSON");
    expect(document.body.textContent).not.toContain("Error");
  });
});

describe("ProjectPluginSection", () => {
  it("renders nothing when the project ships no plugins", () => {
    const { container } = render(
      <ProjectPluginSection plugins={[]} selectedId={null} onSelect={() => {}} />
    );
    expect(container.textContent).toBe("");
  });

  it("marks every row with its project origin and its state", () => {
    render(
      <ProjectPluginSection
        plugins={[plugin({ state: "blocked" }), plugin({ id: "acme.deploy", state: "staged" })]}
        selectedId={null}
        onSelect={() => {}}
      />
    );

    // The header is a real heading now, so the row collection is just the rows.
    const options = screen.getAllByRole("listitem");
    expect(options).toHaveLength(2);
    const rows = options.map((el) => el.textContent ?? "");
    expect(rows.every((t) => t.includes("Project"))).toBe(true);
    expect(rows[0]).toContain("Off");
    expect(rows[1]).toContain("Staged");
  });

  it("gives a staged plugin a one-click activate and no enable switch", async () => {
    render(
      <ProjectPluginSection
        plugins={[plugin({ state: "staged" })]}
        selectedId={null}
        onSelect={() => {}}
      />
    );

    // Trust is granted at the folder, so a per-row toggle would promise a
    // granularity the model doesn't have.
    expect(screen.queryByRole("switch")).toBeNull();

    await act(async () => {
      button("Activate").click();
    });
    expect(activateStagedProjectPlugin).toHaveBeenCalledWith("acme.dashboard");
  });

  it("surfaces an id collision without resolving it", () => {
    render(
      <ProjectPluginSection
        plugins={[plugin({ state: "active", collidesWithGlobal: true })]}
        selectedId={null}
        onSelect={() => {}}
      />
    );
    expect(document.body.textContent).toContain("Id clash");
  });

  it("toggles selection off when the selected row is clicked again", () => {
    const onSelect = vi.fn();
    render(
      <ProjectPluginSection
        plugins={[plugin({ state: "active" })]}
        selectedId="acme.dashboard"
        onSelect={onSelect}
      />
    );

    screen.getAllByRole("listitem")[0]?.querySelector("button")?.click();
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("ProjectPluginDetailPane", () => {
  it("discloses capabilities without implying any of them can be denied", () => {
    render(
      <ProjectPluginDetailPane
        plugin={plugin({ state: "active", capabilities: ["shell:exec", "fs:project-write"] })}
      />
    );

    const text = document.body.textContent ?? "";
    // Disclosed, and said to be disclosed.
    expect(text).toContain("Declared capabilities");
    expect(text.toLowerCase()).toContain("doesn't sandbox project plugins");
    // No per-capability control anywhere on the pane.
    expect(screen.queryByRole("switch")).toBeNull();
    for (const label of ["Allow", "Deny", "Revoke capability"]) {
      expect(screen.queryAllByRole("button", { name: label })).toHaveLength(0);
    }
  });

  it("names the folder the plugin came from", () => {
    render(<ProjectPluginDetailPane plugin={plugin({ state: "blocked", dirName: "dash" })} />);
    expect(document.body.textContent).toContain(".daintree/plugins/dash");
  });

  it("reports why an unreadable directory was rejected", () => {
    render(
      <ProjectPluginDetailPane
        plugin={plugin({ state: "invalid", error: "manifest.json is not valid JSON" })}
      />
    );
    expect(document.body.textContent).toContain("manifest.json is not valid JSON");
  });

  it("offers a reload for every state, including one that will not parse (#12212)", async () => {
    // `plugin:project-reload` and `projectPluginStore.reload` both shipped
    // unwired: switching projects and back was the only reload the UI had.
    for (const state of ["active", "blocked", "staged", "invalid"] as const) {
      render(<ProjectPluginDetailPane plugin={plugin({ state })} />);
      await act(async () => {
        button("Reload from folder").click();
      });
      cleanup();
      __resetProjectPluginStoreForTesting();
    }

    expect(reloadProjectPlugins).toHaveBeenCalledTimes(4);
  });

  it("offers the folder-level enable while the project is untrusted", async () => {
    render(<ProjectPluginDetailPane plugin={plugin({ state: "blocked" })} />);

    await act(async () => {
      button("Enable project plugins").click();
    });
    expect(setProjectPluginTrust).toHaveBeenCalledWith("enabled");
  });

  it("says a revoke unloads every project plugin, not just this one", async () => {
    act(() => {
      useProjectPluginStore.getState().applySnapshot({
        projectId: "proj-a",
        plugins: [plugin({ state: "active" })],
        trust: { projectId: "proj-a", decision: "enabled", enabled: true, persisted: true },
      });
    });
    render(<ProjectPluginDetailPane plugin={plugin({ state: "active" })} />);

    expect(document.body.textContent).toContain("not just this one");
    await act(async () => {
      button("Turn off project plugins").click();
    });
    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
  });

  describe("performance and styles", () => {
    function snapshotFor(pluginId: string, viewLoads: number) {
      return {
        pluginId,
        isolation: "worker" as const,
        activation: { lastMs: 90, count: 1, at: Date.now() },
        viewLoads: Array.from({ length: viewLoads }, () => ({
          kindId: `${pluginId}.main`,
          activateMs: 80,
          importMs: 30,
          stylesMs: 60,
          loadMs: 95,
          firstPaintMs: 120,
          retry: false,
          at: Date.now(),
        })),
        viewCommits: null,
        invokes: {
          count: 0,
          p50Ms: 0,
          p95Ms: 0,
          maxMs: 0,
          lastMs: 0,
          errors: 0,
          timeouts: 0,
          oversized: 0,
          promptWaits: 0,
        },
        pushes: {
          messages: 0,
          bytes: 0,
          perSecond: 0,
          bytesPerSecond: 0,
          peakPerSecond: 0,
          peakBytesPerSecond: 0,
          oversized: 0,
        },
        longFrames: { count: 0, totalBlockingMs: 0, lastAt: null },
        workerMemory: null,
        overBudget: [],
        since: Date.now(),
      };
    }

    function withSnapshots(snapshots: unknown[]) {
      const getPerfSnapshots = vi.fn(async () => snapshots);
      Object.defineProperty(window, "electron", {
        configurable: true,
        value: {
          plugin: {
            activateStagedProjectPlugin,
            setProjectPluginTrust,
            reloadProjectPlugins,
            getPerfSnapshots,
            onPerfSnapshotsChanged: () => () => {},
          },
        },
      });
      return getPerfSnapshots;
    }

    const INSTANCE = "project__proj-a__acme.dashboard";

    it("shows the instance's measurements, and a Styles check once a view has loaded", async () => {
      withSnapshots([snapshotFor("acme.dashboard", 1), snapshotFor(INSTANCE, 1)]);
      render(
        <ProjectPluginDetailPane plugin={plugin({ state: "active", instanceId: INSTANCE })} />
      );
      await screen.findByText("Performance");
      expect(screen.getByText("Styles")).toBeTruthy();
      expect(document.body.textContent).toContain("95ms");
    });

    it("offers no Styles check before any of its views has loaded", async () => {
      withSnapshots([snapshotFor(INSTANCE, 0)]);
      render(
        <ProjectPluginDetailPane plugin={plugin({ state: "active", instanceId: INSTANCE })} />
      );
      await screen.findByText("Performance");
      expect(screen.queryByText("Styles")).toBeNull();
    });

    it("shows nothing for a plugin with no instance key, even if the manifest id has numbers", async () => {
      const read = withSnapshots([snapshotFor("acme.dashboard", 1)]);
      render(<ProjectPluginDetailPane plugin={plugin({ state: "invalid" })} />);
      await act(async () => {
        await read.mock.results[0]?.value;
      });
      expect(screen.queryByText("Performance")).toBeNull();
    });
  });
});
