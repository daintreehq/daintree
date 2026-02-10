import { beforeEach, describe, expect, it, vi } from "vitest";

const checkDirectoryMock = vi.hoisted(() => vi.fn());
const checkCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    checkDirectory: checkDirectoryMock,
    checkCommand: checkCommandMock,
  },
}));

import { validateTerminalConfig, validateTerminals } from "../terminalValidation";

type TerminalShape = {
  id: string;
  type?: string;
  cwd?: string;
  agentId?: string;
};

function makeTerminal(overrides: Partial<TerminalShape> = {}): TerminalShape {
  return {
    id: "term-1",
    type: "terminal",
    cwd: undefined,
    agentId: undefined,
    ...overrides,
  };
}

describe("terminalValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkDirectoryMock.mockResolvedValue(true);
    checkCommandMock.mockResolvedValue(true);
  });

  it("returns valid result when cwd and agent CLI checks pass", async () => {
    const result = await validateTerminalConfig(
      makeTerminal({
        cwd: "/repo",
        type: "claude",
      }) as never
    );

    expect(result).toEqual({ valid: true, errors: [] });
    expect(checkDirectoryMock).toHaveBeenCalledWith("/repo");
    expect(checkCommandMock).toHaveBeenCalledWith("claude");
  });

  it("collects cwd and CLI errors in a single validation pass", async () => {
    checkDirectoryMock.mockResolvedValue(false);
    checkCommandMock.mockResolvedValue(false);

    const result = await validateTerminalConfig(
      makeTerminal({
        cwd: "/missing",
        type: "codex",
      }) as never
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "cwd",
        code: "ENOENT",
      }),
      expect.objectContaining({
        type: "cli",
      }),
    ]);
  });

  it("does not run CLI checks for plain terminal type", async () => {
    const result = await validateTerminalConfig(
      makeTerminal({
        cwd: "/repo",
        type: "terminal",
      }) as never
    );

    expect(result).toEqual({ valid: true, errors: [] });
    expect(checkDirectoryMock).toHaveBeenCalledTimes(1);
    expect(checkCommandMock).not.toHaveBeenCalled();
  });

  it("returns config error when cwd validation throws", async () => {
    checkDirectoryMock.mockRejectedValue(new Error("ipc unavailable"));

    const result = await validateTerminalConfig(
      makeTerminal({
        cwd: "/repo",
        type: "terminal",
      }) as never
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "config",
        recoverable: true,
      }),
    ]);
  });

  it("returns config error when CLI validation throws", async () => {
    checkCommandMock.mockRejectedValue(new Error("timeout"));

    const result = await validateTerminalConfig(
      makeTerminal({
        type: "gemini",
      }) as never
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "config",
        recoverable: true,
      }),
    ]);
  });

  it("validateTerminals returns only invalid terminals and keeps batch running", async () => {
    checkDirectoryMock.mockImplementation(async (cwd: string) => cwd !== "/missing");
    checkCommandMock.mockImplementation(async (agent: string) => agent !== "broken-agent");

    const results = await validateTerminals([
      makeTerminal({ id: "ok", cwd: "/repo", type: "terminal" }) as never,
      makeTerminal({ id: "bad-cwd", cwd: "/missing", type: "terminal" }) as never,
      makeTerminal({ id: "bad-cli", type: "broken-agent" }) as never,
    ]);

    expect(results.has("ok")).toBe(false);
    expect(results.get("bad-cwd")?.valid).toBe(false);
    expect(results.get("bad-cli")?.valid).toBe(false);
  });
});
