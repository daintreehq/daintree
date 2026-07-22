import { describe, expect, it, vi } from "vitest";
import { createPluginPtyHandlers } from "../pluginPty.js";
import type { HostContext } from "../types.js";

function makeCtx() {
  const pluginPtyManager = {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    disposeAll: vi.fn(),
  };
  const handlers = createPluginPtyHandlers({
    pluginPtyManager,
  } as unknown as HostContext);
  return { handlers, pluginPtyManager };
}

const SPAWN_OPTIONS = {
  command: "flutter",
  args: ["daemon", "--machine"],
  cwd: "/repo",
  env: { MY_FLAG: "1" },
  cols: 120,
  rows: 40,
};

describe("pluginPty handlers", () => {
  it("forwards a well-formed spawn verbatim", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-spawn"]!({
      type: "plugin-pty-spawn",
      id: "p1",
      generation: 2,
      options: SPAWN_OPTIONS,
    });
    expect(pluginPtyManager.spawn).toHaveBeenCalledWith("p1", 2, SPAWN_OPTIONS);
  });

  it("defaults missing geometry rather than spawning at zero", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-spawn"]!({
      type: "plugin-pty-spawn",
      id: "p1",
      generation: 0,
      options: { command: "sh" },
    });
    const config = pluginPtyManager.spawn.mock.calls[0]![2] as { cols: number; rows: number };
    // A PTY born at 0x0 renders nothing; the handler must substitute a usable size.
    expect(config.cols).toBeGreaterThan(0);
    expect(config.rows).toBeGreaterThan(0);
  });

  it("drops non-string args and non-string env values instead of forwarding them", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-spawn"]!({
      type: "plugin-pty-spawn",
      id: "p1",
      generation: 0,
      options: { command: "sh", args: ["ok", 5, null], env: { A: "1", B: 2 } },
    });
    const config = pluginPtyManager.spawn.mock.calls[0]![2] as {
      args: string[];
      env: Record<string, string>;
    };
    expect(config.args).toEqual(["ok"]);
    // A non-string env value would reach node-pty and throw inside the host.
    expect(config.env).toEqual({});
  });

  it.each([
    ["missing command", { generation: 0, id: "p1", options: {} }],
    ["empty command", { generation: 0, id: "p1", options: { command: "" } }],
    ["missing options", { generation: 0, id: "p1" }],
    ["missing id", { generation: 0, options: { command: "sh" } }],
    ["empty id", { generation: 0, id: "", options: { command: "sh" } }],
    ["fractional generation", { generation: 0.5, id: "p1", options: { command: "sh" } }],
  ])("refuses to spawn on a malformed payload: %s", (_label, msg) => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-spawn"]!({ type: "plugin-pty-spawn", ...msg });
    expect(pluginPtyManager.spawn).not.toHaveBeenCalled();
  });

  it("forwards write and ignores a non-string payload", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-write"]!({
      type: "plugin-pty-write",
      id: "p1",
      generation: 1,
      data: "q\n",
    });
    handlers["plugin-pty-write"]!({ type: "plugin-pty-write", id: "p1", generation: 1, data: 5 });
    expect(pluginPtyManager.write).toHaveBeenCalledTimes(1);
    expect(pluginPtyManager.write).toHaveBeenCalledWith("p1", 1, "q\n");
  });

  it("forwards resize with its generation", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    handlers["plugin-pty-resize"]!({
      type: "plugin-pty-resize",
      id: "p1",
      generation: 3,
      cols: 100,
      rows: 30,
    });
    expect(pluginPtyManager.resize).toHaveBeenCalledWith("p1", 3, 100, 30);
  });

  it("forwards only the two real signals", () => {
    const { handlers, pluginPtyManager } = makeCtx();
    for (const signal of ["SIGTERM", "SIGKILL", "SIGSTOP", "", undefined]) {
      handlers["plugin-pty-kill"]!({ type: "plugin-pty-kill", id: "p1", generation: 0, signal });
    }
    // A signal the manager does not model would fall through its switch.
    expect(pluginPtyManager.kill.mock.calls.map((c) => c[2])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("registers exactly the four plugin-pty message types", () => {
    const { handlers } = makeCtx();
    // Every registered key must be dispatchable by the pty-host router; an
    // unregistered type would be logged as unknown and silently dropped.
    expect(Object.keys(handlers).sort()).toEqual([
      "plugin-pty-kill",
      "plugin-pty-resize",
      "plugin-pty-spawn",
      "plugin-pty-write",
    ]);
  });
});
