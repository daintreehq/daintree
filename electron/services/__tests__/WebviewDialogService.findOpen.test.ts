import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

interface MockView {
  id: number;
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  emit: (event: string) => void;
  destroy: () => void;
}

const views = vi.hoisted(() => new Map<number, MockView>());

function createView(id: number): MockView {
  let destroyed = false;
  const listeners = new Map<string, Listener[]>();
  const add = (event: string, listener: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const view: MockView = {
    id,
    isDestroyed: () => destroyed,
    on: vi.fn(add),
    once: vi.fn(add),
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    destroy: () => {
      destroyed = true;
      view.emit("destroyed");
    },
  };
  views.set(id, view);
  return view;
}

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn((id: number) => views.get(id)),
  },
}));

async function freshService() {
  vi.resetModules();
  const { getWebviewDialogService } = await import("../WebviewDialogService.js");
  return getWebviewDialogService();
}

describe("WebviewDialogService find bar state", () => {
  beforeEach(() => {
    views.clear();
  });

  it("holds a view's open find bar per panel until the view says it closed", async () => {
    createView(10);
    const service = await freshService();

    service.setFindOpen(10, "panel-a", true);
    expect(service.isFindOpen(10, "panel-a")).toBe(true);
    expect(service.isFindOpen(10, "panel-b")).toBe(false);

    service.setFindOpen(10, "panel-a", false);
    expect(service.isFindOpen(10, "panel-a")).toBe(false);
  });

  it("keeps one view's word from speaking for another view's panel", async () => {
    createView(10);
    createView(20);
    const service = await freshService();

    service.setFindOpen(10, "panel-a", true);
    service.setFindOpen(20, "panel-b", true);

    expect(service.isFindOpen(20, "panel-a")).toBe(false);
    expect(service.isFindOpen(10, "panel-b")).toBe(false);
    service.setFindOpen(20, "panel-b", false);
    expect(service.isFindOpen(10, "panel-a")).toBe(true);
  });

  it("forgets a view's bars when it reloads or goes away", async () => {
    const view = createView(10);
    const service = await freshService();

    service.setFindOpen(10, "panel-a", true);
    view.emit("did-navigate");
    expect(service.isFindOpen(10, "panel-a")).toBe(false);

    service.setFindOpen(10, "panel-a", true);
    view.destroy();
    expect(service.isFindOpen(10, "panel-a")).toBe(false);
  });

  it("listens to each view once, however often its bars open and close", async () => {
    const view = createView(10);
    const service = await freshService();

    for (let i = 0; i < 5; i++) {
      service.setFindOpen(10, "panel-a", true);
      service.setFindOpen(10, "panel-a", false);
      view.emit("did-navigate");
    }
    service.setFindOpen(10, "panel-a", true);
    expect(service.isFindOpen(10, "panel-a")).toBe(true);

    expect(view.once).toHaveBeenCalledTimes(1);
    expect(view.on).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a view that is already gone", async () => {
    const view = createView(10);
    view.destroy();
    const service = await freshService();

    service.setFindOpen(10, "panel-a", true);
    service.setFindOpen(11, "panel-a", true);

    expect(service.isFindOpen(10, "panel-a")).toBe(false);
    expect(service.isFindOpen(11, "panel-a")).toBe(false);
  });
});
