import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;
const existingFiles = new Set<string>();
// Paths whose stat never settles, as on a dead network mount.
const hangingFiles = new Set<string>();

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async (filePath: string) => {
      if (hangingFiles.has(filePath)) await new Promise(() => {});
      if (!existingFiles.has(filePath)) throw new Error("ENOENT");
      return { isFile: () => true };
    }),
  };
});

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      ptyWriteMock(data);
    },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

type AgentStateService = ConstructorParameters<typeof TerminalProcess>[3]["agentStateService"];

function createAgentTerminal(agentId: string | undefined): TerminalProcess {
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const terminal = new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      ...(agentId ? { launchAgentId: agentId } : {}),
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: { handleActivityState: () => {} } as unknown as AgentStateService,
      ptyPool: null,
      processTreeCache: null,
    },
    ctx,
    createMockPty()
  );
  if (agentId) {
    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string } }
    ).terminalInfo.detectedAgentId = agentId;
  }
  return terminal;
}

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const writes = () => ptyWriteMock.mock.calls.map((call) => call[0]);

describe("TerminalProcess.submit with image paths (#12792)", () => {
  const shot = "/Users/me/Screen Shot 1.png";
  const other = "/Users/me/diagram.jpg";

  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock = vi.fn<(data: string) => void>();
    existingFiles.clear();
    hangingFiles.clear();
    existingFiles.add(shot);
    existingFiles.add(other);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["claude", "codex"])(
    "pastes each image alone, in order, then submits once for %s",
    async (agentId) => {
      const terminal = createAgentTerminal(agentId);

      terminal.submit(`look at ${shot} and ${other} please`, undefined, undefined, undefined, [
        shot,
        other,
      ]);
      await vi.advanceTimersByTimeAsync(5000);

      expect(writes()).toEqual([
        paste("look at "),
        paste(shot),
        paste(" and "),
        paste(other),
        paste(" please"),
        "\r",
      ]);
    }
  );

  it("spaces the pastes so no two land in the same tick", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit(`${shot} ${other}`, undefined, undefined, undefined, [shot, other]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([paste(shot)]);

    await vi.advanceTimersByTimeAsync(199);
    expect(writes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes()).toEqual([paste(shot), paste(" ")]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(writes()).toEqual([paste(shot), paste(" "), paste(other), "\r"]);
  });

  it("keeps a missing file as plain text", async () => {
    const terminal = createAgentTerminal("claude");
    const missing = "/Users/me/gone.png";

    terminal.submit(`see ${missing}`, undefined, undefined, undefined, [missing]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([`see ${missing}`, "\r"]);
  });

  it("delivers only the images that exist, leaving the rest in the text", async () => {
    const terminal = createAgentTerminal("claude");
    const missing = "/Users/me/gone.png";

    terminal.submit(`${missing} ${shot}`, undefined, undefined, undefined, [missing, shot]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(`${missing} `), paste(shot), "\r"]);
  });

  it.each([["gemini"], ["copilot"], [undefined]])(
    "leaves the submission untouched for %s, which has no verified image protocol",
    async (agentId) => {
      const terminal = createAgentTerminal(agentId);

      terminal.submit(`see ${shot}`, undefined, undefined, undefined, [shot]);
      await vi.advanceTimersByTimeAsync(5000);

      const sent = writes();
      expect(sent[0]).toBe(`see ${shot}`);
      expect(sent[sent.length - 1]).toBe("\r");
    }
  );

  it("abandons the remaining pastes and the Enter when a shutdown takes the input", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit(`${shot} ${other}`, undefined, undefined, undefined, [shot, other]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([paste(shot)]);

    (
      terminal as unknown as { inputController: { acquireShutdownInputLock: () => () => void } }
    ).inputController.acquireShutdownInputLock();
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(shot)]);
  });

  it("gives up on a stat that never settles and sends the text as it was", async () => {
    const terminal = createAgentTerminal("claude");
    const stuck = "/Volumes/dead/shot.png";
    hangingFiles.add(stuck);

    terminal.submit(`see ${stuck}`, undefined, undefined, undefined, [stuck]);
    await vi.advanceTimersByTimeAsync(999);
    expect(writes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes()).toEqual([`see ${stuck}`]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes()).toEqual([`see ${stuck}`, "\r"]);
  });

  it("writes nothing when a shutdown lock comes and goes while the stat is pending", async () => {
    const terminal = createAgentTerminal("claude");
    const stuck = "/Volumes/dead/shot.png";
    hangingFiles.add(stuck);

    terminal.submit(`see ${stuck}`, undefined, undefined, undefined, [stuck]);
    await vi.advanceTimersByTimeAsync(500);
    const release = (
      terminal as unknown as { inputController: { acquireShutdownInputLock: () => () => void } }
    ).inputController.acquireShutdownInputLock();
    release();
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([]);
  });

  it("stops pasting and never submits once the agent exits mid-sequence", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit(`${shot} ${other}`, undefined, undefined, undefined, [shot, other]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([paste(shot)]);

    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string | undefined } }
    ).terminalInfo.detectedAgentId = undefined;
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(shot)]);
  });

  it("stops once the same agent is relaunched mid-sequence", async () => {
    const terminal = createAgentTerminal("claude");
    const info = (terminal as unknown as { terminalInfo: { agentIncarnation: number } })
      .terminalInfo;

    terminal.submit(`${shot} ${other}`, undefined, undefined, undefined, [shot, other]);
    await vi.advanceTimersByTimeAsync(0);
    info.agentIncarnation += 1;
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(shot)]);
  });

  it("never submits the text fallback once the agent exits during the stat", async () => {
    const terminal = createAgentTerminal("claude");
    const stuck = "/Volumes/dead/shot.png";
    hangingFiles.add(stuck);

    terminal.submit(`see ${stuck}`, undefined, undefined, undefined, [stuck]);
    await vi.advanceTimersByTimeAsync(500);
    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string | undefined } }
    ).terminalInfo.detectedAgentId = undefined;
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([]);
  });

  it("submits an image-only body as the paste and one Enter", async () => {
    const terminal = createAgentTerminal("codex");

    terminal.submit(`${shot}\n`, undefined, undefined, undefined, [shot]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(shot), "\r"]);
  });

  it("serialises a following submission behind the paced one", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit(`${shot} ${other}`, undefined, undefined, undefined, [shot, other]);
    terminal.submit("next");
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes()).toEqual([paste(shot), paste(" "), paste(other), "\r", "next", "\r"]);
  });
});
