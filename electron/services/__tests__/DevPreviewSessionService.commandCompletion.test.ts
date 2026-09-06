/**
 * The rest of the dev-preview suite drives state transitions from a mocked
 * `emitExit`, which is exactly why #12295 shipped: a mock exit stands in for
 * child-command completion, so nothing ever checked that a real command
 * finishing produces one. These cases spawn real node-pty shells running real
 * commands and assert on what the kernel actually reports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number, signal?: number) => void;

/**
 * A PtyClient that really spawns what it is handed. `spawn` honours the
 * `shell`/`args` the controller supplies, so the wrapper under test is the
 * thing being executed — not a stand-in for it.
 */
class RealPtyClient {
  readonly spawns: Array<{ id: string; options: PtyHostSpawnOptions }> = [];
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly terminals = new Map<string, { proc: pty.IPty; alive: boolean }>();

  on(event: string, cb: DataListener | ExitListener): void {
    if (event === "data") this.dataListeners.add(cb as DataListener);
    if (event === "exit") this.exitListeners.add(cb as ExitListener);
  }

  off(event: string, cb: DataListener | ExitListener): void {
    if (event === "data") this.dataListeners.delete(cb as DataListener);
    if (event === "exit") this.exitListeners.delete(cb as ExitListener);
  }

  spawn(id: string, options: PtyHostSpawnOptions): void {
    this.spawns.push({ id, options });
    const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
    const proc = pty.spawn(shell, options.args ?? [], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...(options.env ?? {}),
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
    });
    const entry = { proc, alive: true };
    this.terminals.set(id, entry);
    proc.onData((chunk) => {
      for (const listener of this.dataListeners) listener(id, chunk);
    });
    proc.onExit(({ exitCode, signal }) => {
      entry.alive = false;
      for (const listener of this.exitListeners) listener(id, exitCode, signal || undefined);
    });
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry?.alive) return;
    try {
      entry.proc.kill();
    } catch {
      // already gone
    }
  }

  submit(id: string, command: string): void {
    this.terminals.get(id)?.proc.write(`${command}\r`);
  }

  hasTerminal(id: string): boolean {
    return this.terminals.get(id)?.alive ?? false;
  }

  setIpcDataMirror(): void {}

  async replayHistoryAsync(): Promise<number> {
    return 0;
  }

  async getTerminalAsync(id: string): Promise<{ id: string; hasPty: boolean } | null> {
    const entry = this.terminals.get(id);
    return entry ? { id, hasPty: entry.alive } : null;
  }

  pidFor(id: string): number | undefined {
    return this.terminals.get(id)?.proc.pid;
  }

  killAll(): void {
    for (const id of this.terminals.keys()) this.kill(id);
    this.terminals.clear();
  }
}

const tempDirs: string[] = [];
const clients: RealPtyClient[] = [];
const services: DevPreviewSessionService[] = [];

function makeProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-devpreview-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return dir;
}

/**
 * `detectInstallCommand` emits `npm install`, and the login shell rebuilds PATH
 * (macOS `path_helper`), so a stub binary on PATH is not reachable. These
 * fixtures run the real npm instead: no dependencies plus an offline `.npmrc`
 * keeps it fast and off the network, and a failing `preinstall` script is a
 * genuine install failure.
 */
function writeNpmFixture(dir: string, options: { failing?: boolean } = {}): void {
  fs.writeFileSync(
    path.join(dir, ".npmrc"),
    "audit=false\nfund=false\noffline=true\nupdate-notifier=false\nprogress=false\n"
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      private: true,
      ...(options.failing ? { scripts: { preinstall: "exit 3" } } : {}),
    })
  );
}

function startService(): { client: RealPtyClient; service: DevPreviewSessionService } {
  const client = new RealPtyClient();
  const service = new DevPreviewSessionService(client as unknown as PtyClient, () => {});
  clients.push(client);
  services.push(service);
  return { client, service };
}

async function waitForStatus(
  service: DevPreviewSessionService,
  request: { panelId: string; projectId: string },
  predicate: (state: DevPreviewSessionState) => boolean,
  timeoutMs = 20_000
): Promise<DevPreviewSessionState> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getState(request);
  while (Date.now() < deadline) {
    last = service.getState(request);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for dev-preview state. Last: ${JSON.stringify(last)}`);
}

function readPgids(pid: number): { shellPgid: number; foregroundPgid: number } | null {
  const result = spawnSync("ps", ["-o", "pgid=,tpgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 750,
  });
  if (result.status !== 0 || result.error) return null;
  const [pgidText, tpgidText] = result.stdout.trim().split(/\s+/);
  const shellPgid = Number.parseInt(pgidText ?? "", 10);
  const foregroundPgid = Number.parseInt(tpgidText ?? "", 10);
  if (!Number.isFinite(shellPgid) || !Number.isFinite(foregroundPgid)) return null;
  return { shellPgid, foregroundPgid };
}

afterEach(() => {
  while (services.length > 0) services.pop()?.dispose();
  while (clients.length > 0) clients.pop()?.killAll();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describePosix("dev preview command completion (real PTY)", () => {
  it("reports the dev command's own nonzero exit instead of waiting on the shell", async () => {
    const cwd = makeProject({
      "dev.js": `require("fs").writeFileSync("marker", "done"); process.exit(7);`,
    });
    const { service } = startService();
    const request = { panelId: "panel-1", projectId: "project-1" };

    const initial = await service.ensure({ ...request, cwd, devCommand: "node dev.js" });
    expect(initial.status).toBe("starting");

    const final = await waitForStatus(service, request, (state) => state.status === "error");
    // The command really ran: only the child writes this file.
    expect(fs.existsSync(path.join(cwd, "marker"))).toBe(true);
    expect(final.error?.message).toContain("7");
    expect(final.terminalId).toBeNull();
  }, 30_000);

  it("treats a dev command that exits 0 before serving as a failure to start", async () => {
    const cwd = makeProject({ "dev.js": `process.exit(0);` });
    const { service } = startService();
    const request = { panelId: "panel-2", projectId: "project-1" };

    await service.ensure({ ...request, cwd, devCommand: "node dev.js" });

    const final = await waitForStatus(service, request, (state) => state.status === "error");
    expect(final.url).toBeNull();
  }, 30_000);

  it("keeps a real interactive parent shell that hands the foreground to the dev command", async () => {
    const cwd = makeProject({ "dev.js": `setTimeout(() => process.exit(0), 8000);` });
    const { client, service } = startService();
    const request = { panelId: "panel-3", projectId: "project-1" };

    const state = await service.ensure({ ...request, cwd, devCommand: "node dev.js" });
    const pid = client.pidFor(state.terminalId ?? "");
    expect(pid).toBeGreaterThan(0);

    let snapshot: ReturnType<typeof readPgids> = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      snapshot = readPgids(pid!);
      if (snapshot && snapshot.shellPgid > 0 && snapshot.foregroundPgid > 0) {
        if (snapshot.shellPgid !== snapshot.foregroundPgid) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Job control is on, so the shell is genuinely interactive and the dev
    // command owns its own foreground process group — Ctrl-C reaches the
    // server, not the wrapper.
    expect(snapshot).toBeTruthy();
    expect(snapshot?.foregroundPgid).not.toBe(snapshot?.shellPgid);
  }, 30_000);

  it("detects a serving dev server exiting nonzero after it was already running", async () => {
    const cwd = makeProject({
      "dev.js": `
const http = require("http");
const server = http.createServer((_, res) => res.end("ok"));
server.listen(Number(process.env.PORT), () => console.log("ready on " + process.env.PORT));
setTimeout(() => { server.close(); process.exit(7); }, 3000);
`,
    });
    const { service } = startService();
    const request = { panelId: "panel-4", projectId: "project-1" };

    await service.ensure({ ...request, cwd, devCommand: "node dev.js" });
    await waitForStatus(service, request, (state) => state.status === "running");

    const final = await waitForStatus(service, request, (state) => state.status === "error");
    expect(final.error?.message).toContain("7");
    expect(final.url).toBeNull();
  }, 40_000);

  it("runs a real install after a missing-dependency exit and restarts the dev server", async () => {
    const cwd = makeProject({
      "dev.js": `
const fs = require("fs");
// package-lock.json only exists once npm install has really run.
if (fs.existsSync("package-lock.json")) {
  const http = require("http");
  const server = http.createServer((_, res) => res.end("ok"));
  server.listen(Number(process.env.PORT), () => console.log("ready"));
} else {
  console.error("Error: Cannot find module 'react'");
  process.exit(1);
}
`,
    });
    writeNpmFixture(cwd);
    const { service } = startService();
    const request = { panelId: "panel-5", projectId: "project-1" };

    await service.ensure({ ...request, cwd, devCommand: "node dev.js" });

    const running = await waitForStatus(
      service,
      request,
      (state) => state.status === "running",
      60_000
    );
    expect(running.url).toBeTruthy();
    expect(fs.existsSync(path.join(cwd, "package-lock.json"))).toBe(true);

    const events = service.getDiagnostics(request).events.map((event) => event.type);
    expect(events).toContain("install-started");
    expect(events).toContain("install-completed");
  }, 90_000);

  it("surfaces a failing install instead of leaving the session in installing", async () => {
    const cwd = makeProject({
      "dev.js": `console.error("Error: Cannot find module 'react'"); process.exit(1);`,
    });
    writeNpmFixture(cwd, { failing: true });
    const { service } = startService();
    const request = { panelId: "panel-6", projectId: "project-1" };

    await service.ensure({ ...request, cwd, devCommand: "node dev.js" });

    const final = await waitForStatus(
      service,
      request,
      (state) => state.status === "error" && state.error?.type === "missing-dependencies",
      60_000
    );
    expect(final.error?.message).toContain("Dependency installation failed");
    expect(service.getDiagnostics(request).events.map((event) => event.type)).toContain(
      "install-failed"
    );
  }, 90_000);

  it("reports a clean stop when the user interrupts the dev command", async () => {
    const cwd = makeProject({ "dev.js": `setInterval(() => {}, 1000);` });
    const { client, service } = startService();
    const request = { panelId: "panel-7", projectId: "project-1" };

    const state = await service.ensure({ ...request, cwd, devCommand: "node dev.js" });
    const pid = client.pidFor(state.terminalId ?? "");

    // Wait for the child to own the foreground, then deliver a real SIGINT to
    // it exactly as the TTY line discipline would on Ctrl-C.
    let foreground = 0;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const snapshot = readPgids(pid!);
      if (
        snapshot &&
        snapshot.foregroundPgid > 0 &&
        snapshot.foregroundPgid !== snapshot.shellPgid
      ) {
        foreground = snapshot.foregroundPgid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(foreground).toBeGreaterThan(0);
    process.kill(-foreground, "SIGINT");

    // The wrapper survives the interrupt and exits 128+SIGINT, which must read
    // as a stop rather than a crash.
    const final = await waitForStatus(service, request, (state) => state.status === "stopped");
    expect(final.error).toBeNull();
  }, 30_000);
});
