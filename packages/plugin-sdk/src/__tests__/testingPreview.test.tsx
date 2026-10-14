// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import type { PanelViewProps } from "../../../../shared/types/plugin.js";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../shared/types/plugin.js";
import { useHostChannel } from "../react/useHostChannel.js";
import { usePluginEvent, usePluginPanelEvent } from "../react/usePluginEvent.js";
import { subscribeViewIdle } from "../react/hostBridge.js";
import { HostDisconnectedError, OutcomeUnknownError } from "../react/hostErrors.js";
import {
  MAX_EXTENSION_STATE_BYTES,
  PREVIEW_FAILURE_ATTRIBUTE,
  PREVIEW_READY_ATTRIBUTE,
  PREVIEW_THEMES,
  applyPreviewTheme,
  createMockViewHost,
  createPreviewPanelController,
  hostResponses,
  listPanelStories,
  mountPanelStory,
  storyNameFromExport,
  type MountedPanelPreview,
  type PanelStoriesMeta,
  type PreviewStyleHost,
} from "../testing-preview.js";

const restores: Array<() => void> = [];
const mounted: MountedPanelPreview[] = [];

afterEach(() => {
  for (const preview of mounted.splice(0)) void act(() => preview.unmount());
  for (const restore of restores.splice(0)) restore();
  document.body.innerHTML = "";
});

function installed(options: Parameters<typeof createMockViewHost>[0] = {}) {
  const host = createMockViewHost(options);
  restores.push(host.install());
  return host;
}

describe("createMockViewHost — channels", () => {
  it("answers with a value or a function of the call's args, and records the call", async () => {
    const host = installed({
      channels: { greet: (args: unknown) => `hi ${(args as { name: string }).name}`, n: 42 },
    });
    const { result } = renderHook(() => useHostChannel<{ name: string }, string>("p", "greet"));
    let answer: string | undefined;
    await act(async () => {
      answer = await result.current.invoke({ name: "ada" });
    });
    expect(answer).toBe("hi ada");
    expect(host.invocations("greet")).toEqual([[{ name: "ada" }]]);
    expect(host.calls).toEqual([
      { kind: "invoke", pluginId: "p", channel: "greet", args: [{ name: "ada" }] },
    ]);
  });

  it("hands the view a copy, so mutating a result never reaches the fixture", async () => {
    const fixture = { items: [1] };
    const host = createMockViewHost({ channels: { list: fixture } });
    const first = (await host.bridges.plugin.invoke("p", "list")) as { items: number[] };
    first.items.push(2);
    expect(await host.bridges.plugin.invoke("p", "list")).toEqual({ items: [1] });
  });

  it("rejects a channel with no fixture", async () => {
    const host = createMockViewHost();
    await expect(host.bridges.plugin.invoke("p", "missing")).rejects.toThrow(/missing/);
  });

  it("serves only its own plugin when it is given one", async () => {
    const host = createMockViewHost({ pluginId: "acme.p", channels: { q: 1 } });
    await expect(host.bridges.plugin.invoke("acme.p", "q")).resolves.toBe(1);
    await expect(host.bridges.plugin.invoke("other.p", "q")).rejects.toThrow(/other\.p/);
    const mine = vi.fn();
    const theirs = vi.fn();
    host.bridges.plugin.on("acme.p", "tick", mine);
    host.bridges.plugin.on("other.p", "tick", theirs);
    expect(host.push("tick", 1)).toBe(1);
    expect(mine).toHaveBeenCalledWith(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it("delivers the host's failure shapes the way the SDK hooks receive them", async () => {
    const host = installed({ channels: { q: hostResponses.disconnected() } });
    const { result } = renderHook(() => useHostChannel("p", "q"));
    await act(async () => {
      await result.current.invoke(undefined);
    });
    expect(result.current.error).toBeInstanceOf(HostDisconnectedError);
    expect(result.current.disconnected).toBe(true);

    host.setChannel("q", hostResponses.outcomeUnknown());
    await act(async () => {
      await result.current.invoke(undefined);
    });
    expect(result.current.error).toBeInstanceOf(OutcomeUnknownError);

    host.setChannel("q", () => {
      throw hostResponses.schemaError("name is required");
    });
    await act(async () => {
      await result.current.invoke(undefined);
    });
    expect(result.current.error?.message).toBe("SCHEMA_ERROR: name is required");

    host.setChannel("q", hostResponses.permissionRequired("needs fs:project-read"));
    await act(async () => {
      await result.current.invoke(undefined);
    });
    expect(result.current.error?.message).toBe("PERMISSION_REQUIRED: needs fs:project-read");
    expect(result.current.disconnected).toBe(false);
  });

  it("holds a pending answer open", async () => {
    const host = createMockViewHost({ channels: { slow: hostResponses.pending() } });
    const settled = vi.fn();
    void host.bridges.plugin.invoke("p", "slow").then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();
  });
});

describe("createMockViewHost — events", () => {
  it("pushes broadcasts and per-panel events to the right subscribers", () => {
    const host = installed();
    const seen: string[] = [];
    renderHook(() => {
      usePluginEvent("p", "tick", (payload) => seen.push(`all:${String(payload)}`));
      usePluginPanelEvent("p", "tick", "panel-a", (payload) => seen.push(`a:${String(payload)}`));
    });

    void act(() => {
      expect(host.push("tick", 1)).toBe(1);
      expect(host.pushPanel("tick", "panel-a", 2)).toBe(1);
      expect(host.pushPanel("tick", "panel-b", 3)).toBe(0);
    });
    expect(seen).toEqual(["all:1", "a:2"]);
    expect(host.calls.map((call) => call.kind)).toEqual(["on", "onPanel"]);
  });

  it("drops a subscriber once its view unmounts", () => {
    const host = installed();
    const { unmount } = renderHook(() => usePluginEvent("p", "tick", () => {}));
    expect(host.subscriberCount("tick")).toBe(1);
    unmount();
    expect(host.subscriberCount("tick")).toBe(0);
  });

  it("keeps delivering when one subscriber throws", () => {
    const host = createMockViewHost();
    const received = vi.fn();
    host.bridges.plugin.on("p", "tick", () => {
      throw new Error("broken subscriber");
    });
    host.bridges.plugin.on("p", "tick", received);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(host.push("tick", "x")).toBe(2);
    expect(received).toHaveBeenCalledWith("x");
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("createMockViewHost — view lifecycle", () => {
  it("drives the cached and warm-activated edges the SDK pauses on", () => {
    const host = installed({ viewCached: true });
    const onChange = vi.fn();
    const idle = subscribeViewIdle(onChange);
    expect(idle.isIdle()).toBe(true);

    host.setViewCached(false);
    expect(idle.isIdle()).toBe(false);
    host.setViewCached(true);
    expect(idle.isIdle()).toBe(true);
    host.setViewCached(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    idle.dispose();
  });

  it("restores whatever was on globalThis.electron before it", () => {
    const original = { plugin: "real" };
    (globalThis as { electron?: unknown }).electron = original;
    const restore = createMockViewHost().install();
    expect((globalThis as { electron?: unknown }).electron).not.toBe(original);
    restore();
    restore();
    expect((globalThis as { electron?: unknown }).electron).toBe(original);
    delete (globalThis as { electron?: unknown }).electron;
  });
});

describe("createPreviewPanelController", () => {
  it("builds full PanelViewProps with the host's style root", () => {
    const panel = createPreviewPanelController({ pluginId: "acme.p", worktreeId: "wt" });
    const props = panel.props();
    expect(props.pluginId).toBe("acme.p");
    expect(props.worktreeId).toBe("wt");
    expect(props.styleRootAttributes[PLUGIN_STYLE_ROOT_ATTRIBUTE]).toBe("");
    expect(props.disposeSignal.aborted).toBe(false);
    expect(props.panelRemovedSignal.aborted).toBe(false);
    for (const callback of [
      props.persistState,
      props.requestReload,
      props.setHasUnsavedChanges,
      props.setToolbarItemState,
      props.setMenuItems,
    ]) {
      expect(typeof callback).toBe("function");
    }
    expect(createPreviewPanelController({ withoutHostCallbacks: true }).props().persistState).toBe(
      undefined
    );
  });

  it("persists with the host's rules and hands the next attempt what was accepted", () => {
    const panel = createPreviewPanelController({
      initialArgs: { keep: 1 },
      initialStateVersion: 1,
      stateVersion: 2,
    });
    const first = panel.props();
    expect(first.initialArgs).toEqual({ keep: 1 });
    expect(first.stateVersion).toBe(1);

    expect(first.persistState?.({ when: new Date(0) })).toBe(true);
    expect(first.persistState?.({ big: "x".repeat(MAX_EXTENSION_STATE_BYTES) })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(first.persistState?.({ cyclic })).toBe(false);
    expect(panel.persistCalls.map((call) => (call.accepted ? "ok" : call.reason))).toEqual([
      "ok",
      "too-large",
      "not-serializable",
    ]);

    const second = panel.props();
    // Aborted after the outgoing view's cleanups, not when the next attempt starts.
    expect(first.disposeSignal.aborted).toBe(false);
    panel.retirePreviousAttempts();
    expect(first.disposeSignal.aborted).toBe(true);
    expect(second.disposeSignal.aborted).toBe(false);
    expect(second.initialArgs).toEqual({ keep: 1, when: "1970-01-01T00:00:00.000Z" });
    expect(second.stateVersion).toBe(2);
  });

  it("ignores setters from an attempt that has been torn down", () => {
    const panel = createPreviewPanelController();
    const first = panel.props();
    first.setHasUnsavedChanges?.(true);
    first.setMenuItems?.([{ actionId: "acme.p.run" }]);
    first.setToolbarItemState?.("acme.p.run", { disabled: true });
    expect(panel.hasUnsavedChanges).toBe(true);
    expect(panel.menuItems).toEqual([{ actionId: "acme.p.run" }]);
    expect(panel.toolbarItems.get("acme.p.run")).toEqual({ disabled: true });

    panel.props();
    first.requestReload?.();
    first.setHasUnsavedChanges?.(true);
    expect(panel.reloadRequests).toBe(0);
    expect(panel.hasUnsavedChanges).toBe(false);
  });

  it("aborts panelRemovedSignal only when the panel is removed", () => {
    const panel = createPreviewPanelController();
    const props = panel.props();
    panel.disposeAttempt();
    expect(props.disposeSignal.aborted).toBe(true);
    expect(props.panelRemovedSignal.aborted).toBe(false);
    panel.removePanel();
    expect(props.panelRemovedSignal.aborted).toBe(true);
  });
});

describe("applyPreviewTheme", () => {
  it("offers all 15 built-in themes", () => {
    expect(PREVIEW_THEMES).toHaveLength(15);
    expect(new Set(PREVIEW_THEMES.map((theme) => theme.id)).size).toBe(15);
  });

  it("switches in place, dropping variables the previous theme set", () => {
    const root = document.createElement("div");
    const dark = PREVIEW_THEMES.find((theme) => theme.type === "dark")!;
    const light = PREVIEW_THEMES.find((theme) => theme.type === "light")!;
    root.style.setProperty("--stale", "1");
    root.dataset.themeVariableKeys = "--stale";

    applyPreviewTheme(root, dark.id);
    expect(root.style.getPropertyValue("--stale")).toBe("");
    expect(root.classList.contains("dark")).toBe(true);
    const darkCanvas = root.style.getPropertyValue("--theme-surface-canvas");
    expect(darkCanvas).not.toBe("");

    applyPreviewTheme(root, light.id);
    expect(root.dataset.theme).toBe(light.id);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("light")).toBe(true);
    expect(root.style.getPropertyValue("--theme-surface-canvas")).not.toBe(darkCanvas);
  });

  it("refuses an unknown theme rather than falling back", () => {
    expect(() => applyPreviewTheme(document.createElement("div"), "nope")).toThrow(/nope/);
  });
});

describe("stories", () => {
  it("names stories the CSF way and lists them in export order", () => {
    expect(storyNameFromExport("PopulatedWithErrors")).toBe("Populated With Errors");
    expect(storyNameFromExport("loading_state")).toBe("loading state");
    const module = {
      default: { component: () => null },
      Empty: {},
      Loading: { name: "Still loading" },
      helper: "not a story",
    };
    expect(listPanelStories(module).map((story) => story.name)).toEqual(["Empty", "Still loading"]);
  });
});

function Counter({ pluginId, initialArgs, persistState }: PanelViewProps) {
  const [count, setCount] = useState(() => Number(initialArgs?.["count"] ?? 0));
  const [label, setLabel] = useState<string>();
  const { invoke } = useHostChannel<undefined, string>(pluginId, "label");
  usePluginEvent(pluginId, "bump", () => setCount((value) => value + 1));
  useEffect(() => {
    void invoke(undefined).then(setLabel);
  }, [invoke]);
  useEffect(() => {
    persistState?.({ count });
  }, [count, persistState]);
  return (
    <p data-testid="counter" className="p-2">
      {`${label ?? "…"}: ${count}`}
    </p>
  );
}

const counterMeta = {
  component: Counter,
  fixtures: { channels: { label: "Count" } },
} satisfies PanelStoriesMeta;

function container(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

async function mount(...args: Parameters<typeof mountPanelStory>) {
  let preview!: MountedPanelPreview;
  await act(async () => {
    preview = mountPanelStory(...args);
  });
  mounted.push(preview);
  return preview;
}

describe("mountPanelStory", () => {
  it("mounts a story, runs play, and publishes readiness on the page", async () => {
    const target = container();
    const preview = await mount(
      counterMeta,
      {
        args: { initialArgs: { count: 2 } },
        play: ({ host }) => {
          host.push("bump", null);
        },
      },
      { container: target }
    );
    await act(async () => {
      expect(await preview.ready).toEqual({ status: "ready" });
    });
    expect(target.getAttribute(PREVIEW_READY_ATTRIBUTE)).toBe("ready");
    expect(document.documentElement.getAttribute(PREVIEW_READY_ATTRIBUTE)).toBe("ready");
    expect(target.querySelector("[data-testid=counter]")?.textContent).toBe("Count: 3");
    expect(preview.canvasElement.hasAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE)).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("daintree");
  });

  it("brings back persisted state on a remount", async () => {
    const preview = await mount(counterMeta, undefined, { container: container() });
    await act(async () => {
      preview.host.push("bump", null);
      await preview.ready;
    });
    let remounted!: Promise<unknown>;
    void act(() => {
      remounted = preview.remount();
    });
    await act(async () => {
      await remounted;
    });
    expect(preview.panel.persistedState).toEqual({ count: 1 });
    expect(preview.canvasElement.textContent).toBe("Count: 1");
  });

  it("waits for the kit and the styles before it is ready", async () => {
    let releaseKit!: () => void;
    const kit = { ready: new Promise<void>((resolve) => (releaseKit = resolve)) };
    const registered: Element[] = [];
    const styles: PreviewStyleHost = {
      registerRoot: (root) => {
        registered.push(root);
        return () => {};
      },
      settled: () => Promise.resolve(),
      failure: () => null,
    };
    const target = container();
    const preview = await mount(counterMeta, undefined, { container: target, kit, styles });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(target.hasAttribute(PREVIEW_READY_ATTRIBUTE)).toBe(false);
    expect(registered).toEqual([preview.canvasElement]);

    releaseKit();
    await act(async () => {
      expect(await preview.ready).toEqual({ status: "ready" });
    });
  });

  it("reports failed, not ready, when styles did not install", async () => {
    const target = container();
    const preview = await mount(counterMeta, undefined, {
      container: target,
      styles: {
        registerRoot: () => () => {},
        failure: () => "simulated build failure",
      },
    });
    await act(async () => {
      expect(await preview.ready).toEqual({
        status: "failed",
        reason: "styles failed to install: simulated build failure",
      });
    });
    expect(target.getAttribute(PREVIEW_READY_ATTRIBUTE)).toBe("failed");
    expect(target.getAttribute(PREVIEW_FAILURE_ATTRIBUTE)).toMatch(/simulated build failure/);
  });

  it("switches theme in place and re-settles", async () => {
    const preview = await mount(counterMeta, undefined, { container: container() });
    const light = PREVIEW_THEMES.find((theme) => theme.type === "light")!;
    await act(async () => {
      await preview.ready;
      expect(await preview.setTheme(light.id)).toEqual({ status: "ready" });
    });
    expect(preview.theme.id).toBe(light.id);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(preview.canvasElement.textContent).toBe("Count: 0");
  });

  it("reports a view that throws while rendering as failed", async () => {
    // Outside the act environment: `act()` rethrows a render error itself,
    // where a real page hears of it only through the root's error callback.
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const preview = mountPanelStory(
        {
          component: () => {
            throw new Error("view exploded");
          },
        },
        undefined,
        { container: container() }
      );
      mounted.push(preview);
      expect(await preview.ready).toEqual({
        status: "failed",
        reason: "story did not mount: view exploded",
      });
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
      consoleError.mockRestore();
    }
  });

  it("takes ready back when styles fail after the page was ready", async () => {
    let failure: string | null = null;
    let notify: (() => void) | undefined;
    const target = container();
    const preview = await mount(counterMeta, undefined, {
      container: target,
      styles: {
        registerRoot: () => () => {},
        failure: () => failure,
        subscribe: (listener) => {
          notify = listener;
          return () => {
            notify = undefined;
          };
        },
      },
    });
    await act(async () => {
      await preview.ready;
    });
    expect(target.getAttribute(PREVIEW_READY_ATTRIBUTE)).toBe("ready");
    failure = "rebuild: late class";
    notify?.();
    expect(target.getAttribute(PREVIEW_READY_ATTRIBUTE)).toBe("failed");
    expect(target.getAttribute(PREVIEW_FAILURE_ATTRIBUTE)).toMatch(/late class/);
  });

  it("leaves the page untouched when the theme is unknown", () => {
    expect(() =>
      mountPanelStory(counterMeta, undefined, { container: container(), theme: "nope" })
    ).toThrow(/nope/);
    expect((globalThis as { electron?: unknown }).electron).toBeUndefined();
  });

  it("takes the bridges off the page and aborts the attempt on unmount", async () => {
    const target = container();
    const preview = await mount(counterMeta, undefined, { container: target });
    await act(async () => {
      await preview.ready;
    });
    void act(() => preview.unmount());
    mounted.splice(mounted.indexOf(preview), 1);
    expect((globalThis as { electron?: unknown }).electron).toBeUndefined();
    expect(target.hasAttribute(PREVIEW_READY_ATTRIBUTE)).toBe(false);
    expect(preview.host.subscriberCount("bump")).toBe(0);
  });
});
