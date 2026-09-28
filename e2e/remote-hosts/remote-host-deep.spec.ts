import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
 * Remote Hosts under stress, over real ssh, between real app instances on this
 * Mac: the same harness as remote-host-ssh.spec.ts, pushed further — terminal
 * throughput and control keys, resize, several terminals, uploads, port
 * forwards, worktrees made on the host, a second Shell contending for the drive
 * lease, a full sshd outage and a crashed Host.
 *
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
  c: AppContext | null;
  thirdUserData: string;
  /** Console lines of every page and the main process, per app. */
  logs: { a: string[]; b: string[]; c: string[] };
  hostId: string;
  remotePage: Page | null;
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

test.describe.serial("Remote hosts deep: a Shell drives a Host over real ssh", () => {
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

  // ── Terminal behaviour over the link ──

  test("3. a flood of output arrives complete and the terminal stays responsive", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    const started = Date.now();
    await runTerminalCommand(page, panel, 'seq 1 200000; echo "flood=$((100*2))done"');
    await waitForTerminalText(panel, "flood=200done", 120_000);
    timings.flood200kLinesMs = Date.now() - started;
    const text = await getTerminalText(panel);
    // The last numbers before the marker are all there, in order.
    expect(text).toMatch(/199998\s+199999\s+200000\s+flood=200done/);
    const echoStarted = Date.now();
    await runTerminalCommand(page, panel, 'echo "after-flood=$((3*3))"');
    await waitForTerminalText(panel, "after-flood=9", 30_000);
    timings.echoAfterFloodMs = Date.now() - echoStarted;
  });

  test("4. multibyte text survives the link intact", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    await runTerminalCommand(page, panel, "printf 'u8=%s|%s|%s\\n' 日本語 ünïcødé ☃✓");
    await waitForTerminalText(panel, "u8=日本語|ünïcødé|☃✓", 30_000);
  });

  test("5. Ctrl-C interrupts a host process and the shell keeps working", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    await runTerminalCommand(page, panel, 'sleep 600; echo "slept=$((1+1))through"');
    await page.waitForTimeout(500);
    await panel.locator(".xterm").first().click();
    await page.keyboard.press("Control+C");
    await runTerminalCommand(page, panel, 'echo "after-int=$((5*5))"');
    await waitForTerminalText(panel, "after-int=25", 15_000);
    expect(await getTerminalText(panel)).not.toContain("slept=2through");
  });

  test("6. resizing the Shell's window resizes the host's pty", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    const readSize = async (tag: string) => {
      await runTerminalCommand(page, panel, `echo "${tag}=$(stty size | tr ' ' x)"`);
      let found: { rows: number; cols: number } | null = null;
      await expect
        .poll(
          async () => {
            const m = new RegExp(`${tag}=(\\d+)x(\\d+)`).exec(await getTerminalText(panel));
            found = m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
            return found !== null;
          },
          { timeout: 15_000 }
        )
        .toBe(true);
      return found as { rows: number; cols: number } | null;
    };
    const before = await readSize("sizeA");
    expect(before, "stty size before resize").not.toBeNull();
    await run.b.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1000, 700);
    });
    await expect
      .poll(async () => (await readSize(`sizeB${Date.now() % 100000}`))?.cols, { timeout: 20_000 })
      .toBeLessThan(before!.cols);
    await sizeWindow(run.b.app);
  });

  test("7. several terminals run side by side on the host", async () => {
    const page = run.remotePage!;
    for (let i = 0; i < 3; i++) await openTerminal(page);
    const panels = page.locator("[data-panel-id]");
    await expect.poll(async () => panels.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    const count = await panels.count();
    const marks: string[] = [];
    for (let i = 0; i < count; i++) {
      const panel = panels.nth(i);
      await waitForTerminalReady(page, panel, 60_000);
      const file = path.join(run.hostProject.dir, `.multi-${NONCE}-${i}`);
      marks.push(file);
      await runTerminalCommand(page, panel, `echo $$ > '${file}'`);
    }
    for (const file of marks) {
      await expect.poll(() => existsSync(file), { timeout: 15_000 }).toBe(true);
    }
    // Four distinct shells, not one echoed four times.
    const pids = new Set(
      await Promise.all(marks.map(async (f) => (await fs.readFile(f, "utf8")).trim()))
    );
    expect(pids.size).toBe(marks.length);
    for (const file of marks) await fs.rm(file, { force: true });
  });

  // ── Files, ports and worktrees on the host ──

  test("8. an upload lands byte-for-byte in the host's inbox, and a hostile name stays inside it", async () => {
    const page = run.remotePage!;
    const size = 3 * 1024 * 1024 + 7;
    const upload = (name: string, bytes: number[] | Uint8Array) =>
      page.evaluate(
        async ({ hostId, name, bytes, opId }) =>
          window.electron.fileTransfer.uploadBytes({
            hostId,
            bytes: new Uint8Array(bytes),
            name,
            mimeType: "application/octet-stream",
            destination: { kind: "inbox", bucket: "files" },
            opId,
          }),
        { hostId: run.hostId, name, bytes: Array.from(bytes), opId: randomUUID() }
      );
    // Made and hashed in the page, and only the upload call timed, so the
    // number is the link's, not Playwright's serialisation of the bytes.
    const measured = (await page.evaluate(
      async ({ hostId, size, opId }) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 65_536) {
          crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65_536)));
        }
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const t0 = performance.now();
        const result = await window.electron.fileTransfer.uploadBytes({
          hostId,
          bytes,
          name: "payload.bin",
          mimeType: "application/octet-stream",
          destination: { kind: "inbox", bucket: "files" },
          opId,
        });
        return { result, digest, ms: performance.now() - t0 };
      },
      { hostId: run.hostId, size, opId: randomUUID() }
    )) as { result: { hostPath: string; bytes: number }; digest: string; ms: number };
    timings.upload3MiBMs = Math.round(measured.ms);
    const result = measured.result;
    expect(result.bytes).toBe(size);
    const landed = await fs.readFile(result.hostPath);
    expect(createHash("sha256").update(landed).digest("hex")).toBe(measured.digest);

    const hostile = (await upload("../../../../evil-" + NONCE + ".sh", [35, 33])) as {
      hostPath: string;
    };
    // The name is flattened into the same bucket as any other upload: not one
    // level above it, and not wherever the dots would have walked to.
    // Each upload gets its own folder under the bucket.
    const bucket = realpathSync(path.dirname(path.dirname(result.hostPath)));
    const landedHostile = realpathSync(hostile.hostPath);
    const rel = path.relative(bucket, landedHostile);
    expect(
      rel.startsWith("..") || path.isAbsolute(rel),
      `escaped the inbox: ${landedHostile}`
    ).toBe(false);
    expect(path.basename(landedHostile)).toBe(`evil-${NONCE}.sh`);
    expect([...(await fs.readFile(landedHostile))]).toEqual([35, 33]);
    for (let up = 1; up <= 4; up++) {
      const walked = path.resolve(bucket, ...Array(up).fill(".."), `evil-${NONCE}.sh`);
      expect(existsSync(walked), `traversal wrote ${walked}`).toBe(false);
    }

    const empty = (await upload("empty.txt", [])) as { hostPath: string; bytes: number };
    expect(empty.bytes).toBe(0);
    expect((await fs.stat(empty.hostPath)).size).toBe(0);
  });

  test("9. the host file picker lists the host project's files", async () => {
    const page = run.remotePage!;
    const listing = (await page.evaluate(
      (dir) => window.electron.hostFiles.listDirectory({ path: dir }),
      run.hostProject.dir
    )) as { entries: Array<{ name: string }> };
    const names = listing.entries.map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    const onDisk = (await fs.readdir(run.hostProject.dir)).filter((n) => !n.startsWith("."));
    for (const name of onDisk) expect(names).toContain(name);
    await expect(
      page.evaluate(() => window.electron.hostFiles.listDirectory({ path: "relative/path" }))
    ).rejects.toThrow();
  });

  test("10. a host dev server is reachable here through a port forward, and stops with it", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    const port = await freePort();
    const marker = `served-${NONCE}`;
    await fs.writeFile(path.join(run.root, `${marker}.txt`), marker);
    await runTerminalCommand(
      page,
      panel,
      `cd '${run.root}' && python3 -m http.server ${port} --bind 127.0.0.1`
    );
    await expect
      .poll(
        async () => {
          const ports = (await page.evaluate(
            (hostId) => window.electron.portForwards.listHostPorts({ hostId }),
            run.hostId
          )) as Array<{ port: number }>;
          return ports.some((p) => p.port === port);
        },
        { timeout: 30_000, message: "the host never listed the dev server's port" }
      )
      .toBe(true);
    const forward = (await page.evaluate(
      ({ hostId, port }) =>
        window.electron.portForwards.forward({ hostId, remotePort: port, label: "e2e" }),
      { hostId: run.hostId, port }
    )) as { forwardId: string; localPort: number };
    const res = await fetch(`http://127.0.0.1:${forward.localPort}/${marker}.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(marker);
    await page.evaluate(
      (forwardId) => window.electron.portForwards.stop({ forwardId }),
      forward.forwardId
    );
    await expect
      .poll(
        async () =>
          fetch(`http://127.0.0.1:${forward.localPort}/`)
            .then(() => "open")
            .catch(() => "closed"),
        { timeout: 15_000 }
      )
      .toBe("closed");
    await panel.locator(".xterm").first().click();
    await page.keyboard.press("Control+C");
    await runTerminalCommand(page, panel, `cd '${run.hostProject.dir}'`);
  });

  test("11. a worktree made on the host shows up in the Shell's worktree list", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    const wtPath = path.join(path.dirname(run.hostProject.dir), `wt-${NONCE}`);
    await runTerminalCommand(
      page,
      panel,
      `git worktree add -q -b e2e-${NONCE} '${wtPath}' && echo "wt=$((2+2))ok" || echo "wt=$((3+3))bad"`
    );
    await expect
      .poll(async () => /wt=(4ok|6bad)/.exec(await getTerminalText(panel))?.[1] ?? null, {
        timeout: 30_000,
      })
      .toBe("4ok");
    await page.evaluate(() => window.electron.worktree.refresh());
    await expect
      .poll(
        async () => {
          const all = (await page.evaluate(() => window.electron.worktree.getAll())) as Array<{
            path: string;
          }>;
          return all.some((w) => realpathSync(w.path) === realpathSync(wtPath));
        },
        { timeout: 30_000, message: "the host's new worktree never reached the Shell" }
      )
      .toBe(true);
    run.hostProject.cleanup = ((prev) => () => {
      removePathSync(wtPath);
      prev();
    })(run.hostProject.cleanup);
  });

  // ── Two Shells, one project: the drive lease ──

  test("12. a second Shell sees who drives, takes over, and the first becomes an observer", async () => {
    run.thirdUserData = path.join(run.root, "shell2");
    await fs.mkdir(run.thirdUserData, { recursive: true, mode: 0o700 });
    const secondLocal = createFixtureRepo({ name: "rh-shell2" });
    run.c = await launchApp({
      userDataDir: run.thirdUserData,
      env: {
        DAINTREE_SSH: run.wrapper.path,
        PATH: `${run.wrapper.binDir}:${process.env.PATH ?? ""}`,
      },
      alongside: true,
    });
    captureLogs(run.c.app, run.logs.c);
    await sizeWindow(run.c.app);
    run.c.window = await openAndOnboardProject(run.c.app, run.c.window, secondLocal.dir);
    const added = (await run.c.window.evaluate(
      ({ name, target }) =>
        window.electron.remoteHosts.add({ name, connection: { kind: "ssh", target } }),
      { name: HOST_NAME, target: SSH_ALIAS }
    )) as { descriptor?: { id: string }; id?: string };
    const cHostId = added.descriptor?.id ?? added.id!;
    expect(cHostId, "the same host keeps its id from a second Shell").toBe(run.hostId);
    await run.c.window.evaluate(
      (hostId) => window.electron.remoteHosts.connect({ hostId }),
      cHostId
    );
    await expect
      .poll(
        async () => {
          const list = (await run.c!.window.evaluate(() =>
            window.electron.remoteHosts.list()
          )) as unknown as Array<{ descriptor: { id: string }; connection: { status: string } }>;
          return list.find((h) => h.descriptor.id === cHostId)?.connection.status ?? "absent";
        },
        { timeout: 60_000, message: "the second Shell never connected" }
      )
      .toBe("connected");

    const hostProjects = (await run.c.window.evaluate(
      (hostId) => window.electron.remoteHosts.listHostProjects({ hostId }),
      cHostId
    )) as Array<{ id: string; name: string }>;
    const target = hostProjects.find((p) => p.name === run.hostProject.name)!;
    expect(target, JSON.stringify(hostProjects)).toBeTruthy();
    await run.c.window.evaluate(
      ({ hostId, projectId }) =>
        window.electron.remoteHosts.switchWindowHost({ hostId, newWindow: false, projectId }),
      { hostId: cHostId, projectId: target.id }
    );
    const cPage = await waitForView(run.c.app, cHostId, run.hostProject.name);

    const bPage = run.remotePage!;
    const cDriven = cPage.locator(SEL.remoteHosts.drivenElsewhereBanner);
    await expect(cDriven).toBeVisible({ timeout: 30_000 });
    // C sees B's terminals, streamed from the host.
    await expect
      .poll(async () => cPage.locator("[data-panel-id]").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    // An observer's keystrokes do not reach the host.
    const cPanel = getFirstGridPanel(cPage);
    const observerFile = path.join(run.root, `observer-${NONCE}`);
    expect(await submitRefusal(cPage, cPanel, `touch '${observerFile}'`)).toBe("DRIVEN_ELSEWHERE");
    await bPage.waitForTimeout(1_000);
    expect(existsSync(observerFile), "an observer's input reached the host").toBe(false);

    await cDriven.getByRole("button", { name: "Take over" }).click();
    await expect(cDriven).toHaveCount(0, { timeout: 15_000 });
    await expect(bPage.locator(SEL.remoteHosts.drivenElsewhereBanner)).toBeVisible({
      timeout: 15_000,
    });

    // Now C drives: its input runs on the host, and B's does not.
    const driverFile = path.join(run.root, `driver-${NONCE}`);
    await runTerminalCommand(cPage, cPanel, `touch '${driverFile}'`);
    await expect.poll(() => existsSync(driverFile), { timeout: 15_000 }).toBe(true);
    const staleFile = path.join(run.root, `stale-${NONCE}`);
    expect(await submitRefusal(bPage, getFirstGridPanel(bPage), `touch '${staleFile}'`)).toBe(
      "DRIVEN_ELSEWHERE"
    );
    await bPage.waitForTimeout(1_000);
    expect(existsSync(staleFile), "a displaced driver's input reached the host").toBe(false);

    // B takes it back.
    await bPage
      .locator(SEL.remoteHosts.drivenElsewhereBanner)
      .getByRole("button", { name: "Take over" })
      .click();
    await expect(cPage.locator(SEL.remoteHosts.drivenElsewhereBanner)).toBeVisible({
      timeout: 15_000,
    });
    const backFile = path.join(run.root, `back-${NONCE}`);
    await runTerminalCommand(bPage, getFirstGridPanel(bPage), `touch '${backFile}'`);
    await expect.poll(() => existsSync(backFile), { timeout: 15_000 }).toBe(true);
    await closeApp(run.c.app);
    run.c = null;
    secondLocal.cleanup();
  });

  // ── Outages ──

  test("12b. repeated reconnects do not leak file descriptors in the Shell", async () => {
    const page = run.remotePage!;
    const shellPid = run.b.app.process().pid!;
    const fdCount = async () => {
      const { execFileSync } = await import("node:child_process");
      return execFileSync("lsof", ["-p", String(shellPid)], { encoding: "utf8" })
        .trim()
        .split("\n").length;
    };
    const counts: number[] = [await fdCount()];
    for (let round = 0; round < 6; round++) {
      const before = await liveMasters();
      for (const pid of before) process.kill(pid, "SIGKILL");
      // Recovery is often faster than the banner's first paint, so wait on a
      // new master rather than on the banner.
      await expect
        .poll(async () => (await liveMasters()).some((pid) => !before.includes(pid)), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect(page.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
        timeout: 60_000,
      });
      await page.waitForTimeout(1_000);
      counts.push(await fdCount());
    }
    console.log(`[remote-hosts deep] Shell fd counts across reconnects ${JSON.stringify(counts)}`);
    timings.fdGrowthOver6Reconnects = counts[counts.length - 1]! - counts[0]!;
    // After the first reconnect settles, the link reopens the same set: a
    // steady per-round rise is a leak, a one-off step is not.
    const settled = counts.slice(1);
    expect(settled[settled.length - 1]! - settled[0]!).toBeLessThanOrEqual(8);
    for (let i = 1; i < settled.length; i++) {
      expect(settled[i]! - settled[i - 1]!, `round ${i} grew`).toBeLessThanOrEqual(6);
    }
  });

  test("13. sshd itself goes away and comes back: the Shell reconnects and replays", async () => {
    const page = run.remotePage!;
    const panel = getFirstGridPanel(page);
    await expect(page.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
      timeout: 30_000,
    });
    const go = path.join(run.root, `go2-${NONCE}`);
    await runTerminalCommand(
      page,
      panel,
      `while [ ! -e '${go}' ]; do sleep 0.2; done; echo "outage=$((8*8))"`
    );
    const oldPort = run.sshd.port;
    await run.sshd.stop();
    for (const pid of await liveMasters().catch(() => [])) process.kill(pid, "SIGKILL");
    const downAt = Date.now();
    await expect(page.locator(SEL.remoteHosts.connectionBanner).first()).toBeVisible({
      timeout: 60_000,
    });
    timings.bannerAfterSshdStopMs = Date.now() - downAt;
    await fs.writeFile(go, "");
    await page.waitForTimeout(3_000);
    run.sshd = await restartSshd(run.sshd, oldPort);
    const upAt = Date.now();
    await expect(page.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0, {
      timeout: 120_000,
    });
    timings.recoveredAfterSshdRestartMs = Date.now() - upAt;
    await waitForTerminalText(panel, "outage=64", 30_000);
    await runTerminalCommand(page, panel, 'echo "post-outage=$((9*9))"');
    await waitForTerminalText(panel, "post-outage=81", 30_000);
  });

  test("14. the Host crashes and restarts: the Shell says so, then reattaches", async () => {
    const page = run.remotePage!;
    const hostPid = run.a.app.process().pid!;
    process.kill(hostPid, "SIGKILL");
    const downAt = Date.now();
    await expect(page.locator(SEL.remoteHosts.connectionBanner).first()).toBeVisible({
      timeout: 60_000,
    });
    timings.bannerAfterHostCrashMs = Date.now() - downAt;

    run.a = await launchApp({
      userDataDir: run.hostUserData,
      env: { HOME: run.sshd.home },
      alongside: true,
    });
    captureLogs(run.a.app, run.logs.a);
    await expect
      .poll(
        async () =>
          (await run.a.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
        { timeout: 60_000, message: "Host mode did not come back after a restart" }
      )
      .toBe(true);
    const upAt = Date.now();
    await expect
      .poll(
        async () => {
          const top = await topViewPage(run.b.app);
          if (!top) return "no-view";
          const banner = await top
            .locator(SEL.remoteHosts.connectionBanner)
            .count()
            .catch(() => -1);
          return banner === 0 ? "ok" : "banner";
        },
        { timeout: 120_000, message: "the Shell never reattached to the restarted Host" }
      )
      .toBe("ok");
    timings.reattachAfterHostRestartMs = Date.now() - upAt;
    const top = (await topViewPage(run.b.app))!;
    expect(await viewHostId(top)).toBe(run.hostId);
    // The restarted Host's own window opened the project first, so it drives now.
    const driven = top.locator(SEL.remoteHosts.drivenElsewhereBanner);
    await expect(driven).toBeVisible({ timeout: 30_000 });
    // A terminal asked for while observing is refused in words, not wire format.
    await openTerminal(top);
    const refused = top.locator("[data-panel-id]").last();
    await expect(refused).toContainText("Couldn't start terminal", { timeout: 30_000 });
    await expect(refused).toContainText("Take it over");
    await expect(refused).not.toContainText("[AppError");
    await refused
      .getByRole("button", { name: /Close|Trash|Remove/ })
      .first()
      .click()
      .catch(() => undefined);
    await driven.getByRole("button", { name: "Take over" }).click();
    await expect(driven).toHaveCount(0, { timeout: 15_000 });
    // A fresh terminal on the restarted Host works.
    await openTerminal(top);
    const panels = top.locator("[data-panel-id]");
    const last = panels.nth((await panels.count()) - 1);
    await waitForTerminalReady(top, last, 60_000);
    await runTerminalCommand(top, last, 'echo "reborn=$((11*11))"');
    await waitForTerminalText(last, "reborn=121", 30_000);
    run.remotePage = top;
  });

  test("15. neither app logged an uncaught error along the way", async () => {
    const bad = (lines: string[]) =>
      lines.filter((l) =>
        /Uncaught|Unhandled|TypeError|ReferenceError|No handler registered/.test(l)
      );
    const report = { a: bad(run.logs.a), b: bad(run.logs.b), c: bad(run.logs.c) };
    console.log(`[remote-hosts deep] error lines ${JSON.stringify(report, null, 2)}`);
    console.log(`[remote-hosts deep] timings ${JSON.stringify(timings)}`);
    expect(report).toEqual({ a: [], b: [], c: [] });
  });
});

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** The same sshd again, same config, keys and port: an outage, not a new host. */
async function restartSshd(previous: PrivateSshd, port: number): Promise<PrivateSshd> {
  const child = spawn(
    "/usr/sbin/sshd",
    ["-D", "-f", path.join(previous.root, "sshd_config"), "-E", previous.logPath],
    { stdio: "ignore" }
  );
  const net = await import("node:net");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("data", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (up) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("sshd did not come back");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    ...previous,
    pid: child.pid!,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Submit as `runTerminalCommand` does and return the refusal's code, or null
 * when the host took the input.
 */
async function submitRefusal(
  page: Page,
  panel: import("@playwright/test").Locator,
  command: string
): Promise<string | null> {
  const id = await panel.getAttribute("data-panel-id");
  return page.evaluate(
    async ({ id, input }) => {
      try {
        await (
          window as unknown as {
            electron: { terminal: { submit(id: string, input: string): Promise<unknown> } };
          }
        ).electron.terminal.submit(id, input);
        return null;
      } catch (error) {
        const match = /^\[AppError\|([A-Z_]+)/.exec(String((error as Error)?.message ?? error));
        return match ? match[1]! : String(error);
      }
    },
    { id: id!, input: `${command}\n` }
  );
}
