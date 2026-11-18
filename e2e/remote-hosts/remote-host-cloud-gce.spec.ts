import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { makeShortTempRoot, startPrivateSshd, type PrivateSshd } from "../helpers/privateSshd";
import {
  FAKE_GCE_CLIENT_EMAIL,
  FAKE_GCE_PROJECT,
  makeFakeServiceAccountKey,
  startFakeGce,
  type FakeGce,
} from "../helpers/fakeGce";

/**
 * Google Cloud hosts end to end, against a fake Compute Engine API whose VMs
 * are one private sshd on this Mac in front of a real Host app (App A, Host
 * mode on). App B, the Shell, is driven through its own UI: connect an
 * account with a service-account key file and a project, create a VM from
 * Add host, set it up and connect over real ssh with the host key pinned from
 * guest attributes, stop it, change its runtime limit while stopped, start
 * it, and delete it.
 *
 * A VM's sshd listens on port 22 as `daintree`; the private sshd can't, so the
 * Shell's ssh (DAINTREE_SSH) is a wrapper that adds the private port and this
 * Mac's user on the command line, ahead of the app-owned config that says
 * `Port 22` and `User daintree`. Everything else (alias, identity, pinned
 * known_hosts) comes from that config as it would for a real VM.
 */

const HOST_NAME = "gce-e2e";

interface Run {
  root: string;
  sshd: PrivateSshd;
  gce: FakeGce;
  keyFilePath: string;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  logs: { a: string[]; b: string[] };
  hostId: string;
}

const run = { logs: { a: [], b: [] }, hostId: "" } as unknown as Run;

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

async function cloudHost(page: Page) {
  const snapshot = await page.evaluate(() => window.electron.cloudHosts.getSnapshot());
  return snapshot.hosts.find((entry) => entry.hostId === run.hostId) ?? null;
}

async function linkStatus(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.electron.remoteHosts.list());
  return entries.find((entry) => entry.descriptor.id === run.hostId)?.connection.status;
}

function gceCalls(method: string, suffix: RegExp) {
  return run.gce.requests.filter((r) => r.method === method && suffix.test(r.path));
}

/** Inserts only: `POST .../zones/{zone}/instances` exactly, not an instance's actions. */
function inserts() {
  return gceCalls("POST", /\/zones\/[a-z0-9-]+\/instances$/);
}

test.describe.serial("Cloud hosts: a Google Compute Engine VM as a Remote Host", () => {
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
    run.root = await makeShortTempRoot("dsg-");
    run.sshd = await startPrivateSshd(run.root);
    const { keyFile, publicKeyPem } = makeFakeServiceAccountKey();
    run.keyFilePath = path.join(run.root, "daintree-e2e-key.json");
    await fs.writeFile(run.keyFilePath, keyFile, { mode: 0o600 });
    run.gce = await startFakeGce({ sshdRoot: run.root, publicKeyPem });
    const wrapper = path.join(run.root, "ssh-to-vm");
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\nexec /usr/bin/ssh -p ${run.sshd.port} -l ${os.userInfo().username} "$@"\n`,
      { mode: 0o755 }
    );
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "gce-host" });
    const localFixture = createFixtureRepo({ name: "gce-shell" });
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
      env: { DAINTREE_GCE_API_URL: run.gce.url, DAINTREE_SSH: wrapper },
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
    const file = `${run.root}-gce-diagnostics.log`;
    await fs
      .writeFile(
        file,
        [
          `# ${info.title}`,
          `## Compute Engine requests\n${JSON.stringify(run.gce?.requests ?? [], null, 2)}`,
          `## Shell console\n${run.logs.b.join("\n")}`,
          `## Host console\n${run.logs.a.join("\n")}`,
          `## sshd log\n${await fs.readFile(run.sshd?.logPath ?? "", "utf8").catch(() => "(none)")}`,
        ].join("\n\n")
      )
      .catch(() => {});
    console.log(`[gce e2e] diagnostics: ${file}`);
  });

  test.afterAll(async () => {
    try {
      if (run.b?.app) await closeApp(run.b.app);
    } finally {
      if (run.a?.app) await closeApp(run.a.app);
      await run.gce?.stop();
      await run.sshd?.stop();
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. connects a Google Cloud account with a key file and a project, checked before it's kept", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    const section = page.locator('[id="hosts-cloud-providers"]');
    await section.getByTestId("cloud-connect-account").click();
    await page.getByRole("menuitem", { name: "Google Cloud" }).click();
    const dialog = page.getByTestId("connect-cloud-account-dialog");
    await expect(dialog).toBeVisible();

    await dialog
      .getByTestId("cloud-account-credential-serviceAccountKey")
      .setInputFiles(run.keyFilePath);
    await expect(dialog).toContainText("daintree-e2e-key.json");
    await dialog.getByTestId("cloud-account-credential-projectId").fill("someone-elses-project");
    await dialog.getByRole("button", { name: "Check credentials" }).click();
    await expect(dialog.getByRole("alert")).toContainText("isn't allowed");

    await dialog.getByTestId("cloud-account-credential-projectId").fill(FAKE_GCE_PROJECT);
    await dialog.getByRole("button", { name: "Check credentials" }).click();
    await expect(dialog.getByRole("radio", { name: new RegExp(FAKE_GCE_PROJECT) })).toBeChecked();
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText(FAKE_GCE_PROJECT);

    // A token was asked for with a signed assertion, at the fake's own token URL.
    expect(run.gce.requests.some((r) => r.path === "/token")).toBe(true);
    const snapshot = JSON.stringify(
      await page.evaluate(() => window.electron.cloudHosts.getSnapshot())
    );
    expect(snapshot).toContain(FAKE_GCE_CLIENT_EMAIL);
    expect(snapshot).not.toContain("PRIVATE KEY");
    const config = await fs.readFile(path.join(run.shellUserData, "config.json"), "utf8");
    expect(config).not.toContain("PRIVATE KEY");
  });

  test("2. creates a VM from Add host and connects with the host key its guest published", async () => {
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).first().click();
    const addHost = page.locator(SEL.remoteHosts.addHostDialog);
    await addHost.getByRole("button", { name: "Create a cloud machine instead" }).click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await expect(dialog).toBeVisible();
    // A VM made elsewhere never got Daintree's key, so only a new one is offered.
    await expect(dialog.getByRole("radio", { name: "Existing machine" })).toHaveCount(0);
    await dialog.getByTestId("add-cloud-host-name").fill(HOST_NAME);
    await expect(dialog.getByTestId("add-cloud-host-review")).toContainText(
      "can't be extended while it runs"
    );
    expect(inserts()).toHaveLength(0);

    await dialog.getByRole("button", { name: "Create and connect" }).click();
    const setup = page.locator(SEL.remoteHosts.addHostDialog);
    await expect(setup).toContainText(/Host mode\s*Listening/, { timeout: 120_000 });

    expect(inserts()).toHaveLength(1);
    const insert = inserts()[0]!;
    expect(insert.path).toBe(
      `/compute/v1/projects/${FAKE_GCE_PROJECT}/zones/us-central1-a/instances`
    );
    expect(insert.query.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const body = insert.body as {
      metadata: { items: { key: string; value: string }[] };
      scheduling: unknown;
      networkInterfaces: { subnetwork: string }[];
    };
    const metadata = Object.fromEntries(body.metadata.items.map((item) => [item.key, item.value]));
    expect(metadata["ssh-keys"]).toMatch(/^daintree:ssh-ed25519 /);
    expect(metadata["ssh-keys"]).not.toMatch(/PRIVATE/);
    expect(metadata["enable-guest-attributes"]).toBe("TRUE");
    expect(metadata["enable-oslogin"]).toBe("FALSE");
    expect(body.scheduling).toEqual({
      maxRunDuration: { seconds: "7200" },
      instanceTerminationAction: "STOP",
    });
    expect(body.networkInterfaces[0]!.subnetwork).toBe("regions/us-central1/subnetworks/default");
    expect(gceCalls("GET", /\/getGuestAttributes$/).length).toBeGreaterThan(0);

    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    const entry = hosts.find((h) => h.descriptor.name === HOST_NAME);
    expect(entry?.descriptor.connection.kind).toBe("cloud");
    run.hostId = entry!.descriptor.id;

    const close = setup.getByRole("button", { name: /^(Done|Close|Cancel)$/ }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");

    // The route is a VM's own: port 22 as daintree, the published key pinned under an alias.
    const machines = path.join(run.shellUserData, "rh", "cloud", "machines");
    const [bindingDir] = await fs.readdir(machines);
    const sshConfig = await fs.readFile(path.join(machines, bindingDir!, "config"), "utf8");
    expect(sshConfig).toContain("HostName 127.0.0.1");
    expect(sshConfig).toContain("Port 22");
    expect(sshConfig).toContain("User daintree");
    expect(sshConfig).toContain("StrictHostKeyChecking yes");
    const knownHosts = await fs.readFile(path.join(machines, bindingDir!, "known_hosts"), "utf8");
    const hostKey = (await fs.readFile(path.join(run.root, "hostkey.pub"), "utf8"))
      .split(" ")
      .slice(0, 2)
      .join(" ");
    expect(knownHosts.trim()).toBe(`dtc-${bindingDir} ${hostKey}`);
  });

  test("3. a limit changed while stopped is set before the next start", async () => {
    const page = run.b.window;
    await page.evaluate((id) => window.electron.cloudHosts.stopHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");
    expect(gceCalls("POST", /\/stop$/)).toHaveLength(1);

    await page.evaluate(
      (id) => window.electron.cloudHosts.setLifetime({ hostId: id, lifetimeHours: 4 }),
      run.hostId
    );
    // Nothing is sent while it's stopped: the limit goes with the next start.
    expect(gceCalls("POST", /\/setScheduling$/)).toHaveLength(0);

    await page.evaluate((id) => window.electron.cloudHosts.startHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("running");
    const scheduling = gceCalls("POST", /\/setScheduling$/);
    const starts = gceCalls("POST", /\/start$/);
    expect(scheduling).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(scheduling[0]!.at).toBeLessThanOrEqual(starts[0]!.at);
    expect(scheduling[0]!.body).toMatchObject({
      maxRunDuration: { seconds: "14400" },
      instanceTerminationAction: "STOP",
    });
    expect((await cloudHost(page))?.lifetimeSeconds).toBe(14_400);

    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
  });

  test("4. deleting the VM removes it from the project and the host from the list", async () => {
    const page = run.b.window;
    const status = await cloudHost(page);
    await page.evaluate(
      ({ hostId, resourceId }) => window.electron.cloudHosts.deleteMachine({ hostId, resourceId }),
      { hostId: run.hostId, resourceId: status!.resourceId }
    );
    expect(run.gce.instances.size).toBe(0);
    expect(gceCalls("DELETE", /\/instances\/\d+$/)).toHaveLength(1);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.electron.remoteHosts.list())).some(
          (h) => h.descriptor.id === run.hostId
        )
      )
      .toBe(false);
  });
});
