import { describe, expect, it } from "vitest";
import type { ProcessInventoryTerminal, ProcessTreeSample } from "@shared/types/processes";
import {
  describeMembers,
  describeTerminalKind,
  formatApproxMemory,
  groupTerminalsByProject,
  pluginProcessTitle,
  terminalTitle,
  trashSecondsLeft,
} from "../processesView";

function terminal(
  id: string,
  extra: Partial<ProcessInventoryTerminal> = {}
): ProcessInventoryTerminal {
  return {
    id,
    projectId: null,
    projectName: null,
    cwd: "/",
    isAssistantTerminal: false,
    spawnedAt: 1,
    isTrashed: false,
    rootPid: 1,
    sample: null,
    ...extra,
  };
}

function sample(memoryKb: number, members: Array<[string, number]> = []): ProcessTreeSample {
  return {
    cpuPercent: 0,
    memoryKb,
    processCount: members.length || 1,
    members: members.map(([comm, kb], i) => ({ pid: i + 1, comm, cpuPercent: 0, memoryKb: kb })),
  };
}

describe("processesView", () => {
  it("groups by project, alphabetical, with unowned terminals last and heaviest first", () => {
    const groups = groupTerminalsByProject([
      terminal("free"),
      terminal("c-light", { projectId: "c", projectName: "Cedar", sample: sample(10) }),
      terminal("b", { projectId: "b", projectName: "Birch" }),
      terminal("c-heavy", { projectId: "c", projectName: "Cedar", sample: sample(900) }),
      terminal("c-unsampled", { projectId: "c", projectName: "Cedar" }),
      terminal("gone", { projectId: "x" }),
    ]);

    expect(groups.map((g) => [g.label, g.terminals.map((t) => t.id)])).toEqual([
      ["Birch", ["b"]],
      ["Cedar", ["c-heavy", "c-light", "c-unsampled"]],
      ["Unknown project", ["gone"]],
      ["No project", ["free"]],
    ]);
  });

  it("names a row by what was observed before what it was launched as", () => {
    expect(describeTerminalKind(terminal("a", { isAssistantTerminal: true }))).toBe("Assistant");
    expect(describeTerminalKind(terminal("d", { kind: "dev-preview" }))).toBe("Dev preview");
    expect(describeTerminalKind(terminal("t"))).toBe("Terminal");
    expect(describeTerminalKind(terminal("u", { launchAgentId: "not-a-real-agent" }))).toBe(
      "Terminal"
    );
    expect(
      describeTerminalKind(terminal("c", { launchAgentId: "codex", detectedAgentId: "claude" }))
    ).toBe("Claude");
    expect(terminalTitle(terminal("t", { title: "  " }))).toBe("Terminal");
    expect(terminalTitle(terminal("t", { title: "npm run dev" }))).toBe("npm run dev");
  });

  it("titles plugin rows without exposing anything but the executable", () => {
    const base = { id: "1", pluginId: "acme", pid: 1, spawnedAt: null, sample: null };
    expect(pluginProcessTitle({ ...base, source: "plugin-worker", label: null })).toBe(
      "acme worker"
    );
    expect(pluginProcessTitle({ ...base, source: "plugin-process", label: "node" })).toBe("node");
  });

  it("lists members by name, heaviest first, each once, with the remainder counted", () => {
    const tree = {
      ...sample(0, [
        ["/bin/zsh", 10],
        ["node", 500],
        ["node", 400],
        ["esbuild", 200],
      ]),
      processCount: 9,
    };
    expect(describeMembers(tree, 2)).toBe("node, esbuild +7");
    expect(describeMembers(sample(0, [["zsh", 1]]))).toBe("zsh");
  });

  it("reads memory as approximate and never as zero", () => {
    expect(formatApproxMemory(100)).toBe("~1 MB");
    expect(formatApproxMemory(300 * 1024)).toBe("~300 MB");
    expect(formatApproxMemory(3 * 1024 * 1024)).toBe("~3.0 GB");
  });

  it("counts down a trashed terminal and stops at zero", () => {
    const trashed = terminal("t", { isTrashed: true, trashExpiresAt: 10_000 });
    expect(trashSecondsLeft(trashed, 1_500)).toBe(9);
    expect(trashSecondsLeft(trashed, 20_000)).toBe(0);
    expect(trashSecondsLeft(terminal("t", { isTrashed: true }), 0)).toBeNull();
    expect(trashSecondsLeft(terminal("t"), 0)).toBeNull();
  });
});
