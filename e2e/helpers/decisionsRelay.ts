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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { dispatchAction } from "./actions";
import { FAKE_AGENT_READY, ptyWrite, readFakeAgentLaunchLog } from "./fakeAgent";
import { getTerminalTextById } from "./terminal";

export const DECISIONS_CHECKOUT =
  process.platform === "win32" ? "" : (process.env.DAINTREE_DECISIONS_CHECKOUT ?? "");

export interface LocalRelay {
  origin: string;
  host: string;
  claimSecret: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Sets how far the relay's clock runs ahead of the real one (absolute, so a
   * repeated call never moves it twice) and runs whatever came due, as the
   * runtime would once that time arrived. Only a relay started `clocked` has it.
   */
  setClock(offsetMs: number): Promise<void>;
}

/**
 * The Decisions checkout's e2e-only Worker entry (0.9.0 and later): the
 * production Worker and Durable Object behind a clock a test moves with
 * `POST /__e2e/clock`. The shipped bundle never includes it.
 */
export const CLOCKED_RELAY_ENTRY = "worker/tests/e2e-clock-worker.ts";

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
  port = Number(process.env.DAINTREE_DECISIONS_PORT ?? freePort()),
  options: { clocked?: boolean } = {}
): LocalRelay {
  if (!existsSync(path.join(DECISIONS_CHECKOUT, "app", "dist", "index.html"))) {
    throw new Error(`${DECISIONS_CHECKOUT} has no app/dist: run pnpm build there first`);
  }
  if (options.clocked && !existsSync(path.join(DECISIONS_CHECKOUT, CLOCKED_RELAY_ENTRY))) {
    throw new Error(
      `${DECISIONS_CHECKOUT} has no ${CLOCKED_RELAY_ENTRY}: check out 0.9.0 or later`
    );
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
        ...(options.clocked ? [CLOCKED_RELAY_ENTRY] : []),
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

  const setClock = async (offsetMs: number) => {
    if (!options.clocked) throw new Error("This relay wasn't started clocked");
    const res = await fetch(`${origin}/__e2e/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset_ms: offsetMs }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(`The relay didn't move its clock (${res.status}): ${await res.text()}`);
  };

  return { origin, host: `127.0.0.1:${port}`, claimSecret, start, stop, setClock };
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
export async function connectRelay(
  page: Page,
  relay: LocalRelay,
  agentNames: readonly string[] = ["Claude"]
): Promise<void> {
  await openDecisionsSettings(page);
  const panel = page.locator(DECISIONS_SETTINGS_DIALOG);
  await panel.getByRole("switch", { name: /Enable Decisions/ }).click();
  await page.getByRole("button", { name: "Turn on Decisions" }).click();
  await panel.getByRole("textbox", { name: "Relay URL" }).fill(relay.origin);
  await panel.getByRole("button", { name: "Check", exact: true }).click();
  await expect(panel.getByText(`${relay.host} is ready to claim`, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await panel.getByRole("textbox", { name: "Claim secret" }).fill(relay.claimSecret);
  await panel.getByRole("button", { name: "Claim relay" }).click();
  await expect(panel.getByText("Setup isn't finished")).toBeVisible({ timeout: 30_000 });
  for (const name of agentNames) {
    const askHuman = panel.getByRole("switch", { name: `ask_human for ${name}`, exact: true });
    await askHuman.setChecked(true);
    await expect(askHuman).toBeChecked();
    await expect(askHuman).toBeEnabled();
  }
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
  // The whole link is the text; the dialog only clamps how much of it shows.
  const link = dialog.locator("span.font-mono").filter({ hasText: /^https?:\/\// });
  await expect(link).toBeVisible({ timeout: 20_000 });
  const invite = (await link.textContent())!.trim();
  expect(invite.startsWith(`${relay.origin}/pair#`)).toBe(true);

  await device.goto(invite);
  if (label) await device.getByLabel("Name this device").fill(label);
  await device.getByRole("button", { name: "Pair this device" }).click();
  await device.getByRole("heading", { name: "Compare the code" }).waitFor({ timeout: 30_000 });
  const phoneCode = (await device.locator(".pair-digits").innerText()).replace(/\D/g, "");
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

async function openPhoneDestination(device: Page, name: "Home" | "Settings"): Promise<void> {
  const destination = device.getByRole("link", { name: new RegExp(`^${name}\\b`) }).first();
  if (!(await destination.isVisible())) {
    await device.getByRole("button", { name: /^Menu(?:,|$)/ }).click();
  }
  await destination.click();
}

export async function openInbox(device: Page): Promise<void> {
  await openPhoneDestination(device, "Home");
}

export async function openPhoneNotifications(device: Page): Promise<void> {
  await openPhoneDestination(device, "Settings");
  await device.getByRole("link", { name: /^Notifications\b/ }).click();
}

export async function choosePhoneOption(device: Page, name: RegExp): Promise<void> {
  // The phone app (0.9.0) offers a question's choices as radio chips beside its composer.
  await device.getByRole("radio", { name }).first().check();
}

/** Opens `question` on the phone, picks `option` and/or writes `text`, and submits. */
/** Opens `question` from the phone's Home. */
export async function openQuestionOnPhone(phone: Page, question: string): Promise<void> {
  await openInbox(phone);
  const row = phone.getByRole("main").getByRole("link").filter({ hasText: question });
  const newQuestions = phone.getByRole("button", { name: /^\d+ new questions?\b/ });
  // Home holds its order while it is open; arrivals are offered above the list.
  await row.or(newQuestions).first().waitFor({ timeout: 60_000 });
  if (await newQuestions.isVisible()) await newQuestions.click();
  await row.click({ timeout: 60_000 });
  await expect(phone.getByRole("heading", { name: question })).toBeVisible();
}

/** Opens `question` on the phone, picks `option` and/or writes `text`, and submits. */
export async function answerOnPhone(
  phone: Page,
  question: string,
  answer: { option?: RegExp; text?: string }
): Promise<void> {
  await openQuestionOnPhone(phone, question);
  if (answer.option) await choosePhoneOption(phone, answer.option);
  if (answer.text !== undefined) await phone.locator("textarea").first().fill(answer.text);
  await phone.getByRole("button", { name: /^Send (decision|answer)$/ }).click();
  await expect(phone.getByText("Your answer", { exact: true })).toBeVisible({ timeout: 30_000 });
}

export interface DecisionsAgent {
  paneId: string;
  /** The `daintree-decisions` server its launch was handed, connected as the agent would. */
  mcp: Client;
}

/**
 * Launches a fake Claude (installed `perPane`) in a new pane of `page`'s
 * project, gets it past its trust prompt, and connects to the
 * `daintree-decisions` server its launch was handed, as Claude would: Claude
 * gets its servers in a file named on its command line, bearer and all.
 */
export async function launchDecisionsAgent(page: Page, binDir: string): Promise<DecisionsAgent> {
  const launches = readFakeAgentLaunchLog(binDir).length;
  const launched = await dispatchAction(
    page,
    "agent.launch",
    { agentId: "claude", location: "grid" },
    { source: "test" }
  );
  expect(launched.ok, JSON.stringify(launched)).toBe(true);
  await expect
    .poll(() => readFakeAgentLaunchLog(binDir).length, { timeout: 60_000 })
    .toBe(launches + 1);
  const launch = readFakeAgentLaunchLog(binDir)[launches];
  const paneId = launch.paneId!;
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: 60_000 })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, paneId, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: 60_000 })
    .toContain(FAKE_AGENT_READY);

  const configAt = launch.argv.indexOf("--mcp-config");
  expect(configAt, launch.argv.join(" ")).toBeGreaterThanOrEqual(0);
  const config = JSON.parse(readFileSync(launch.argv[configAt + 1], "utf8")) as {
    mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
  };
  const server = config.mcpServers["daintree-decisions"];
  expect(server, Object.keys(config.mcpServers).join(", ")).toBeTruthy();
  const mcp = new Client({ name: "fake-claude", version: "9.9.9" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    })
  );
  return { paneId, mcp };
}

/** An MCP tool result's text. */
export function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

/** What `ask_human` returns for a question it took. */
export interface AskReceipt {
  question_id: string;
  expires_at: string;
  reply_mode: string;
  planned_fallback: string | null;
  enforced_requirement: string;
}

/**
 * Calls `ask_human` as an agent would. Daintree decides advice only once it
 * has read that a phone of the person's can show the plan, and that read ages
 * (a moved clock ages it at once), so a `support-unknown` refusal, or a
 * `no-capable-reader` one before a just-paired phone's declaration is read,
 * is asked again a moment later, as the refusal itself says to.
 */
export async function askHuman(client: Client, args: Record<string, unknown>): Promise<AskReceipt> {
  let refusal = "";
  for (const end = Date.now() + 90_000; Date.now() < end;) {
    const asked = await client.callTool({ name: "ask_human", arguments: args });
    if (!asked.isError) return asked.structuredContent as unknown as AskReceipt;
    refusal = toolText(asked);
    if (!/^[a-z_]+: (support-unknown|no-capable-reader): /.test(refusal)) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`ask_human was refused: ${refusal}`);
}

/** `get_decision` for `id`, as the agent that asked reads it. */
export async function getDecision(client: Client, id: string): Promise<Record<string, unknown>> {
  const read = await client.callTool({ name: "get_decision", arguments: { question_id: id } });
  expect(read.isError, toolText(read)).toBeFalsy();
  return read.structuredContent as Record<string, unknown>;
}

const BLOCK_START = "[DAINTREE DECISION ANSWER]";
const BLOCK_END = "[END DAINTREE DECISION ANSWER]";

/** Every whole Decisions block for question `id` in what a terminal received. */
export function decisionBlocks(typed: string, id: string): string[] {
  return typed
    .split(BLOCK_START)
    .slice(1)
    .filter((b) => b.includes(BLOCK_END) && b.includes(`question_id: ${id} `))
    .map((b) => b.slice(0, b.indexOf(BLOCK_END)));
}
