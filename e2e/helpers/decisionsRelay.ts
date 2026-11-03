/**
 * A Decisions relay run locally from a daintreehq/decisions checkout with
 * `wrangler dev`: the real Worker, Durable Object and phone app in workerd,
 * with R2 and the Durable Object's SQLite kept in a directory of its own.
 * Stopping and starting it again on the same directory is a relay that went
 * away and came back with everything it held.
 *
 * The checkout needs `pnpm install && pnpm build` first (the Worker serves
 * `app/dist`). Dictation keys in the checkout's `.dev.vars` are used as they
 * are; the claim secret is always this run's own. Unix only: stopping it
 * signals wrangler's process group and finds workerd with `lsof`.
 */

import {
  chromium,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export const DECISIONS_CHECKOUT =
  process.platform === "win32" ? "" : (process.env.DAINTREE_DECISIONS_CHECKOUT ?? "");

export interface LocalRelay {
  origin: string;
  host: string;
  claimSecret: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A port nothing listens on now, so specs running side by side each get their own relay. */
function freePort(): number {
  return Number(
    execFileSync(
      process.execPath,
      [
        "-e",
        "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
      ],
      { encoding: "utf8" }
    )
  );
}

const reachable = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    (res) => res.ok,
    () => false
  );

export function localRelay(
  port = Number(process.env.DAINTREE_DECISIONS_PORT ?? freePort())
): LocalRelay {
  if (!existsSync(path.join(DECISIONS_CHECKOUT, "app", "dist", "index.html"))) {
    throw new Error(`${DECISIONS_CHECKOUT} has no app/dist: run pnpm build there first`);
  }
  const persist = mkdtempSync(path.join(tmpdir(), "daintree-e2e-decisions-relay-"));
  const claimSecret = randomBytes(24).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  // Only a relay this one started is ever stopped: whatever else listens on the port is left alone.
  let owned = false;
  let log = "";

  const start = async () => {
    log = "";
    // A relay left running by an earlier run would answer for this one, claimed and all.
    if (listeners().length > 0) {
      throw new Error(`Something is already listening on ${origin}: stop it first`);
    }
    owned = true;
    child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--var",
        `CLAIM_SECRET:${claimSecret}`,
        "--persist-to",
        persist,
      ],
      {
        cwd: DECISIONS_CHECKOUT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
        detached: true,
      }
    );
    child.stdout?.on("data", (d) => (log += String(d)));
    child.stderr?.on("data", (d) => (log += String(d)));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
      if (await reachable(`${origin}/health`)) return;
      if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const listeners = (): number[] => {
    let out: string;
    try {
      out = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    } catch (error) {
      // Exit 1 with nothing printed is nothing listening; anything else is lsof failing to look.
      const { status, stdout } = error as { status?: number | null; stdout?: string };
      if (status === 1 && !stdout?.trim()) return [];
      if (typeof stdout !== "string" || !stdout.trim()) throw error;
      out = stdout;
    }
    return out.split("\n").filter(Boolean).map(Number);
  };

  /** This relay's workerd: it names its own port on its command line. */
  const ours = (pid: number): boolean => {
    try {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      });
      return (
        command.includes("workerd") && new RegExp(`127\\.0\\.0\\.1:${port}(?!\\d)`).test(command)
      );
    } catch {
      return false; // gone already
    }
  };

  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // Gone already.
    }
  };

  const stop = async () => {
    if (!owned) return;
    const running = child;
    child = null;
    if (running && running.exitCode === null && running.signalCode === null) {
      const exited = new Promise<void>((r) => running.once("exit", () => r()));
      signal(-running.pid!, "SIGTERM");
      const killer = setTimeout(() => signal(-running.pid!, "SIGKILL"), 5_000);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      clearTimeout(killer);
    }
    // workerd runs outside wrangler's process group and can outlive it.
    for (let i = 0; i < 50; i++) {
      const pids = listeners().filter(ours);
      if (pids.length === 0) {
        owned = false;
        return;
      }
      for (const pid of pids) signal(pid, i < 10 ? "SIGTERM" : "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`The relay on ${origin} wouldn't stop`);
  };

  return { origin, host: `127.0.0.1:${port}`, claimSecret, start, stop };
}

export const DECISIONS_SETTINGS_DIALOG = '[role="dialog"]:has(.settings-sidebar)';

export async function openDecisionsSettings(page: Page): Promise<void> {
  if (!(await page.locator(DECISIONS_SETTINGS_DIALOG).isVisible())) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", { detail: { tab: "decisions" } })
      );
    });
  }
  await page.locator(DECISIONS_SETTINGS_DIALOG).waitFor({ state: "visible", timeout: 20_000 });
}

export async function closeSettings(page: Page): Promise<void> {
  await page.locator('[aria-label="Close settings"]').click();
  await page.locator(DECISIONS_SETTINGS_DIALOG).waitFor({ state: "detached", timeout: 10_000 });
}

/** Turns Decisions on, checks the relay and claims it, as a person does in Settings. */
export async function connectRelay(page: Page, relay: LocalRelay): Promise<void> {
  await openDecisionsSettings(page);
  const panel = page.locator(DECISIONS_SETTINGS_DIALOG);
  await panel.getByRole("switch", { name: /Enable Decisions/ }).click();
  await page.getByRole("button", { name: "Turn on Decisions" }).click();
  await panel.getByRole("textbox", { name: "Relay URL" }).fill(relay.origin);
  await panel.getByRole("button", { name: "Check", exact: true }).click();
  await expect(panel.getByText(`${relay.host} is ready to claim`, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await panel.getByLabel("Claim secret").fill(relay.claimSecret);
  await panel.getByRole("button", { name: "Claim relay" }).click();
  await expect(panel.getByText("Setup isn't finished")).toBeVisible({ timeout: 30_000 });
}

/** Saves a recovery kit to `kitPath` through the save dialog, then verifies it. */
export async function saveAndVerifyKit(
  app: ElectronApplication,
  page: Page,
  kitPath: string,
  passphrase = "correct horse battery staple"
): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as never;
  }, kitPath);
  const panel = page.locator(DECISIONS_SETTINGS_DIALOG);
  const save = panel.locator("#decisions-recovery-kit-save");
  await save.locator('input[type="password"]').fill(passphrase);
  await save.getByRole("button", { name: "Save kit…" }).click();
  await expect
    .poll(() => (existsSync(kitPath) ? readFileSync(kitPath, "utf8").length : 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(100);
  const verify = panel.locator("#decisions-recovery-kit-verify");
  await verify.locator('input[type="file"]').setInputFiles(kitPath);
  await verify.getByLabel("Passphrase of the kit to verify").fill(passphrase);
  await verify.getByRole("button", { name: "Verify kit" }).click();
  await expect(panel.getByText(/Last verified/)).toBeVisible({ timeout: 15_000 });
}

/** Pairs `device` from Settings → Decisions → Devices, comparing the six digits on both sides. */
export async function pairPhone(
  page: Page,
  device: Page,
  relay: LocalRelay,
  label?: string
): Promise<void> {
  const panel = page.locator(DECISIONS_SETTINGS_DIALOG);
  await panel.getByRole("button", { name: "Pair a phone" }).click();
  const dialog = page.locator('[data-testid="decisions-pairing-dialog"]');
  const link = dialog.locator('span[title^="http"]');
  await expect(link).toBeVisible({ timeout: 20_000 });
  const invite = (await link.getAttribute("title"))!;
  expect(invite.startsWith(`${relay.origin}/pair#`)).toBe(true);

  await device.goto(invite);
  if (label) await device.getByLabel("Name this device").fill(label);
  await device.getByRole("button", { name: "Pair this phone" }).click();
  await device.getByText("Confirm this code on your computer").waitFor({ timeout: 30_000 });
  const phoneCode = (await device.locator(".big-code").innerText()).replace(/\D/g, "");
  expect(phoneCode).toHaveLength(6);

  await expect(dialog.getByText("Do these six digits match your phone?")).toBeVisible({
    timeout: 30_000,
  });
  const desktopCode = (await dialog.locator("p.font-mono").innerText()).replace(/\D/g, "");
  expect(desktopCode).toBe(phoneCode);
  await dialog.getByRole("button", { name: "Approve" }).click();
  await dialog.getByRole("button", { name: "Done" }).click({ timeout: 30_000 });
  await device.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
}

/**
 * The phone: Google Chrome when installed, since only it has a push service
 * (and only in a persistent profile), and Playwright's Chromium otherwise.
 */
export async function launchPhone(
  profileDir: string
): Promise<{ context: BrowserContext; phone: Page; hasPush: boolean }> {
  const options = {
    headless: true,
    viewport: { width: 390, height: 844 },
    serviceWorkers: "allow" as const,
    permissions: ["notifications"],
  };
  let context: BrowserContext;
  let hasPush = false;
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...options, channel: "chrome" });
    hasPush = true;
  } catch {
    context = await chromium.launchPersistentContext(profileDir, options);
  }
  return { context, phone: await context.newPage(), hasPush };
}

export async function openInbox(device: Page): Promise<void> {
  await device.getByRole("link", { name: /Inbox/ }).first().click();
}

/** Opens `question` on the phone, picks `option` and/or writes `text`, and submits. */
export async function answerOnPhone(
  phone: Page,
  question: string,
  answer: { option?: RegExp; text?: string }
): Promise<void> {
  await openInbox(phone);
  await phone.getByText(question).first().waitFor({ timeout: 60_000 });
  await phone.getByText(question).first().click();
  await expect(phone.getByRole("heading", { name: question })).toBeVisible();
  if (answer.option) await phone.getByRole("radio", { name: answer.option }).check();
  if (answer.text !== undefined) await phone.locator("textarea").first().fill(answer.text);
  await phone.getByRole("button", { name: /Submit (decision|answer)/ }).click();
  await expect(phone.getByText(/Answered by you/)).toBeVisible({ timeout: 30_000 });
}
