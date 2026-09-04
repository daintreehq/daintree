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
    muted: false,
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
    snapshot([plugin("a.b", "active")], {
      decision: "enabled",
      enabled: true,
      persisted: true,
    });
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

  it("holds a decision that applied but never reached disk (#12212)", async () => {
    // A failed "always enable" still STARTS the plugins, so every row goes
    // active and the rejected call's error has nowhere else to appear.
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active")], { decision: "enabled", enabled: true, persisted: false });

    expect(document.body.textContent).toContain("not saved");
  });

  it("stays quiet once the decision is on disk", () => {
    const { container } = render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active")], { decision: "enabled", enabled: true, persisted: true });
    expect(container.textContent).toBe("");
  });

  it("does not read a session grant as a failed write", () => {
    // `session` is memory-only by contract — `persisted: false` is correct
    // there and must not be reported as a fault.
    const { container } = render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active")], { decision: "session", enabled: true, persisted: false });
    expect(container.textContent).toBe("");
  });

  it("offers a retry for the write that failed", async () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active")], { decision: "enabled", enabled: true, persisted: false });

    await act(async () => {
      screen.getByRole("button", { name: /Project plugins/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    expect(setProjectPluginTrust).toHaveBeenCalledWith("enabled");
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

  it("appears for an active plugin whose last run failed", () => {
    // #12232: the row stays `active` and nothing else about it moved, so
    // without the failure in the visibility gate this project would show no
    // way back in at all.
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active", { loadError: { message: "activate() threw", at: 1 } })], {
      decision: "enabled",
      enabled: true,
      persisted: true,
    });

    expect(document.body.textContent).toContain("1 project plugin failed");
  });

  it("leads with a failure over decisions the user already made", () => {
    render(<ProjectPluginIndicator />);
    snapshot([
      plugin("a.b", "blocked"),
      plugin("c.d", "active", { loadError: { message: "activate() threw", at: 1 } }),
    ]);

    expect(document.body.textContent).toContain("1 project plugin failed");
    expect(document.body.textContent).not.toContain("project plugins off");
  });

  it("leads with a failure over an unreadable manifest", () => {
    // A row that says "Running" and is not is the one this widget has to
    // correct; "Unreadable" already names itself on its own row.
    render(<ProjectPluginIndicator />);
    snapshot([
      plugin("broken", "invalid", { error: "authors: expected array" }),
      plugin("c.d", "active", { loadError: { message: "activate() threw", at: 1 } }),
    ]);

    expect(document.body.textContent).toContain("1 project plugin failed");
    expect(document.body.textContent).not.toContain("unreadable");
  });

  it("still leads with a decision that never reached disk", () => {
    // #12212 ranked `unsaved` first because nothing else can carry it. A
    // failure has the popover row, the Project > Plugins tab and the plugin
    // manager; the unwritten decision has only this line.
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active", { loadError: { message: "activate() threw", at: 1 } })], {
      decision: "enabled",
      enabled: true,
      persisted: false,
    });

    expect(document.body.textContent).toContain("not saved");
  });

  it("still summarises blocked plugins when nothing failed", () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "blocked"), plugin("c.d", "blocked")]);

    expect(document.body.textContent).toContain("2 project plugins off");
  });

  it("calls a failed row Error rather than Running, and names the cause", async () => {
    render(<ProjectPluginIndicator />);
    snapshot([plugin("a.b", "active", { loadError: { message: "Cannot find module x", at: 1 } })], {
      decision: "enabled",
      enabled: true,
      persisted: true,
    });

    await act(async () => {
      screen.getByRole("button", { name: /Project plugins/ }).click();
    });

    expect(document.body.textContent).toContain("Cannot find module x");
    expect(document.body.textContent).not.toContain("Running");
  });
});
