/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewToolSessionContext } from "@/services/devPreviewTools/types";
import { usePanelStore } from "@/store/panelStore";
import { __resetComposerMemoryForTests } from "../composerMemory";
import {
  createElementPickerSession,
  type InspectorController,
  type InspectorDeps,
  type ViewLifecycleApi,
} from "../inspectorController";
import { createFakeHost, type FakeHost } from "./testHost";

let host: FakeHost;
let uninstall: () => void;
let controller: InspectorController | null = null;

function context(visible: boolean): DevPreviewToolSessionContext {
  return {
    panelId: "preview-1",
    projectId: "p1",
    worktreeId: "wt-1",
    worktreePath: "/repo",
    url: "http://localhost:5173/",
    isWebviewReady: true,
    visible,
    signal: new AbortController().signal,
    close: () => {},
  };
}

function fakeLifecycle() {
  let observable = true;
  const listeners = new Set<() => void>();
  let flush: (() => Promise<unknown>) | null = null;
  const api: ViewLifecycleApi = {
    isObservable: () => observable,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCachedFlush: (next) => {
      flush = next;
      return () => {
        flush = null;
      };
    },
  };
  return {
    api,
    set(next: boolean) {
      observable = next;
      for (const listener of [...listeners]) listener();
    },
    cache: () => flush?.(),
    subscribed: () => listeners.size > 0 || flush !== null,
  };
}

function open(visible: boolean, lifecycle = fakeLifecycle()) {
  const deps = {
    picker: host.picker,
    preview: host.preview,
    now: () => 0,
    viewLifecycle: lifecycle.api,
  } as unknown as InspectorDeps;
  controller = createElementPickerSession(context(visible), () => deps);
  return lifecycle;
}

async function bound() {
  await vi.waitFor(() => expect(controller?.getSnapshot().binding.status).toBe("bound"));
}

function pauses(): boolean[] {
  return host.preview.setPaused.mock.calls.map(([request]) => request.paused);
}

beforeEach(() => {
  usePanelStore.setState({
    panelIds: ["preview-1"],
    panelsById: { "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid" } },
  } as never);
  host = createFakeHost();
  uninstall = host.install();
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
  __resetComposerMemoryForTests();
  uninstall();
});

describe("Element Picker pausing out of sight (#17067)", () => {
  it("pauses the page while no surface is mounted, and resumes when one is", async () => {
    open(false);
    await bound();
    expect(host.preview.setPaused).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      paused: true,
    });

    controller!.update(context(true));
    controller!.update(context(true));
    controller!.update(context(false));

    // Told only when it changes what the page was last told.
    expect(pauses()).toEqual([true, false, true]);
  });

  it("tells a page that binds on screen nothing", async () => {
    open(true);
    await bound();
    controller!.update(context(true));

    expect(host.preview.setPaused).not.toHaveBeenCalled();
  });

  it("pauses while the project view is cached or its window hidden", async () => {
    const lifecycle = open(true);
    await bound();

    lifecycle.set(false);
    // A surface mounting behind a cached view does not wake the page.
    controller!.update(context(true));
    lifecycle.set(true);

    expect(pauses()).toEqual([true, false]);
  });

  it("has the pause on its way before main can freeze a cached view", async () => {
    const lifecycle = open(true);
    await bound();
    let delivered = false;
    host.preview.setPaused.mockImplementationOnce(async () => {
      await Promise.resolve();
      delivered = true;
    });

    // The flush runs before the view reads as cached, and main holds the
    // freeze until it settles.
    await lifecycle.cache();

    expect(delivered).toBe(true);
    expect(pauses()).toEqual([true]);
    lifecycle.set(false);
    expect(pauses()).toEqual([true]);
  });

  it("stops hearing the view's lifecycle once switched off", async () => {
    const lifecycle = open(true);
    await bound();

    controller!.dispose();

    expect(lifecycle.subscribed()).toBe(false);
  });
});
