import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, openSettings, openTerminal } from "../helpers/panels";
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
 * Remote Hosts over real ssh, between two real app instances on this Mac.
 *
 * App A is the Host: Host mode on, its userData exactly where a Shell probing
 * the session's HOME looks (`<HOME>/Library/Application Support/Daintree`).
 * App B is the Shell: it reaches A through the system ssh into a private
 * user-mode sshd, via an `ssh` wrapper (named by `DAINTREE_SSH`) that adds
 * only `-F <private ssh_config>`. Everything is driven through B's own UI.
 */

const HOST_NAME = "e2e-host";
const NONCE = randomBytes(3).toString("hex");

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
  /** Console lines of every page and the main process, per app. */
  logs: { a: string[]; b: string[] };
  hostId: string;
  remotePage: Page | null;
  killedMaster: number | null;
}

const run = {
  logs: { a: [], b: [] },
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

/**
 * Accent is for structural focus only: the same predicate as the design
 * system's accent guard (`expectNoUnfocusedAccent`). A token counts unless it
 * is a border/ring/outline under the element's own focus variant.
 */
function unfocusedAccentTokens(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((token) => token.includes("accent"))
    .filter((token) => {
      const separator = token.lastIndexOf(":");
      if (separator === -1) return true;
      const variants = token.slice(0, separator);
      const utility = token.slice(separator + 1);
      if (!/^(border|ring|outline)-/.test(utility)) return true;
      if (/\b(group|peer)-focus/.test(variants)) return true;
      return !/(^|:)focus(-visible|-within)?$/.test(variants);
    });
}

async function chipAccentOffenders(chip: Locator): Promise<string[]> {
  const classLists = await chip.evaluate((el) =>
    [el, ...Array.from(el.querySelectorAll("*"))].map((node) => node.getAttribute("class") ?? "")
  );
  return classLists.flatMap(unfocusedAccentTokens);
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

test.describe.serial("Remote hosts: a Shell drives a Host over real ssh", () => {
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

  test("1. with no hosts, the Shell shows Settings → Hosts and no host chip", async () => {
    const page = run.b.window;
    await expect(page.locator('[data-testid="project-switcher-trigger"]')).toContainText(
      run.localProject.name
    );
    await expect(page.locator(SEL.remoteHosts.hostChip)).toHaveCount(0);
    await openSettings(page);
    const tab = page.locator(SEL.remoteHosts.settingsTab);
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(
      page.getByText("Add a Mac or Linux machine to run projects and agents on it from here")
    ).toBeVisible();
  });

  test("2. Add host probes over real ssh, finds the same build listening, and connects", async () => {
    const started = Date.now();
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    const dialog = page.locator(SEL.remoteHosts.addHostDialog);
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder("user@studio-03").fill(SSH_ALIAS);
    await dialog.getByPlaceholder(SSH_ALIAS).fill(HOST_NAME);
    await dialog.getByRole("button", { name: "Check host" }).click();

    // The probe ran over the real ssh: the wrapper saw it.
    await expect(dialog).toContainText(/SSH\s*Works/, { timeout: 60_000 });
    await expect(dialog).toContainText(/Platform\s*macOS/);
    await expect(dialog).toContainText(/Matches this machine\s*Same build/);
    await expect(dialog).toContainText(/Host mode\s*Listening/);
    expect(await run.wrapper.invocations()).toContain(SSH_ALIAS);
    timings.probeMs = Date.now() - started;

    await dialog.getByRole("button", { name: "Continue" }).click();
    // Listening for this run, not switched on for good: skip the bootstrap,
    // which would start the installed app at login on this Mac.
    await expect(dialog).toContainText("isn't switched on there");
    await dialog.getByRole("button", { name: "Skip" }).click();
    await dialog.getByRole("button", { name: "Add host", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    const row = page.locator('[id="hosts-list"]');
    await expect(row).toContainText(HOST_NAME);
    await expect(row).toContainText(/\bConnected\b/, { timeout: 60_000 });
    timings.addHostMs = Date.now() - started;

    const hosts = (await page.evaluate(() =>
      window.electron.remoteHosts.list()
    )) as unknown as Array<{
      descriptor?: { id: string; name: string };
      id?: string;
      name?: string;
    }>;
    const entry = hosts
      .map((h) => h.descriptor ?? (h as { id: string; name: string }))
      .find((d) => d.name === HOST_NAME);
    expect(entry, JSON.stringify(hosts)).toBeTruthy();
    run.hostId = entry!.id;
    await page.locator(SEL.settings.closeButton).first().click();
  });

  test("3. the host chip switches the window to the host's project", async () => {
    const started = Date.now();
    const page = run.b.window;
    const chip = page.locator(SEL.remoteHosts.hostChip);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", /^Host: This Mac/);
    await chip.click();
    await page.locator(SEL.remoteHosts.hostMenuRow(run.hostId)).click();
    // With a project open, the chip offers to bring it along; just switch.
    await page.locator(SEL.remoteHosts.switchDialogJustSwitch).click();
    // Nothing of this machine's to return to there: the host's project list.
    const option = page.locator(SEL.remoteHosts.projectPickerOption(run.hostProject.name));
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.click();

    run.remotePage = await waitForView(run.b.app, run.hostId, run.hostProject.name);
    timings.switchToHostMs = Date.now() - started;

    const remoteChip = run.remotePage.locator(SEL.remoteHosts.hostChip);
    await expect(remoteChip).toBeVisible();
    const label = (await remoteChip.getAttribute("aria-label")) ?? "";
    expect(label).toMatch(/^Host: /);
    expect(label).not.toContain("This Mac");
    await expect(remoteChip).toContainText(/\S/);
    expect(await chipAccentOffenders(remoteChip)).toEqual([]);
    await expect(run.remotePage.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0);

    // The project is open on the host's own screen, which drives it: this
    // window says so and takes over explicitly, and the host's screen says who
    // drives now.
    const driven = run.remotePage.locator(SEL.remoteHosts.drivenElsewhereBanner);
    await expect(driven).toContainText("its own screen");
    await driven.getByRole("button", { name: "Take over" }).click();
    await expect(driven).toHaveCount(0);
    const hostScreen = await waitForView(run.a.app, null, run.hostProject.name);
    const taken = hostScreen.locator(SEL.remoteHosts.takenFromHostBanner);
    await expect(taken).toBeVisible();
    await expect(taken.getByRole("button", { name: "Take back" })).toBeVisible();
    timings.switchAndTakeOverMs = Date.now() - started;
  });

  test("4. a terminal in the host's project runs on the host", async () => {
    const started = Date.now();
    const page = run.remotePage!;
    await openTerminal(page);
    const panel = getFirstGridPanel(page);
    await waitForTerminalReady(page, panel, 60_000);
    // Computed values, so the echoed command line can't satisfy the check.
    await runTerminalCommand(
      page,
      panel,
      'echo "home=$HOME"; echo "dir=$(pwd -P)"; echo "sum=$((40+2))"'
    );
    await waitForTerminalText(panel, "sum=42", 30_000);
    const text = await getTerminalText(panel);
    // Only app A's pty has HOME set to the ssh session's home.
    expect(text).toContain(`home=${run.sshd.home}`);
    expect(text).toContain(`dir=${realpathSync(run.hostProject.dir)}`);
    timings.terminalMs = Date.now() - started;
  });

  test("5. a killed ControlMaster: the banner says reconnecting, the link recovers, output is replayed", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    const go = path.join(run.root, `go-${NONCE}`);
    const emitted = path.join(run.root, `late-${NONCE}`);

    // Started before the kill; emits only once the link is down.
    await runTerminalCommand(
      page,
      panel,
      `while [ ! -e '${go}' ]; do sleep 0.2; done; echo "late=$((6*7))"; touch '${emitted}'`
    );

    const masters = await liveMasters();
    expect(masters.length, "no ControlMaster answered under the Shell's userData").toBeGreaterThan(
      0
    );
    // Keep new connections waiting, so the outage lasts until the test lets go.
    await run.wrapper.hold();
    const killedAt = Date.now();
    try {
      for (const pid of masters) process.kill(pid, "SIGKILL");
      run.killedMaster = masters[0]!;

      const banner = page
        .getByRole("status")
        .filter({ hasText: /Connection to .+ lost\. Reconnecting/ });
      await expect(banner).toBeVisible({ timeout: 30_000 });
      timings.bannerAfterKillMs = Date.now() - killedAt;

      // The host emits while no Shell is attached.
      await fs.writeFile(go, "");
      await expect.poll(() => existsSync(emitted), { timeout: 15_000 }).toBe(true);
      expect(await getTerminalText(panel)).not.toContain("late=42");
    } finally {
      await run.wrapper.release();
    }

    await expect(page.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
      timeout: 60_000,
    });
    timings.recoveredAfterKillMs = Date.now() - killedAt;
    // Replayed from the host's ring.
    await waitForTerminalText(panel, "late=42", 30_000);

    const newMasters = await liveMasters();
    expect(newMasters.length).toBeGreaterThan(0);
    expect(newMasters).not.toContain(run.killedMaster);

    // The same terminal still takes input.
    await runTerminalCommand(page, panel, 'echo "after=$((7*7))"');
    await waitForTerminalText(panel, "after=49", 30_000);
  });

  test("6. the chip switches back to This Mac and its project", async () => {
    const started = Date.now();
    const page = run.remotePage!;
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.locator(SEL.remoteHosts.hostMenuRow("local")).click();
    await page.locator(SEL.remoteHosts.switchDialogJustSwitch).click();
    const local = await waitForView(run.b.app, null, run.localProject.name);
    await expect(local.locator(SEL.remoteHosts.hostChip)).toHaveAttribute(
      "aria-label",
      /^Host: This Mac/
    );
    await expect(local.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0);
    timings.switchBackMs = Date.now() - started;
  });
});
