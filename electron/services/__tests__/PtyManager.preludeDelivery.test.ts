import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { BufferedPtyDataHandoff } from "../PtyPool.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../pty/terminalSpawn.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    computeSpawnContext: vi.fn(() => ({
      shell: "/bin/zsh",
      args: ["-l"],
      env: {},
    })),
    acquirePtyProcess: vi.fn(),
  };
});

const { acquirePtyProcess } = await import("../pty/terminalSpawn.js");
const { PtyManager } = await import("../PtyManager.js");

const UPDATE_PROMPT = "[oh-my-zsh] Would you like to update? [Y/n] ";

function createMockPty(): { pty: IPty; emitLive: (data: string) => void } {
  let liveHandler: ((data: string) => void) | null = null;
  const pty = {
    pid: 4242,
    cols: 80,
    rows: 24,
    process: "zsh",
    handleFlowControl: false,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
    onData: vi.fn((handler: (data: string) => void) => {
      liveHandler = handler;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as IPty;
  return { pty, emitLive: (data) => liveHandler?.(data) };
}

// Real TerminalProcess and real BufferedPtyDataHandoff: the prelude replay and
// the handoff flush both run inside the constructor, before registration, which
// is exactly the window #12753 dropped.
describe("PtyManager.spawn — pooled-shell prelude reaches the data event", () => {
  let manager: InstanceType<typeof PtyManager>;
  let dataEvents: Array<[string, string]>;

  beforeEach(() => {
    manager = new PtyManager();
    dataEvents = [];
    manager.on("data", (id: string, data: string | Uint8Array) => {
      dataEvents.push([id, typeof data === "string" ? data : new TextDecoder().decode(data)]);
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  it("emits the prelude synchronously during spawn with no redraw", () => {
    const { pty } = createMockPty();
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: pty,
      prelude: UPDATE_PROMPT,
      dataHandoff: new BufferedPtyDataHandoff(),
    });

    manager.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24, kind: "terminal" });

    expect(dataEvents).toEqual([["t1", UPDATE_PROMPT]]);
  });

  it("orders prelude, handoff-buffered chunks, then live output under the new id", () => {
    const { pty } = createMockPty();
    const handoff = new BufferedPtyDataHandoff();
    handoff.handle("buffered-1 ");
    handoff.handle("buffered-2 ");
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: pty,
      prelude: "prelude ",
      dataHandoff: handoff,
    });

    manager.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24, kind: "terminal" });
    handoff.handle("live");

    expect(dataEvents.map(([, data]) => data).join("")).toBe(
      "prelude buffered-1 buffered-2 live"
    );
    expect(dataEvents.every(([id]) => id === "t1")).toBe(true);
  });

  it("delivers handoff-buffered chunks for a fresh spawn with an empty prelude", () => {
    const { pty } = createMockPty();
    const handoff = new BufferedPtyDataHandoff();
    handoff.handle("early output");
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: pty,
      prelude: "",
      dataHandoff: handoff,
    });

    manager.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24, kind: "terminal" });

    expect(dataEvents.map(([, data]) => data).join("")).toBe("early output");
  });

  it("delivers the prelude when the terminal belongs to the active project", () => {
    manager.setActiveProject("project-a");
    const { pty } = createMockPty();
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: pty,
      prelude: UPDATE_PROMPT,
      dataHandoff: new BufferedPtyDataHandoff(),
    });

    manager.spawn("t1", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      kind: "terminal",
      projectId: "project-a",
    });

    expect(dataEvents).toEqual([["t1", UPDATE_PROMPT]]);
  });

  it("still suppresses the prelude for a terminal outside the active project", () => {
    manager.setActiveProject("project-a");
    const { pty } = createMockPty();
    vi.mocked(acquirePtyProcess).mockReturnValue({
      ptyProcess: pty,
      prelude: UPDATE_PROMPT,
      dataHandoff: new BufferedPtyDataHandoff(),
    });

    manager.spawn("t1", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      kind: "terminal",
      projectId: "project-b",
    });

    expect(dataEvents).toEqual([]);
  });
});
