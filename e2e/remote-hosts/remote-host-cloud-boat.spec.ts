import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { makeShortTempRoot, startPrivateSshd, type PrivateSshd } from "../helpers/privateSshd";
import { FAKE_BOAT_KEY, startFakeBoat, type FakeBoat } from "../helpers/fakeBoat";

/**
 * Cloud hosts end to end, against a fake Boat API whose one "machine" is a
 * private sshd on this Mac in front of a real Host app (App A, Host mode on).
 * App B, the Shell, is driven through its own UI: connect a Boat account,
 * create a machine from Add host, set it up and connect over real ssh, stop
 * it (and see that a reconnect doesn't wake it), then start it again.
 *
 * The Shell uses the system ssh with no wrapper of ours: everything it needs
 * to reach the machine comes from the app-owned config the cloud host writes.
 * Screenshots go to `.tmp/cloud-boat-shots/` (or DAINTREE_SHOT_DIR).
 */

const HOST_NAME = "boat-e2e";

interface Run {
  root: string;
  sshd: PrivateSshd;
  boat: FakeBoat;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  logs: { a: string[]; b: string[] };
  hostId: string;
  shotDir: string;
  shot: number;
}

const run = { logs: { a: [], b: [] }, hostId: "", shot: 0 } as unknown as Run;

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
    // Already gone.
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  run.shot += 1;
  const file = path.join(run.shotDir, `${String(run.shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
}

async function cloudHost(page: Page) {
  const snapshot = await page.evaluate(() => window.electron.cloudHosts.getSnapshot());
  return snapshot.hosts.find((entry) => entry.hostId === run.hostId) ?? null;
}

async function linkStatus(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.electron.remoteHosts.list());
  return entries.find((entry) => entry.descriptor.id === run.hostId)?.connection.status;
}

/** Create requests only: `POST /sandboxes` exactly, not its sub-routes. */
function creates() {
  return run.boat.requests.filter((r) => r.method === "POST" && r.path === "/sandboxes");
}

/** The page of the view on top of the Shell's first window: a switch replaces it. */
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
        await wc.executeJavaScript(`window.__cloudE2eTopView = ${JSON.stringify(value)}`, true);
        return true;
      }
      return false;
    }, mark)
    .catch(() => false);
  if (!marked) return null;
  for (const page of app.windows()) {
    const seen = await page
      .evaluate(
        () => (window as unknown as { __cloudE2eTopView?: string }).__cloudE2eTopView ?? null
      )
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

async function waitForHostView(hostId: string | null): Promise<Page> {
  let found: Page | null = null;
  await expect
    .poll(
      async () => {
        const page = await topViewPage(run.b.app);
        if (!page) return false;
        if ((await viewHostId(page).catch(() => "?")) !== hostId) return false;
        found = page;
        return true;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return found!;
}

/** A confirm by its title, whichever role its tier gives it. */
function confirmDialog(page: Page, title: string) {
  return page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: title });
}

async function closeSettings(page: Page) {
  const heading = page.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await expect(heading).toBeHidden({ timeout: 10_000 });
}

async function openCloudMachinesMenu(page: Page) {
  await page.locator(SEL.remoteHosts.hostChip).click();
  await page.getByTestId("host-chip-cloud-machines").click();
}

function boatCalls(method: string, pathPrefix: string) {
  return run.boat.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
}

test.describe.serial("Cloud hosts: a Boat machine as a Remote Host", () => {
  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "The private sshd and the host's socket location are macOS-only here",
    });
    test.skip(
      !(process.platform === "darwin" && existsSync("/usr/sbin/sshd")),
      "Needs macOS and /usr/sbin/sshd"
    );
    test.setTimeout(300_000);
    run.root = await makeShortTempRoot("dsb-");
    run.shotDir =
      process.env.DAINTREE_SHOT_DIR ?? path.resolve(process.cwd(), ".tmp/cloud-boat-shots");
    await fs.mkdir(run.shotDir, { recursive: true });
    run.sshd = await startPrivateSshd(run.root);
    run.boat = await startFakeBoat({ sshdPort: run.sshd.port, sshdRoot: run.root });
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "boat-host" });
    const localFixture = createFixtureRepo({ name: "boat-shell" });
    run.hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    run.localProject = { ...localFixture, name: path.basename(localFixture.dir) };

    run.a = await launchApp({
      userDataDir: run.hostUserData,
      env: { HOME: run.sshd.home },
      alongside: true,
    });
    captureLogs(run.a.app, run.logs.a);
    run.a.window = await openAndOnboardProject(run.a.app, run.a.window, run.hostProject.dir);
    await run.a.window.evaluate(() =>
      window.electron.hostMode.setEnabled({ enabled: true, startAtLogin: false })
    );
    await expect
      .poll(
        async () =>
          (await run.a.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
        { timeout: 30_000 }
      )
      .toBe(true);

    run.b = await launchApp({
      userDataDir: run.shellUserData,
      env: { DAINTREE_BOAT_API_URL: run.boat.url },
      alongside: true,
    });
    captureLogs(run.b.app, run.logs.b);
    await run.b.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 950);
    });
    run.b.window = await openAndOnboardProject(run.b.app, run.b.window, run.localProject.dir);
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status === info.expectedStatus) return;
    const file = `${run.root}-cloud-diagnostics.log`;
    await fs
      .writeFile(
        file,
        [
          `# ${info.title}`,
          `## Boat requests\n${JSON.stringify(run.boat?.requests ?? [], null, 2)}`,
          `## Shell console\n${run.logs.b.join("\n")}`,
          `## Host console\n${run.logs.a.join("\n")}`,
          `## sshd log\n${await fs.readFile(run.sshd?.logPath ?? "", "utf8").catch(() => "(none)")}`,
        ].join("\n\n")
      )
      .catch(() => {});
    console.log(`[cloud e2e] diagnostics: ${file}`);
  });

  test.afterAll(async () => {
    try {
      if (run.b?.app) await closeApp(run.b.app);
    } finally {
      if (run.a?.app) await closeApp(run.a.app);
      await run.boat?.stop();
      await run.sshd?.stop();
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. connects a Boat account from Settings → Hosts without the key ever reaching the page", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    const section = page.locator('[id="hosts-cloud-providers"]');
    await expect(section).toContainText("Connect a Boat account");
    await shoot(page, "settings-empty-cloud-providers");

    await section.getByTestId("cloud-connect-account").click();
    const dialog = page.getByTestId("connect-cloud-account-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("cloud-account-api-key").fill("boat_e2e_wrong_key_000000000000");
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("alert")).toContainText("didn't accept");
    await shoot(page, "connect-account-bad-key");

    await dialog.getByTestId("cloud-account-api-key").fill(FAKE_BOAT_KEY);
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("radio", { name: "Personal" })).toBeChecked();
    await shoot(page, "connect-account-checked");
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText("e2e-user");
    await expect(section).toContainText("Key ending stuv");
    await shoot(page, "settings-account-connected");

    // Wallets were probed explicitly; the key never left main for the page.
    expect(boatCalls("GET", "/sandboxes?limit=1").map((r) => r.org)).toContain("personal");
    const snapshot = JSON.stringify(
      await page.evaluate(() => window.electron.cloudHosts.getSnapshot())
    );
    expect(snapshot).not.toContain(FAKE_BOAT_KEY);
    const config = await fs.readFile(path.join(run.shellUserData, "config.json"), "utf8");
    expect(config).not.toContain(FAKE_BOAT_KEY);
  });

  test("2. creates a machine from Add host and connects to it over real ssh", async () => {
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).first().click();
    const addHost = page.locator(SEL.remoteHosts.addHostDialog);
    await addHost.getByRole("button", { name: "Create a cloud machine instead" }).click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("add-cloud-host-name").fill(HOST_NAME);
    await expect(dialog.getByRole("radio", { name: /^Default/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^Extra large/ })).toBeDisabled();
    await expect(dialog.getByTestId("add-cloud-host-review")).toContainText("$0.036 an hour");
    await shoot(page, "add-cloud-host-form");
    expect(creates()).toHaveLength(0);

    await dialog.getByRole("button", { name: "Create and connect" }).click();
    await expect(page.getByTestId("add-cloud-host-progress")).toBeVisible();
    await shoot(page, "add-cloud-host-starting");

    // The machine came up: the usual setup check runs over ssh through the cloud route.
    const setup = page.locator(SEL.remoteHosts.addHostDialog);
    await expect(setup).toContainText(/Host mode\s*Listening/, { timeout: 90_000 });
    await shoot(page, "cloud-host-setup-check");

    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.idempotencyKey).toBeTruthy();
    expect(creates()[0]!.org).toBe("personal");
    expect(creates()[0]!.body).toMatchObject({
      name: HOST_NAME,
      type: "default",
      snapshots: true,
      ttlSeconds: 7200,
    });
    const sshKeys = boatCalls("POST", "/sandboxes/");
    expect(sshKeys.some((r) => r.path.endsWith("/sshkey"))).toBe(true);
    const sent = sshKeys.find((r) => r.path.endsWith("/sshkey"))!.body as { key: string };
    expect(sent.key).toMatch(/^ssh-ed25519 /);
    expect(sent.key).not.toMatch(/PRIVATE/);

    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    const entry = hosts.find((h) => h.descriptor.name === HOST_NAME);
    expect(entry?.descriptor.connection.kind).toBe("cloud");
    run.hostId = entry!.descriptor.id;

    const close = setup.getByRole("button", { name: /^(Done|Close|Cancel)$/ }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
    await expect(page.locator('[id="hosts-list"]')).toContainText("Connected", { timeout: 30_000 });
    await shoot(page, "hosts-list-cloud-connected");

    // The route pins the host key Boat returned, under an alias, with Daintree's own key.
    const machines = path.join(run.shellUserData, "rh", "cloud", "machines");
    const [bindingDir] = await fs.readdir(machines);
    const sshConfig = await fs.readFile(path.join(machines, bindingDir!, "config"), "utf8");
    expect(sshConfig).toContain("StrictHostKeyChecking yes");
    expect(sshConfig).toContain(`Port ${run.sshd.port}`);
    expect(sshConfig).toContain("IdentitiesOnly yes");
    const knownHosts = await fs.readFile(path.join(machines, bindingDir!, "known_hosts"), "utf8");
    const hostKey = (await fs.readFile(path.join(run.root, "hostkey.pub"), "utf8"))
      .split(" ")
      .slice(0, 2)
      .join(" ");
    expect(knownHosts.trim()).toBe(`dtc-${bindingDir} ${hostKey}`);
  });

  test("3. stopping the machine lets go of the link, and reconnecting never wakes it", async () => {
    const page = run.b.window;
    await page.evaluate((id) => window.electron.cloudHosts.stopHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");
    expect(await linkStatus(page)).not.toBe("connected");
    expect(boatCalls("POST", "/sandboxes/").some((r) => r.path.endsWith("/stop"))).toBe(true);
    await shoot(page, "hosts-list-cloud-stopped");

    const resumesBefore = boatCalls("POST", "/sandboxes/").filter((r) =>
      r.path.endsWith("/resume")
    ).length;
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 30_000 }).toBe("unreachable");
    const entries = await page.evaluate(() => window.electron.remoteHosts.list());
    const state = entries.find((e) => e.descriptor.id === run.hostId)?.connection as
      { detail?: string | null; stoppedRetrying?: boolean } | undefined;
    expect(state?.detail ?? "").toContain("stopped");
    expect(state?.stoppedRetrying).toBe(true);
    const resumesAfter = boatCalls("POST", "/sandboxes/").filter((r) =>
      r.path.endsWith("/resume")
    ).length;
    expect(resumesAfter).toBe(resumesBefore);
    await shoot(page, "hosts-list-cloud-stopped-dial-refused");
  });

  test("4. a person's Start resumes the machine and the host reconnects with fresh access", async () => {
    const page = run.b.window;
    const keysBefore = boatCalls("POST", "/sandboxes/").filter((r) =>
      r.path.endsWith("/sshkey")
    ).length;
    await page.evaluate((id) => window.electron.cloudHosts.startHost({ hostId: id }), run.hostId);
    expect((await cloudHost(page))?.machine).toBe("running");
    const resumes = boatCalls("POST", "/sandboxes/").filter((r) => r.path.endsWith("/resume"));
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.body).toMatchObject({ ttlSeconds: 7200 });
    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
    const keysAfter = boatCalls("POST", "/sandboxes/").filter((r) =>
      r.path.endsWith("/sshkey")
    ).length;
    expect(keysAfter).toBeGreaterThan(keysBefore);
    await shoot(page, "hosts-list-cloud-restarted");
  });

  test("5. the host menu stops a machine after saying what ends with it", async () => {
    const page = run.b.window;
    await closeSettings(page);
    await openCloudMachinesMenu(page);
    const stopItem = page.locator(`[data-cloud-machine-host-id="${run.hostId}"]`);
    await expect(stopItem).toContainText(`Stop ${HOST_NAME}`);
    await expect(stopItem).toContainText("$0.036/h");
    await shoot(page, "host-menu-cloud-machines");
    await stopItem.click();
    const confirm = confirmDialog(page, `Stop '${HOST_NAME}'?`);
    await expect(confirm).toBeVisible();
    await shoot(page, "host-menu-stop-confirm");
    await confirm.getByRole("button", { name: "Stop machine" }).click();
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");

    // Picking the stopped host asks before starting it.
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.locator(SEL.remoteHosts.hostMenuRow(run.hostId)).click();
    const startAsk = confirmDialog(page, `Start '${HOST_NAME}'?`);
    await expect(startAsk).toContainText("$0.036 an hour");
    await shoot(page, "host-menu-start-confirm");
    const resumesBefore = boatCalls("POST", "/sandboxes/").filter((r) =>
      r.path.endsWith("/resume")
    ).length;
    await startAsk.getByRole("button", { name: "Cancel" }).click();
    expect(boatCalls("POST", "/sandboxes/").filter((r) => r.path.endsWith("/resume")).length).toBe(
      resumesBefore
    );
  });

  test("6. Settings shows the machine's state, starts it from the row, and details it", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    const list = page.locator('[id="hosts-list"]');
    await expect(list).toContainText("Machine stopped");
    await expect(list).toContainText("Boat · e2e-user");
    await expect(list.getByRole("button", { name: `Bring back ${HOST_NAME}` })).toHaveCount(0);
    await shoot(page, "settings-row-cloud-stopped");
    await list.getByRole("button", { name: `Start ${HOST_NAME}` }).click();
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("running");
    await list.getByRole("button", { name: `Details for ${HOST_NAME}` }).click();
    const section = page.locator('[id="host-cloud-machine"]');
    await expect(section).toBeVisible();
    await expect(section.getByTestId("cloud-machine-state")).toContainText("Machine running");
    await expect(section).toContainText("$0.036 an hour while running");
    await expect(section).toContainText("Machine bx_");
    await shoot(page, "host-detail-cloud-machine");
  });

  test("7. a window on a stopped machine offers Start and reconnect, and reconnects", async () => {
    const page = run.b.window;
    await closeSettings(page);
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.locator(SEL.remoteHosts.hostMenuRow(run.hostId)).click();
    const option = page.locator(SEL.remoteHosts.projectPickerOption(run.hostProject.name));
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.click();
    const remote = await waitForHostView(run.hostId);
    await expect(remote.locator(SEL.remoteHosts.hostChip)).toHaveAttribute(
      "aria-label",
      new RegExp(`^Working on Boat · ${HOST_NAME}`)
    );
    await shoot(remote, "remote-window-boat-chip");

    await remote.evaluate((id) => window.electron.cloudHosts.stopHost({ hostId: id }), run.hostId);
    const banner = remote
      .locator('[role="status"]')
      .filter({ hasText: /machine is stopped|Starting .*machine/ });
    await expect(banner).toContainText(`${HOST_NAME}'s machine is stopped`, { timeout: 60_000 });
    await shoot(remote, "remote-window-machine-stopped-banner");
    await banner.getByRole("button", { name: "Start and reconnect" }).click();
    await expect.poll(() => linkStatus(remote), { timeout: 90_000 }).toBe("connected");
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await shoot(remote, "remote-window-reconnected");
  });

  test("8. removing the host can delete its machine, after its name is typed", async () => {
    const remote = await waitForHostView(run.hostId);
    // Back to this machine, then remove from Settings.
    await remote.locator(SEL.remoteHosts.hostChip).click();
    await remote.locator(SEL.remoteHosts.hostMenuRow("local")).click();
    const page = await waitForHostView(null);
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    await page
      .locator('[id="hosts-list"]')
      .getByRole("button", { name: `Remove ${HOST_NAME} from this device` })
      .click();
    const dialog = confirmDialog(page, `Remove '${HOST_NAME}'?`);
    await expect(dialog.getByTestId("remove-cloud-host-choice")).toContainText("keeps billing");
    await shoot(page, "remove-cloud-host-keep");
    await dialog.getByRole("radio", { name: "Delete the machine too" }).check();
    const deleteButton = dialog.getByRole("button", { name: "Delete machine" });
    // Gated on the exact name: nothing, then a wrong name, leave it unavailable.
    await expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel(`Type ${HOST_NAME} to confirm`).fill(`${HOST_NAME}-x`);
    await expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    expect(run.boat.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    await dialog.getByLabel(`Type ${HOST_NAME} to confirm`).fill(HOST_NAME);
    await expect(deleteButton).not.toHaveAttribute("aria-disabled", "true");
    await shoot(page, "remove-cloud-host-delete");
    await dialog.getByRole("button", { name: "Delete machine" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const deletes = run.boat.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(run.boat.sandboxes.size).toBe(0);
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    expect(hosts.find((h) => h.descriptor.id === run.hostId)).toBeUndefined();
    await shoot(page, "settings-after-delete");
  });
});
