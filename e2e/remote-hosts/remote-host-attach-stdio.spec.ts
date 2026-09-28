import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalReady, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import {
  SSH_ALIAS,
  controlSocketsUnder,
  listProcesses,
  makeShortTempRoot,
  masterPidAt,
  startPrivateSshd,
  writeSshWrapper,
  type PrivateSshd,
  type SshWrapper,
} from "../helpers/privateSshd";

/**
 * A Host behind an sshd that refuses Unix-socket forwarding, as a locked-down
 * server does: the Shell's `-L` forward is refused, so the link runs over
 * `ssh <host> -- <daintree> --attach-stdio`, the real app binary bridging the
 * session's stdio to its own Host socket (electron/remote/host/attachStdio.ts).
 */

const HOST_NAME = "e2e-host";

interface Run {
  root: string;
  sshd: PrivateSshd;
  wrapper: SshWrapper;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  c: AppContext | null;
  thirdUserData: string;
  /** Console lines of every page and the main process, per app. */
  logs: { a: string[]; b: string[]; c: string[] };
  hostId: string;
  remotePage: Page | null;
}

const run = {
  logs: { a: [], b: [], c: [] },
  c: null,
  hostId: "",
  remotePage: null,
} as unknown as Run;

const timings: Record<string, number> = {};

function captureLogs(app: ElectronApplication, sink: string[]): void {
  const tap = (page: Page) =>
    page.on("console", (msg) => sink.push(`[${page.url()}] ${msg.type()}: ${msg.text()}`));
  for (const page of app.windows()) tap(page);
  app.on("window", tap);
  try {
    const proc = app.process();
    proc.stdout?.on("data", (chunk: Buffer) =>
      sink.push(`[main:out] ${chunk.toString().trimEnd()}`)
    );
    proc.stderr?.on("data", (chunk: Buffer) =>
      sink.push(`[main:err] ${chunk.toString().trimEnd()}`)
    );
  } catch {
    // The process is already gone; its pages' consoles are still captured.
  }
}

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setSize(1600, 1000);
    win.center();
  });
}

/**
 * The page of the view on top of the app's first window. A switch replaces the
 * window's view (a remote project gets its own `WebContentsView`), so the page
 * in hand goes stale: mark the topmost visible view from main and find it.
 */
async function topViewPage(app: ElectronApplication): Promise<Page | null> {
  const mark = `top-${randomBytes(4).toString("hex")}`;
  const marked = await app
    .evaluate(async ({ BrowserWindow }, value) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return false;
      const views = win.contentView?.children ?? [];
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i] as Electron.WebContentsView & { getVisible?: () => boolean };
        const wc = view.webContents;
        if (!wc || wc.isDestroyed()) continue;
        if (typeof view.getVisible === "function" && !view.getVisible()) continue;
        if (!wc.getURL().startsWith("app://daintree/")) continue;
        await wc.executeJavaScript(`window.__rhE2eTopView = ${JSON.stringify(value)}`, true);
        return true;
      }
      return false;
    }, mark)
    .catch(() => false);
  if (!marked) return null;
  for (const page of app.windows()) {
    const seen = await page
      .evaluate(() => (window as unknown as { __rhE2eTopView?: string }).__rhE2eTopView ?? null)
      .catch(() => null);
    if (seen === mark) return page;
  }
  return null;
}

async function viewHostId(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __DAINTREE_HOST_ID__?: { id?: string } }).__DAINTREE_HOST_ID__?.id ??
      null
  );
}

/** Wait until the window shows `projectName` on `hostId` (null: this machine), and return that page. */
async function waitForView(
  app: ElectronApplication,
  hostId: string | null,
  projectName: string,
  timeout = 60_000
): Promise<Page> {
  let found: Page | null = null;
  let last = "no view yet";
  await expect
    .poll(
      async () => {
        const page = await topViewPage(app);
        if (!page) return false;
        const host = await viewHostId(page).catch(() => "?");
        const label = await page
          .locator('[data-testid="project-switcher-trigger"]')
          .textContent({ timeout: 500 })
          .catch(() => null);
        last = `host=${host} label=${label}`;
        if (host !== hostId || !label?.includes(projectName)) return false;
        found = page;
        return true;
      },
      {
        timeout,
        intervals: [250, 500, 1000],
        message: () =>
          `window never showed ${projectName} on ${hostId ?? "this machine"} (last: ${last})`,
      }
    )
    .toBe(true);
  return found!;
}

/** ssh processes this run started through the wrapper, found by the private config in their argv. */
async function wrapperSshProcesses(): Promise<string[]> {
  return (await listProcesses())
    .filter((row) => row.command.includes(run.sshd.configPath) && !/\bps\b/.test(row.command))
    .map((row) => `${row.pid} (ppid ${row.ppid}) ${row.command}`);
}

async function liveMasters(): Promise<number[]> {
  const pids: number[] = [];
  for (const socket of await controlSocketsUnder(run.shellUserData)) {
    const pid = await masterPidAt(run.sshd, socket);
    if (pid !== null) pids.push(pid);
  }
  return pids;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeDiagnostics(title: string): Promise<string> {
  const file = `${run.root ?? "/tmp/dse-unknown"}-diagnostics.log`;
  const sections: string[] = [`# ${title}`, `timings: ${JSON.stringify(timings)}`];
  if (run.b?.app) {
    for (const page of run.b.app.windows()) {
      const dialog = page.locator(SEL.remoteHosts.addHostDialog);
      if (await dialog.isVisible().catch(() => false)) {
        sections.push(
          `## Add Host dialog (${page.url()})\n${await dialog.innerText().catch(() => "?")}`
        );
      }
    }
    const hosts = await run.b.window
      .evaluate(() => window.electron.remoteHosts.list())
      .catch((err: unknown) => `(unavailable: ${String(err)})`);
    sections.push(`## Shell host list\n${JSON.stringify(hosts, null, 2)}`);
  }
  sections.push(`## App A (host) console\n${run.logs.a.join("\n")}`);
  sections.push(`## App B (shell) console\n${run.logs.b.join("\n")}`);
  sections.push(`## App C (second shell) console\n${run.logs.c.join("\n")}`);
  if (run.sshd) {
    sections.push(
      `## sshd log\n${await fs.readFile(run.sshd.logPath, "utf8").catch(() => "(none)")}`
    );
  }
  if (run.wrapper) sections.push(`## ssh wrapper invocations\n${await run.wrapper.invocations()}`);
  sections.push(`## ssh processes\n${(await wrapperSshProcesses().catch(() => [])).join("\n")}`);
  await fs.writeFile(file, sections.join("\n\n"));
  return file;
}

test.describe.serial("Remote hosts: a Host reached over --attach-stdio", () => {
  test.beforeAll(async () => {
    const supported = process.platform === "darwin" && existsSync("/usr/sbin/sshd");
    test.info().annotations.push({
      type: "platform-skip",
      description: "The private sshd and the host's socket location are macOS-only here",
    });
    test.skip(!supported, "Needs macOS and /usr/sbin/sshd");
    test.setTimeout(300_000);
    const started = Date.now();
    run.root = await makeShortTempRoot();
    run.sshd = await startPrivateSshd(run.root, { streamLocalForwarding: false });
    run.wrapper = await writeSshWrapper(run.root, run.sshd.configPath);
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "rh-host" });
    const localFixture = createFixtureRepo({ name: "rh-shell" });
    run.hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    run.localProject = { ...localFixture, name: path.basename(localFixture.dir) };

    // App A, the Host. HOME is the session HOME too, so nothing it writes for
    // itself (start at login, shell history) lands in the real home.
    run.a = await launchApp({
      userDataDir: run.hostUserData,
      env: { HOME: run.sshd.home },
      alongside: true,
    });
    captureLogs(run.a.app, run.logs.a);
    await sizeWindow(run.a.app);
    run.a.window = await openAndOnboardProject(run.a.app, run.a.window, run.hostProject.dir);
    // The Settings switch's own path; no start at login, which would write a login item.
    await run.a.window.evaluate(() =>
      window.electron.hostMode.setEnabled({ enabled: true, startAtLogin: false })
    );
    await expect
      .poll(
        async () =>
          (await run.a.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
        {
          timeout: 30_000,
          message: "Host mode never started listening on app A",
        }
      )
      .toBe(true);
    expect(existsSync(path.join(run.hostUserData, "host.sock"))).toBe(true);
    expect(existsSync(path.join(run.hostUserData, "host.json"))).toBe(true);

    // App B, the Shell, with the wrapper as its ssh (and first on PATH too).
    run.b = await launchApp({
      userDataDir: run.shellUserData,
      env: {
        DAINTREE_SSH: run.wrapper.path,
        PATH: `${run.wrapper.binDir}:${process.env.PATH ?? ""}`,
      },
      alongside: true,
    });
    captureLogs(run.b.app, run.logs.b);
    await sizeWindow(run.b.app);
    run.b.window = await openAndOnboardProject(run.b.app, run.b.window, run.localProject.dir);
    timings.setupMs = Date.now() - started;
  });

  test.afterEach(async () => {
    const testInfo = test.info();
    if (testInfo.status !== testInfo.expectedStatus) {
      const file = await writeDiagnostics(testInfo.title).catch(
        (err: unknown) => `(failed: ${String(err)})`
      );
      console.log(`[remote-hosts stdio] diagnostics: ${file}`);
    }
  });

  test.afterAll(async () => {
    const started = Date.now();
    let leftovers: string[] = [];
    let mastersBefore: number[] = [];
    try {
      if (run.b?.app) {
        mastersBefore = await liveMasters().catch(() => []);
        await closeApp(run.b.app);
        // The Shell closes every master it used on quit: no ssh it started stays.
        await expect
          .poll(async () => (await wrapperSshProcesses()).length, { timeout: 15_000 })
          .toBe(0)
          .catch(() => undefined);
        leftovers = await wrapperSshProcesses();
        if (leftovers.length > 0 || mastersBefore.some(isAlive)) {
          console.log(`[remote-hosts stdio] diagnostics: ${await writeDiagnostics("teardown")}`);
        }
      }
    } finally {
      if (run.c?.app) await closeApp(run.c.app).catch(() => undefined);
      if (run.a?.app) await closeApp(run.a.app);
      await run.sshd?.stop();
      // Nothing is left to hold the directory: sessions went with sshd.
      for (const line of await wrapperSshProcesses().catch(() => [])) {
        const pid = Number(line.split(" ")[0]);
        if (pid) process.kill(pid, "SIGKILL");
      }
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
    timings.teardownMs = Date.now() - started;
    console.log(`[remote-hosts stdio] timings ${JSON.stringify(timings)}`);
    // Only once a host was added is there a master to outlive the Shell.
    if (run.hostId) {
      expect(mastersBefore.length, "a master was running before quit").toBeGreaterThan(0);
      for (const pid of mastersBefore) {
        expect(isAlive(pid), `master ${pid} outlived the Shell`).toBe(false);
      }
      expect(leftovers, "ssh processes left after the Shell quit").toEqual([]);
    }
  });

  /** The ssh sessions running the Host's attach bridge. */
  async function attachSessions(): Promise<Array<{ pid: number; command: string }>> {
    return (await listProcesses()).filter(
      (row) => row.command.includes(run.sshd.configPath) && row.command.includes("--attach-stdio")
    );
  }

  async function connectionStatus(): Promise<string> {
    const list = (await run.b.window.evaluate(() =>
      window.electron.remoteHosts.list()
    )) as unknown as Array<{ descriptor: { id: string }; connection: { status: string } }>;
    return list.find((h) => h.descriptor.id === run.hostId)?.connection.status ?? "absent";
  }

  test("1. the Shell connects through the attach bridge when the forward is refused", async () => {
    const page = run.b.window;
    const added = (await page.evaluate(
      ({ name, target }) =>
        window.electron.remoteHosts.add({ name, connection: { kind: "ssh", target } }),
      { name: HOST_NAME, target: SSH_ALIAS }
    )) as { descriptor?: { id: string }; id?: string };
    run.hostId = added.descriptor?.id ?? added.id!;
    const started = Date.now();
    await page.evaluate((hostId) => window.electron.remoteHosts.connect({ hostId }), run.hostId);
    await expect.poll(connectionStatus, { timeout: 60_000 }).toBe("connected");
    timings.connectMs = Date.now() - started;
    // It is the bridge carrying the link: an ssh session running --attach-stdio
    // is alive, and sshd refused the socket forward on the way.
    await expect.poll(async () => (await attachSessions()).length, { timeout: 10_000 }).toBe(1);
    expect(await run.wrapper.invocations()).toContain("--attach-stdio");
  });

  test("2. the Shell drives a terminal on the Host over it", async () => {
    const page = run.b.window;
    const projects = (await page.evaluate(
      (hostId) => window.electron.remoteHosts.listHostProjects({ hostId }),
      run.hostId
    )) as Array<{ id: string; name: string }>;
    const target = projects.find((p) => p.name === run.hostProject.name);
    expect(target, JSON.stringify(projects)).toBeTruthy();
    await page.evaluate(
      ({ hostId, projectId }) =>
        window.electron.remoteHosts.switchWindowHost({ hostId, newWindow: false, projectId }),
      { hostId: run.hostId, projectId: target!.id }
    );
    run.remotePage = await waitForView(run.b.app, run.hostId, run.hostProject.name);
    const top = run.remotePage;
    const driven = top.locator(SEL.remoteHosts.drivenElsewhereBanner);
    if ((await driven.count()) > 0) {
      await driven.getByRole("button", { name: "Take over" }).click();
      await expect(driven).toHaveCount(0, { timeout: 15_000 });
    }
    await openTerminal(top);
    const panel = getFirstGridPanel(top);
    await waitForTerminalReady(top, panel, 60_000);
    await runTerminalCommand(top, panel, 'echo "stdio=$((6*7))"; seq 1 50000 | tail -n 1');
    await waitForTerminalText(panel, "stdio=42", 30_000);
    await waitForTerminalText(panel, "50000", 30_000);
  });

  test("3. killing the bridge's ssh session reconnects over a new one, and the terminal carries on", async () => {
    const top = run.remotePage!;
    const [session] = await attachSessions();
    expect(session, "no attach session to kill").toBeTruthy();
    const downAt = Date.now();
    process.kill(session!.pid, "SIGKILL");
    await expect.poll(connectionStatus, { timeout: 30_000 }).not.toBe("connected");
    await expect.poll(connectionStatus, { timeout: 90_000 }).toBe("connected");
    timings.reconnectAfterKillMs = Date.now() - downAt;
    await expect
      .poll(async () => (await attachSessions()).map((s) => s.pid), { timeout: 15_000 })
      .not.toContain(session!.pid);
    await expect(top.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
      timeout: 60_000,
    });
    const panel = getFirstGridPanel(top);
    await runTerminalCommand(top, panel, 'echo "again=$((7*8))"');
    await waitForTerminalText(panel, "again=56", 30_000);
  });
});
