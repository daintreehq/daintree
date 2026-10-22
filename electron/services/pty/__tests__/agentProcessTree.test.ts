import { describe, expect, it } from "vitest";
import { classifyAgentTree, isPlainShellName, type AgentTreeCensus } from "../agentProcessTree.js";

interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  command?: string;
}

function census(procs: Proc[]): AgentTreeCensus {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return {
    getProcess: (pid) => {
      const proc = byPid.get(pid);
      return proc
        ? { pid: proc.pid, comm: proc.comm, command: proc.command ?? proc.comm }
        : undefined;
    },
    getChildPids: (pid) => procs.filter((p) => p.ppid === pid).map((p) => p.pid),
  };
}

// The shape a Claude pane has on macOS: the `-lic` launch wrapper, the native
// binary under it, then the agent's own children.
const LAUNCH_SHELL: Proc = {
  pid: 10,
  ppid: 1,
  comm: "/bin/zsh",
  command: "/bin/zsh -lic trap : INT\n'/Users/me/.local/bin/claude' --session-id abc\nexec zsh -l",
};
const NATIVE_CLAUDE: Proc = {
  pid: 11,
  ppid: 10,
  comm: "/Users/me/.local/bin/claude",
  command: "/Users/me/.local/bin/claude --session-id abc --model opus",
};

function classify(procs: Proc[], agentId = "claude") {
  return classifyAgentTree(census(procs), LAUNCH_SHELL.pid, agentId);
}

describe("isPlainShellName", () => {
  it.each(["zsh", "-zsh", "/bin/bash", "fish", "pwsh.exe", "C:\\Windows\\System32\\cmd.exe"])(
    "accepts %s",
    (comm) => expect(isPlainShellName(comm)).toBe(true)
  );

  it.each(["node", "python3", "ssh", "sudo", "nohup", ""])("rejects %s", (comm) =>
    expect(isPlainShellName(comm)).toBe(false)
  );
});

describe("classifyAgentTree (#13854)", () => {
  it("reads the agent alone under its launch shell as runtime only", () => {
    expect(classify([LAUNCH_SHELL, NATIVE_CLAUDE])).toBe("runtime-and-servers");
  });

  it("lets MCP servers and runtime helpers run under the agent, whatever runs below them", () => {
    expect(
      classify([
        LAUNCH_SHELL,
        NATIVE_CLAUDE,
        { pid: 20, ppid: 11, comm: "node", command: "node /opt/homebrew/bin/ask-google-mcp" },
        { pid: 21, ppid: 11, comm: "caffeinate", command: "caffeinate -i -t 300" },
        {
          pid: 22,
          ppid: 11,
          comm: "node",
          command: "npm exec @modelcontextprotocol/server-memory",
        },
        // `npm exec` runs the package bin through `sh -c`.
        { pid: 23, ppid: 22, comm: "sh", command: "sh -c mcp-server-memory" },
        { pid: 24, ppid: 23, comm: "node", command: "node /x/.bin/mcp-server-memory" },
      ])
    ).toBe("runtime-and-servers");
  });

  it("identifies a Node-hosted CLI by its script, not its interpreter", () => {
    expect(
      classify([
        LAUNCH_SHELL,
        { pid: 11, ppid: 10, comm: "node", command: "node /opt/homebrew/bin/claude --resume x" },
      ])
    ).toBe("runtime-and-servers");
  });

  it("identifies a Windows build by its executable", () => {
    expect(
      classify([
        { pid: 10, ppid: 1, comm: "pwsh.exe", command: "pwsh.exe -NoLogo -NoExit" },
        { pid: 11, ppid: 10, comm: "claude.exe", command: "C:\\Users\\me\\claude.exe" },
      ])
    ).toBe("runtime-and-servers");
  });

  it.each<[string, Proc[]]>([
    [
      "a tool call or background shell under the agent",
      [
        LAUNCH_SHELL,
        NATIVE_CLAUDE,
        {
          pid: 30,
          ppid: 11,
          comm: "/bin/zsh",
          command: "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot.sh && eval 'x'",
        },
      ],
    ],
    [
      "a Monitor's bash under the agent",
      [
        LAUNCH_SHELL,
        NATIVE_CLAUDE,
        { pid: 30, ppid: 11, comm: "bash", command: "bash -c tail -f x" },
      ],
    ],
    [
      "a second process under the launch shell",
      [LAUNCH_SHELL, NATIVE_CLAUDE, { pid: 12, ppid: 10, comm: "gitstatusd" }],
    ],
    ["the agent gone from under its shell", [LAUNCH_SHELL]],
    [
      "something other than the agent under the shell",
      [LAUNCH_SHELL, { pid: 11, ppid: 10, comm: "node", command: "node server.js" }],
    ],
    [
      "a different agent under the shell",
      [LAUNCH_SHELL, { pid: 11, ppid: 10, comm: "codex", command: "codex --yolo" }],
    ],
    [
      "a root that isn't a shell",
      [{ pid: 10, ppid: 1, comm: "claude", command: "claude" }, { ...NATIVE_CLAUDE }],
    ],
  ])("reads %s as other", (_case, procs) => {
    expect(classify(procs)).toBe("other");
  });

  it.each<[string, Proc[], string]>([
    ["an agent whose tree shape hasn't been checked", [LAUNCH_SHELL, NATIVE_CLAUDE], "codex"],
    ["a root the census doesn't list", [NATIVE_CLAUDE], "claude"],
    ["a root with no name", [{ ...LAUNCH_SHELL, comm: "" }, NATIVE_CLAUDE], "claude"],
    [
      "a child of the agent with no name",
      [LAUNCH_SHELL, NATIVE_CLAUDE, { pid: 30, ppid: 11, comm: "" }],
      "claude",
    ],
  ])("reads %s as unknown", (_case, procs, agentId) => {
    expect(classify(procs, agentId)).toBe("unknown");
  });
});
