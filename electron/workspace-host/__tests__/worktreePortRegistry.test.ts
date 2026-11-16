import { describe, expect, it, vi } from "vitest";

import { fanoutEventToPorts } from "../worktreePortFanout.js";
import { WorktreePortRegistry } from "../worktreePortRegistry.js";

function makePort(options: { throwOnPost?: boolean; throwOnClose?: boolean } = {}) {
  const onClose = new Set<() => void>();
  return {
    postMessage: vi.fn(() => {
      if (options.throwOnPost) throw new Error("DataCloneError");
    }),
    close: vi.fn(() => {
      if (options.throwOnClose) throw new Error("already closed");
      for (const listener of onClose) listener();
    }),
    onClose,
  };
}

type Port = ReturnType<typeof makePort>;

function attach(registry: WorktreePortRegistry<Port>, port: Port, portId?: number): void {
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
    expect(registry.ports).toEqual([live]);
    fanoutEventToPorts(registry.ports, { type: "worktree-update" });
    expect(retired.postMessage).not.toHaveBeenCalled();
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
    const port = makePort();
    attach(registry, port, 7);

    port.close();
    expect(registry.ports).toEqual([]);

    expect(registry.detach(7)).toBe(false);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("forgets the id of a port the fan-out dropped after a failed post", () => {
    const registry = new WorktreePortRegistry<Port>();
    const broken = makePort({ throwOnPost: true });
    attach(registry, broken, 3);

    fanoutEventToPorts(registry.ports, { type: "worktree-update" }, { error: vi.fn() });

    expect(registry.ports).toEqual([]);
    expect(registry.detach(3)).toBe(false);
  });

  it("detaches only once, even when the port's close re-enters the registry", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort();
    attach(registry, port, 9);

    expect(registry.detach(9)).toBe(true);
    expect(registry.detach(9)).toBe(false);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("still removes a port whose close throws", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort({ throwOnClose: true });
    attach(registry, port, 11);

    expect(registry.detach(11)).toBe(true);
    expect(registry.ports).toEqual([]);
  });

  it("keeps an unnamed port in the fan-out until it closes", () => {
    const registry = new WorktreePortRegistry<Port>();
    const port = makePort();
    attach(registry, port);

    expect(registry.ports).toEqual([port]);
    port.close();
    expect(registry.ports).toEqual([]);
  });
});
