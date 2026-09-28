import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { McpHttpClient } from "../plugins/helpers/mcpClient";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, openSettings, openTerminal } from "../helpers/panels";
import { waitForTerminalReady } from "../helpers/terminal";
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
 * Remote Hosts over real ssh, from the plugin and MCP side: a plugin installed
 * only on the Host, used from a Shell's window, and the Host's MCP server
 * driving the view on the Shell that holds the drive lease.
 */

const HOST_NAME = "e2e-host";
const SAMPLE_PLUGINS_DIR = path.join(process.cwd(), "dist-electron/plugins/sample");

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
  mcp: McpHttpClient | null;
  unboundMcp: McpHttpClient | null;
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

test.describe.serial("Remote hosts: host plugins and the host MCP server, from a Shell", () => {
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
      env: { HOME: run.sshd.home, DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR },
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

  // ── Setup: add the host and take its project over (as remote-host-ssh.spec) ──

  test("1. add the host over real ssh", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    const dialog = page.locator(SEL.remoteHosts.addHostDialog);
    await dialog.getByPlaceholder("user@studio-03").fill(SSH_ALIAS);
    await dialog.getByPlaceholder(SSH_ALIAS).fill(HOST_NAME);
    await dialog.getByRole("button", { name: "Check host" }).click();
    await expect(dialog).toContainText(/Host mode\s*Listening/, { timeout: 60_000 });
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("button", { name: "Skip" }).click();
    await dialog.getByRole("button", { name: "Add host", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('[id="hosts-list"]')).toContainText(/\bConnected\b/, {
      timeout: 60_000,
    });
    const hosts = (await page.evaluate(() =>
      window.electron.remoteHosts.list()
    )) as unknown as Array<{
      descriptor: { id: string; name: string };
    }>;
    run.hostId = hosts.find((h) => h.descriptor.name === HOST_NAME)!.descriptor.id;
    await page.locator(SEL.settings.closeButton).first().click();
  });

  test("2. switch to the host's project and take it over", async () => {
    const page = run.b.window;
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.locator(SEL.remoteHosts.hostMenuRow(run.hostId)).click();
    await page.locator(SEL.remoteHosts.switchDialogJustSwitch).click();
    await page.locator(SEL.remoteHosts.projectPickerOption(run.hostProject.name)).click();
    run.remotePage = await waitForView(run.b.app, run.hostId, run.hostProject.name);
    const driven = run.remotePage.locator(SEL.remoteHosts.drivenElsewhereBanner);
    await driven.getByRole("button", { name: "Take over" }).click();
    await expect(driven).toHaveCount(0);
    await openTerminal(run.remotePage);
    await waitForTerminalReady(run.remotePage, getFirstGridPanel(run.remotePage), 60_000);
  });

  // ── A plugin that lives only on the Host ──

  test("3. the Host's plugin answers the Shell's window over the link", async () => {
    const page = run.remotePage!;
    const reply = (await page.evaluate(() =>
      (
        window as unknown as {
          electron: { plugin: { invoke(id: string, ch: string): Promise<unknown> } };
        }
      ).electron.plugin.invoke("daintree.hello", "ping")
    )) as { pluginId: string; worktreeId: unknown };
    expect(reply.pluginId).toBe("daintree.hello");
    // The Shell never had it: the same call from its own local project fails.
    const local = await run.b.window
      .evaluate(() =>
        (
          window as unknown as {
            electron: { plugin: { invoke(id: string, ch: string): Promise<unknown> } };
          }
        ).electron.plugin.invoke("daintree.hello", "ping")
      )
      .then(
        () => "answered",
        (e: unknown) => String(e)
      );
    expect(local).not.toBe("answered");
  });

  test("4. the Host's plugin action runs from the Shell's palette and toasts on the Shell", async () => {
    const page = run.remotePage!;
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+P`);
    await expect(page.locator(SEL.actionPalette.dialog)).toBeVisible();
    await page.locator(SEL.actionPalette.searchInput).fill("Hello: Greet");
    const option = page.locator(SEL.actionPalette.options).filter({ hasText: "Hello: Greet" });
    await expect(option).toHaveCount(1, { timeout: 15_000 });
    await option.click();
    // An unfocused test window routes a toast to the inbox, as it does locally.
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const inboxText = async (target: Page) => {
      const inbox = target.getByRole("button", { name: "Pause notifications" });
      if (!(await inbox.isVisible().catch(() => false))) {
        await target.keyboard.press(`${mod}+Shift+N`);
        await inbox.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
      }
      return target
        .locator(SEL.notifications.center)
        .innerText()
        .catch(() => "");
    };
    await expect
      .poll(async () => inboxText(page), { timeout: 20_000 })
      .toContain("Hello from the greet action");
    // A toast is pushed to the Host's own windows as well as forwarded to the
    // driver (unlike a prompt, which only the driver sees).
    const hostScreen = (await topViewPage(run.a.app))!;
    expect(await inboxText(hostScreen)).toContain("Hello from the greet action");
    await page.keyboard.press("Escape");
  });

  test("5. plugin parity compares installed plugins only, not a dev sideload", async () => {
    const diff = await run.remotePage!.evaluate(
      (hostId) =>
        (
          window as unknown as {
            electron: { pluginParity: { diff(p: { hostId: string }): Promise<unknown> } };
          }
        ).electron.pluginParity.diff({ hostId }),
      run.hostId
    );
    console.log(`[remote-hosts plugins] parity ${JSON.stringify(diff).slice(0, 2000)}`);
    // Parity diffs installed packages; a sideloaded dev plugin is neither
    // offered for install nor reported missing.
    expect(Array.isArray(diff)).toBe(true);
    expect(JSON.stringify(diff)).not.toContain("daintree.hello");
  });

  // ── The Host's MCP server, driving the Shell's view ──

  test("6. the Host's MCP server lists and opens terminals in the driving Shell's window", async () => {
    const status = (await run.a.window.evaluate(async () => {
      const api = (
        window as unknown as {
          electron: {
            mcpServer: {
              setEnabled(on: boolean): Promise<unknown>;
              getStatus(): Promise<{ port: number; apiKey: string }>;
            };
          };
        }
      ).electron.mcpServer;
      await api.setEnabled(true);
      for (let i = 0; i < 100; i++) {
        const s = await api.getStatus();
        if (s.port && s.apiKey) return s;
        await new Promise((r) => setTimeout(r, 200));
      }
      return api.getStatus();
    })) as { port: number; apiKey: string };
    expect(status.port).toBeGreaterThan(0);
    const url = `http://127.0.0.1:${status.port}/mcp`;
    const workspaceId = (await run.a.window.evaluate(
      () =>
        (window as unknown as { __DAINTREE_INITIAL_PROJECT__?: { id?: string } })
          .__DAINTREE_INITIAL_PROJECT__?.id ?? null
    ))!;
    expect(workspaceId, "no workspace id for the host project").toBeTruthy();
    // Bound to the host project, as an agent Daintree launched there would be.
    run.mcp = new McpHttpClient(url, status.apiKey, { "Daintree-Workspace-Id": workspaceId });
    await run.mcp.initialize();
    const tools = await run.mcp.listTools();
    console.log(`[remote-hosts mcp] ${tools.length} tools: ${tools.join(", ")}`);
    expect(tools).toContain("terminal.list");
    const unbound = new McpHttpClient(url, status.apiKey);
    await unbound.initialize();
    run.unboundMcp = unbound;

    const page = run.remotePage!;
    await openTerminal(page);
    await waitForTerminalReady(page, getFirstGridPanel(page), 60_000);
    const shellIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-panel-id]")).map((el) =>
        el.getAttribute("data-panel-id")
      )
    );
    expect(shellIds.length).toBeGreaterThan(0);
    const listed = JSON.stringify(await run.mcp.callJson("terminal.list"));
    for (const id of shellIds) expect(listed, `terminal.list missed ${id}`).toContain(id!);
    // An unbound (focus-following) session asks the Host's own front window
    // instead, which only observes: recorded, not asserted.
    console.log(
      `[remote-hosts mcp] unbound terminal.list: ${JSON.stringify(await run.unboundMcp!.callJson("terminal.list")).slice(0, 300)}`
    );

    expect(tools).toContain("terminal.new");
    {
      const before = await page.locator("[data-panel-id]").count();
      const opened = await run.mcp.callTool("terminal.new", {});
      console.log(`[remote-hosts mcp] terminal.new -> ${JSON.stringify(opened).slice(0, 500)}`);
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      await expect
        .poll(async () => page.locator("[data-panel-id]").count(), { timeout: 30_000 })
        .toBeGreaterThan(before);
    }
  });

  test("7. with the driver's link down, MCP answers rather than hanging, and the Shell catches up", async () => {
    const page = run.remotePage!;
    let outage: { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    await run.wrapper.hold();
    try {
      for (const pid of await liveMasters()) process.kill(pid, "SIGKILL");
      await expect(page.locator(SEL.remoteHosts.connectionBanner).first()).toBeVisible({
        timeout: 30_000,
      });
      const started = Date.now();
      outage = await Promise.race([
        run.mcp!.callTool("terminal.list", {}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("terminal.list hung past 45s")), 45_000)
        ),
      ]);
      timings.mcpListWhileDriverDownMs = Date.now() - started;
      console.log(
        `[remote-hosts mcp] terminal.list while the driver is away: ${JSON.stringify(outage).slice(0, 600)}`
      );
    } finally {
      await run.wrapper.release();
    }
    // Refused, retriably, for the driver's reserved place: never answered by
    // the Host's own window, which would have returned a list.
    expect(outage?.isError).toBe(true);
    const refusal = JSON.parse(outage?.content?.[0]?.text ?? "{}") as {
      code?: string;
      retriable?: boolean;
    };
    expect(refusal.code).toBe("SESSION_BINDING_GONE");
    expect(refusal.retriable).toBe(true);
    await expect(page.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
      timeout: 60_000,
    });
    // Still driving after the outage: a call now reaches this window again.
    const after = JSON.stringify(await run.mcp!.callJson("terminal.list"));
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-panel-id]")).map((el) =>
        el.getAttribute("data-panel-id")
      )
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(after).toContain(id!);
  });
});
