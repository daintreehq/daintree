import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { _electron as electron } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import {
  getTerminalText,
  runTerminalCommand,
  waitForTerminalReady,
  waitForTerminalText,
} from "../helpers/terminal";
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
 * A Host with no window at all, as a login item or systemd unit starts it
 * (`--host-mode`): seeded with a project by an ordinary launch first, then
 * relaunched windowless and driven entirely from a Shell over real ssh.
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
  windowless: ElectronApplication | null;
  killedMaster: number | null;
}

const run = {
  logs: { a: [], b: [], c: [] },
  c: null,
  hostId: "",
  remotePage: null,
  killedMaster: null,
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

test.describe.serial("Remote hosts: a windowless Host started with --host-mode", () => {
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
    run.sshd = await startPrivateSshd(run.root);
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
      console.log(`[remote-hosts e2e] diagnostics: ${file}`);
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
          console.log(`[remote-hosts e2e] diagnostics: ${await writeDiagnostics("teardown")}`);
        }
      }
    } finally {
      if (run.c?.app) await closeApp(run.c.app).catch(() => undefined);
      if (run.windowless) await closeApp(run.windowless).catch(() => undefined);
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
    console.log(`[remote-hosts e2e] timings ${JSON.stringify(timings)}`);
    // Only once a host was added is there a master to outlive the Shell.
    if (run.hostId) {
      expect(mastersBefore.length, "a master was running before quit").toBeGreaterThan(0);
      for (const pid of mastersBefore) {
        expect(isAlive(pid), `master ${pid} outlived the Shell`).toBe(false);
      }
      expect(leftovers, "ssh processes left after the Shell quit").toEqual([]);
    }
  });

  test("1. quit the seeded Host and start it again with no window", async () => {
    await closeApp(run.a.app);
    run.windowless = await electron.launch({
      args: [
        "--daintree-e2e-mode",
        "--host-mode",
        `--user-data-dir=${run.hostUserData}`,
        path.resolve(import.meta.dirname, "../.."),
      ],
      env: { ...process.env, HOME: run.sshd.home } as Record<string, string>,
      timeout: 60_000,
    });
    run.windowless.process().stdout?.on("data", (c: Buffer) => run.logs.a.push(`[main:out] ${c}`));
    run.windowless.process().stderr?.on("data", (c: Buffer) => run.logs.a.push(`[main:err] ${c}`));
    await expect
      .poll(() => existsSync(path.join(run.hostUserData, "host.sock")), { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(
        async () =>
          await run.windowless!.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
          ),
        { timeout: 5_000 }
      )
      .toBe(0);
  });

  test("2. the Shell adds it, finds the seeded project, and drives it", async () => {
    const page = run.b.window;
    const added = (await page.evaluate(
      ({ name, target }) =>
        window.electron.remoteHosts.add({ name, connection: { kind: "ssh", target } }),
      { name: HOST_NAME, target: SSH_ALIAS }
    )) as { descriptor?: { id: string }; id?: string };
    run.hostId = added.descriptor?.id ?? added.id!;
    await page.evaluate((hostId) => window.electron.remoteHosts.connect({ hostId }), run.hostId);
    await expect
      .poll(
        async () => {
          const list = (await page.evaluate(() =>
            window.electron.remoteHosts.list()
          )) as unknown as Array<{ descriptor: { id: string }; connection: { status: string } }>;
          return list.find((h) => h.descriptor.id === run.hostId)?.connection.status;
        },
        { timeout: 60_000 }
      )
      .toBe("connected");
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
  });

  test("3. a terminal runs on the windowless Host", async () => {
    const page = run.remotePage!;
    await openTerminal(page);
    const panel = getFirstGridPanel(page);
    await waitForTerminalReady(page, panel, 60_000);
    await runTerminalCommand(page, panel, 'echo "home=$HOME"; echo "headless=$((12*12))"');
    await waitForTerminalText(panel, "headless=144", 30_000);
    expect(await getTerminalText(panel)).toContain(`home=${run.sshd.home}`);
  });

  test("4. after the windowless Host restarts, the panes are still there and a new terminal works", async () => {
    const page = run.remotePage!;
    const idsBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-panel-id]")).map((el) =>
        el.getAttribute("data-panel-id")
      )
    );
    expect(idsBefore.length).toBeGreaterThan(0);
    const status = async () => {
      const list = (await run.b.window.evaluate(() =>
        window.electron.remoteHosts.list()
      )) as unknown as Array<{ descriptor: { id: string }; connection: { status: string } }>;
      return list.find((h) => h.descriptor.id === run.hostId)?.connection.status ?? "absent";
    };
    await closeApp(run.windowless!);
    // The Shell has to notice the Host went before "no banner" means anything.
    await expect.poll(status, { timeout: 30_000 }).not.toBe("connected");
    run.windowless = await electron.launch({
      args: [
        "--daintree-e2e-mode",
        "--host-mode",
        `--user-data-dir=${run.hostUserData}`,
        path.resolve(import.meta.dirname, "../.."),
      ],
      env: { ...process.env, HOME: run.sshd.home } as Record<string, string>,
      timeout: 60_000,
    });
    await expect.poll(status, { timeout: 120_000 }).toBe("connected");
    await expect
      .poll(
        async () => {
          const top = await topViewPage(run.b.app);
          if (!top) return "no-view";
          return (await top.locator(SEL.remoteHosts.connectionBanner).count()) === 0
            ? "ok"
            : "banner";
        },
        { timeout: 60_000 }
      )
      .toBe("ok");
    const top = (await topViewPage(run.b.app))!;
    run.remotePage = top;
    // The pane is still there, and a terminal works again on the new Host process.
    for (const id of idsBefore) {
      await expect(top.locator(`[data-panel-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 });
    }
    await openTerminal(top);
    const panels = top.locator("[data-panel-id]");
    const last = panels.nth((await panels.count()) - 1);
    await waitForTerminalReady(top, last, 60_000);
    await runTerminalCommand(top, last, 'echo "again=$((13*13))"');
    await waitForTerminalText(last, "again=169", 30_000);
  });

  // Known gap, found by this spec: a windowless Host has no renderer to bring
  // its terminals back after a restart, and the Shell's reconnect resync marks
  // the vanished one only by `runtimeStatus: "exited"` in the store, which the
  // pane does not render (its exited look is driven by the PTY exit stream).
  // The pane keeps its old buffer and a live-looking prompt while the host
  // answers "terminal not found" to every keystroke.
  test.fixme("5. a terminal lost in a windowless Host restart is shown as ended, with a way to restart it", async () => {
    const top = run.remotePage!;
    const first = top.locator("[data-panel-id]").first();
    await expect(first).toContainText(/ended|not found|exited/i, { timeout: 30_000 });
  });
});
