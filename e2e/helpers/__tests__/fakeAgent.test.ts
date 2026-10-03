import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  FAKE_AGENT_STOP,
  installFakeAgent,
  readFakeAgentEvents,
  readFakeAgentLaunchLog,
  readFakeAgentStdinChunks,
  sendFakeAgentCommand,
  sendFakeAgentHandback,
  type FakeAgentIdentity,
} from "../fakeAgent";

let repoDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), "fake-agent-test-"));
});

afterEach(async () => {
  await Promise.all(
    children.splice(0).map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      const gone = exited(child);
      child.kill("SIGKILL");
      return gone;
    })
  );
  rmSync(repoDir, { recursive: true, force: true });
});

function script(binDir: string, identity: FakeAgentIdentity): string {
  return path.join(binDir, process.platform === "win32" ? `${identity}.js` : identity);
}

function start(binDir: string, identity: FakeAgentIdentity, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script(binDir, identity), "--model", "m1"], {
    cwd: repoDir,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
  return { child, output: () => out };
}

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("fake agent binary", () => {
  it("reports its version in each CLI's own format", () => {
    const claude = installFakeAgent(path.join(repoDir, "a"));
    const codex = installFakeAgent(path.join(repoDir, "b"), {
      identity: "codex",
      version: "0.154.0",
    });
    const run = (bin: string, id: FakeAgentIdentity, args: string[]) =>
      spawnSync(process.execPath, [script(bin, id), ...args], { encoding: "utf8" });
    expect(run(claude, "claude", ["--version"]).stdout.trim()).toBe("claude code v9.9.9");
    expect(run(codex, "codex", ["--version"]).stdout.trim()).toBe("codex-cli 0.154.0");

    const appServer = run(codex, "codex", ["app-server", "--listen", "stdio://"]);
    expect(appServer.status).toBe(0);
    expect(appServer.stdout).toBe("");
    expect(readFakeAgentLaunchLog(codex)).toEqual([]);
  });

  it("records argv, cwd and the env allowlist in every mode, secrets by presence only", async () => {
    const binDir = installFakeAgent(repoDir, { recordEnv: ["E2E_FAKE_UNSET_SECRET_TOKEN"] });
    const { child, output } = start(binDir, "claude", {
      ANTHROPIC_MODEL: "sonnet-x",
      DAINTREE_MCP_TOKEN: "super-secret-bearer",
      DAINTREE_PANE_ID: "pane-1",
    });
    const exit = exited(child);
    child.stdin!.write("\n");
    await until(() => output().includes("FAKE_CLAUDE_READY"), "ready");
    child.stdin!.write(`${FAKE_AGENT_STOP}\n`);
    expect(await exit).toBe(0);

    const [launch] = readFakeAgentLaunchLog(binDir);
    expect(launch).toMatchObject({
      identity: "claude",
      paneId: "pane-1",
      argv: ["--model", "m1"],
      env: { ANTHROPIC_MODEL: "sonnet-x", DAINTREE_PANE_ID: "pane-1" },
      present: { DAINTREE_MCP_TOKEN: true, E2E_FAKE_UNSET_SECRET_TOKEN: false },
    });
    expect(realpathSync(launch.cwd)).toBe(realpathSync(repoDir));
    expect(readFileSync(path.join(binDir, "launches.log"), "utf8")).not.toContain(
      "super-secret-bearer"
    );
  });

  it("hands back with the latest code it was sent, never the placeholder", async () => {
    const binDir = installFakeAgent(repoDir, { controlChannel: true });
    const { child, output } = start(binDir, "claude");
    child.stdin!.write("\n");
    await until(() => output().includes("FAKE_CLAUDE_READY"), "ready");
    const instruction = (code: string) =>
      `do the thing\n\nWhen you have finished ... this line exactly, replacing <summary> with a summary: DAINTREE-DONE-${code}: <summary> END-${code}\n`;
    child.stdin!.write(instruction("aaa111"));
    child.stdin!.write(instruction("bbb222"));
    await until(
      () =>
        readFakeAgentStdinChunks(binDir)
          .map((c) => c.data)
          .join("")
          .includes("END-bbb222"),
      "prompts on stdin"
    );

    const event = await sendFakeAgentHandback(binDir, "all done");
    expect(event).toMatchObject({ cmd: "handback", code: "bbb222", summary: "all done" });
    await until(() => output().includes("END-bbb222"), "marker");
    const markerRows = output()
      .split(/\r?\n/)
      .filter((row) => row.includes("DAINTREE-DONE-"));
    expect(markerRows).toEqual(["DAINTREE-DONE-bbb222: all done END-bbb222"]);
  });

  it("logs a handback with no code, and prints nothing, when no prompt asked for one", async () => {
    const binDir = installFakeAgent(repoDir, { controlChannel: true });
    const { child, output } = start(binDir, "claude");
    child.stdin!.write("\n");
    await until(() => output().includes("FAKE_CLAUDE_READY"), "ready");
    const event = await sendFakeAgentHandback(binDir, "x");
    expect(event.code).toBeNull();
    expect(output()).not.toContain("DAINTREE-DONE-");
  });

  it.skipIf(process.platform === "win32")("logs SIGINT before exiting", async () => {
    const binDir = installFakeAgent(repoDir, { controlChannel: true });
    const { child, output } = start(binDir, "claude");
    child.stdin!.write("\n");
    await until(() => output().includes("FAKE_CLAUDE_READY"), "ready");
    await sendFakeAgentCommand(binDir, "idle");
    const exit = exited(child);
    child.kill("SIGINT");
    expect(await exit).toBe(0);
    expect(readFakeAgentEvents(binDir).map((e) => e.cmd)).toEqual(["idle", "sigint"]);
  });

  it("boots as codex without a trust prompt and shows its working row", async () => {
    const binDir = installFakeAgent(repoDir, {
      identity: "codex",
      bracketedPaste: true,
      controlChannel: true,
    });
    const { output } = start(binDir, "codex");
    await until(() => output().includes("› "), "codex prompt");
    expect(output().startsWith("\u001b[?2004h")).toBe(true);
    expect(output()).toMatch(/OpenAI Codex \(v9\.9\.9\)/);
    expect(output()).not.toContain("trust this folder");
    await sendFakeAgentCommand(binDir, "work");
    await until(() => /Working \(\d+s • esc to interrupt\)/.test(output()), "working row");
  });

  it("logs every stdin chunk with its arrival time, escape bytes included", async () => {
    const binDir = installFakeAgent(repoDir, { identity: "codex" });
    const { child, output } = start(binDir, "codex");
    await until(() => output().includes("› "), "codex prompt");
    child.stdin!.write("\u001b");
    await until(() => readFakeAgentStdinChunks(binDir).length === 1, "first escape");
    child.stdin!.write("\u001b");
    await until(() => readFakeAgentStdinChunks(binDir).length === 2, "second escape");
    const chunks = readFakeAgentStdinChunks(binDir);
    expect(chunks.map((c) => c.data)).toEqual(["\u001b", "\u001b"]);
    expect(chunks[1].at).toBeGreaterThanOrEqual(chunks[0].at);
  });
});
