import { describe, expect, it, vi } from "vitest";

import { WorktreePortRegistry } from "../worktreePortRegistry.js";

function makePort(options: { throwOnPost?: boolean; throwOnClose?: boolean } = {}) {
  const onClose = new Set<() => void>();
  let closed = false;
  return {
    postMessage: vi.fn((_message: unknown) => {
      if (options.throwOnPost) throw new Error("DataCloneError");
    }),
    // Like Electron's MessagePortMain: the first close fires the port's own
    // close listeners synchronously; later ones do nothing.
    close: vi.fn(() => {
      if (options.throwOnClose) throw new Error("already closed");
      if (closed) return;
      closed = true;
      for (const listener of onClose) listener();
    }),
    onClose,
  };
}

type Port = ReturnType<typeof makePort>;

function attach(registry: WorktreePortRegistry<Port>, port: Port, portId: number): void {
  registry.add(port, portId);
  port.onClose.add(() => registry.forget(port));
}

describe("WorktreePortRegistry", () => {
  it("stops posting into a port Main retires and closes it (#17037)", () => {
    const registry = new WorktreePortRegistry<Port>();
    const retired = makePort();
    const live = makePort();
    attach(registry, retired, 1);
    attach(registry, live, 2);

    expect(registry.detach(1)).toBe(true);

    expect(retired.close).toHaveBeenCalledTimes(1);
    expect(retired.postMessage).toHaveBeenCalledTimes(1);
    expect(retired.postMessage).toHaveBeenCalledWith({ type: "port-retired" });
    expect(retired.postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      retired.close.mock.invocationCallOrder[0]!
    );
    expect(registry.ports).toEqual([live]);
    registry.fanout({ type: "worktree-update" });
    expect(retired.postMessage).toHaveBeenCalledTimes(1);
    expect(live.postMessage).toHaveBeenCalledTimes(1);
    expect(live.close).not.toHaveBeenCalled();
  });

  it("ignores an id it never held, such as one from the host's previous process", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort();
    attach(registry, port, 5);

    expect(registry.detach(4)).toBe(false);

    expect(port.close).not.toHaveBeenCalled();
    expect(registry.ports).toEqual([port]);
  });

  it("forgets the id of a port that closed on its own, so a late detach is a no-op", () => {
    const registry = new WorktreePortRegistry<Port>();
    const first = makePort();
    const middle = makePort();
    const last = makePort();
    attach(registry, first, 1);
    attach(registry, middle, 2);
    attach(registry, last, 3);

    last.close();
    expect(registry.ports).toEqual([first, middle]);

    expect(registry.detach(3)).toBe(false);
    expect(last.postMessage).not.toHaveBeenCalled();
    expect(registry.detach(1)).toBe(true);
    expect(registry.detach(2)).toBe(true);
  });

  it("forgets the id of a port the fan-out dropped, even when its close never fires", () => {
    const registry = new WorktreePortRegistry<Port>();
    const broken = makePort({ throwOnPost: true, throwOnClose: true });
    const healthy = makePort();
    attach(registry, broken, 3);
    attach(registry, healthy, 4);

    registry.fanout({ type: "worktree-update" }, { error: vi.fn() });

    expect(registry.ports).toEqual([healthy]);
    expect(healthy.postMessage).toHaveBeenCalledTimes(1);
    expect(registry.detach(3)).toBe(false);
  });

  it("closes the port an id named before when the id is reused", () => {
    const registry = new WorktreePortRegistry<Port>();
    const first = makePort();
    const second = makePort();
    attach(registry, first, 6);

    attach(registry, second, 6);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(registry.ports).toEqual([second]);
    // A late close of the displaced port cannot take the name from its replacement.
    registry.forget(first);
    expect(registry.detach(6)).toBe(true);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("has let the port go before closing it, so its close listener finds nothing", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort();
    registry.add(port, 9);
    const seenDuringClose: Array<{ listed: boolean; named: boolean }> = [];
    port.onClose.add(() => {
      seenDuringClose.push({
        listed: registry.ports.includes(port),
        named: registry.detach(9),
      });
    });

    expect(registry.detach(9)).toBe(true);

    expect(seenDuringClose).toEqual([{ listed: false, named: false }]);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("still removes a port whose close throws", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort({ throwOnClose: true });
    attach(registry, port, 11);

    expect(registry.detach(11)).toBe(true);
    expect(registry.ports).toEqual([]);
    expect(registry.detach(11)).toBe(false);
  });
});
