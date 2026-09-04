// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginIndicator } from "../ProjectPluginIndicator";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type {
  ProjectPluginInfo,
  ProjectPluginState,
  ProjectPluginTrustState,
} from "@shared/types/plugin";

const PROJECT = "proj-a";

const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();
const activateStagedProjectPlugin = vi.fn<(pluginId: string) => Promise<void>>();
const reloadProjectPlugins = vi.fn<() => Promise<void>>();

function plugin(
  id: string,
  state: ProjectPluginState,
  extra: Partial<ProjectPluginInfo> = {}
): ProjectPluginInfo {
  return {
    projectId: PROJECT,
    id,
    displayName: id,
    version: "1.0.0",
    capabilities: [],
    dirName: id,
    state,
    collidesWithGlobal: false,
    ...extra,
  };
}

function snapshot(plugins: ProjectPluginInfo[], trust: Partial<ProjectPluginTrustState> = {}) {
  act(() => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins,
      trust: { projectId: PROJECT, decision: null, enabled: false, persisted: false, ...trust },
    });
  });
}

beforeEach(() => {
  setProjectPluginTrust.mockReset().mockResolvedValue(undefined);
  activateStagedProjectPlugin.mockReset().mockResolvedValue(undefined);
  reloadProjectPlugins.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      plugin: { setProjectPluginTrust, activateStagedProjectPlugin, reloadProjectPlugins },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

describe("ProjectPluginIndicator", () => {
  it("shows nothing when every plugin is running", () => {
    const { container } = render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active")], { decision: "enabled", enabled: true });
    expect(container.textContent).toBe("");
  });

  it("surfaces an unreadable manifest, which used to render nowhere at all", () => {
    // #12212: the visibility gate only counted blocked and staged rows, so a
    // project whose only plugin would not parse showed no indicator anywhere.
    render(<ProjectPluginIndicator />);
    snapshot([plugin("broken", "invalid", { error: "authors: expected array" })]);

    expect(document.body.textContent).toContain("1 project plugin unreadable");
  });

  it("leads with unreadable when plugins are also merely off", () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("broken", "invalid", { error: "bad" }), plugin("a.b", "blocked")]);

    expect(document.body.textContent).toContain("unreadable");
    expect(document.body.textContent).not.toContain("project plugins off");
  });

  it("names the reason in the popover, so the fix is where the fault is", async () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("broken", "invalid", { error: 'Unrecognized key: "author"' })]);

    await act(async () => {
      screen.getByRole("button", { name: /Project plugins/ }).click();
    });

    expect(document.body.textContent).toContain('Unrecognized key: "author"');
  });

  it("offers a reload, so a fixed manifest does not need a project switch", async () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("broken", "invalid", { error: "bad" })]);

    await act(async () => {
      screen.getByRole("button", { name: /Project plugins/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Reload from folder" }).click();
    });

    expect(reloadProjectPlugins).toHaveBeenCalledTimes(1);
  });
});
