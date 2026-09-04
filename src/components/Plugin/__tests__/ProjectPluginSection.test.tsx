// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginDetailPane, ProjectPluginSection } from "../ProjectPluginSection";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type { ProjectPluginInfo, ProjectPluginState } from "@shared/types/plugin";

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

    const options = screen.getAllByRole("option");
    // The section header is a disabled option (LESSON #9006), then the rows.
    expect(options).toHaveLength(3);
    const rows = options.slice(1).map((el) => el.textContent ?? "");
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

    screen.getAllByRole("option")[1]?.click();
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
      button("Enable for this project").click();
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
});
