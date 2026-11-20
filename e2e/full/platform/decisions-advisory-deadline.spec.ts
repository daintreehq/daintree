/**
 * The 15-minute Decisions workflow end to end (#17945): an agent asks for
 * advice with a deadline and a plan, gets its answer at once, works on, and
 * picks the question up again when someone answers or the deadline closes.
 * Daintree, the Decisions relay run locally from its built checkout, and the
 * relay's own phone app share one clock (e2e/helpers/decisionsClock.ts), so 15
 * minutes pass in seconds with nothing faked between them: the relay's own
 * expiry, the phone's countdown and Daintree's delivery into the pane.
 *
 * Two fake Claudes run side by side; one asks. Each outcome is read where the
 * agent reads it (what its terminal received, and `get_decision` by the id it
 * was given) and where the person reads it (the phone, the toolbar count, the
 * pane chip and the inbox): an ignored question closes once, in the asking
 * pane only, with its plan due; a timely phone answer wins; a dismissal is a
 * decline, not a timeout; an expired final design approval approves nothing.
 * Then two faults on the way: a draft in the asking pane's composer when the
 * deadline passes, and the relay's reply to the question's first publish lost.
 *
 * What this spec doesn't drive is covered elsewhere (docs/architecture/decisions.md,
 * "Proving the 15-minute workflow"): an ambiguous terminal write in
 * answerDelivery.test.ts, owner sleep and a Host restart in
 * remote-host-decisions.spec.ts and hostRuntime.e2e.test.ts.
 *
 * Opt-in, since it needs a built daintreehq/decisions checkout at 0.9.0 or
 * later, which has the relay's e2e clock (`pnpm install && pnpm build` there):
 *
 *   DAINTREE_DECISIONS_CHECKOUT=<checkout> \
 *     npx playwright test --project=full-platform decisions-advisory-deadline
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  fakeAgentEnv,
  installFakeAgent,
  readFakeAgentStdin,
  sendFakeAgentCommand,
} from "../../helpers/fakeAgent";
import { dispatchAction } from "../../helpers/actions";
import {
  answerOnPhone,
  closeSettings,
  connectRelay,
  DECISIONS_CHECKOUT,
  launchDecisionsAgent,
  launchPhone,
  localRelay,
  openInbox,
  openQuestionOnPhone,
  pairPhone,
  saveAndVerifyKit,
  type DecisionsAgent,
  type LocalRelay,
} from "../../helpers/decisionsRelay";
import { DecisionsTestClock, mainClockOffsets } from "../../helpers/decisionsClock";

test.describe.configure({ mode: "serial" });
const OPT_IN = "needs DAINTREE_DECISIONS_CHECKOUT, a built daintreehq/decisions checkout (0.9.0+)";

test.beforeEach(() => {
  test.info().annotations.push({ type: "conditional-skip", description: OPT_IN });
  test.skip(!DECISIONS_CHECKOUT, OPT_IN);
});

const MINUTE = 60_000;
const PLAN = "Use the in-memory fixture, and say in the PR that it can switch to SQLite files.";
const FIXTURES = [
  { id: "memory", label: "In-memory fixture" },
  { id: "sqlite", label: "A SQLite file per test" },
];
const PNG_GREEN =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQWBCFFTEMLQkAR+xIgWLXeVkAAAAASUVORK5CYII=";
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6GBFTEMLQkAe3tLAfuiUfAAAAAASUVORK5CYII=";

let relay: LocalRelay;
let clock: DecisionsTestClock;
let ctx: AppContext;
let page: Page;
let context: BrowserContext;
let phone: Page;
let workDir: string;
let binDir: string;
/** The agent that asks. */
let asker: DecisionsAgent;
/** An agent beside it that never asks, and must never be typed into. */
let bystander: DecisionsAgent;
const phoneProblems: string[] = [];

interface Receipt {
  question_id: string;
  expires_at: string;
  reply_mode: string;
  planned_fallback: string | null;
  enforced_requirement: string;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

/**
 * Asks from the asking pane, as an agent would. Daintree decides advice only
 * once it has read that a phone of the person's can show the plan, and a move
 * of the clock ages that read, so a `support-unknown` (or, before the paired
 * phone's declaration is read, `no-capable-reader`) refusal is asked again,
 * as the refusal itself tells the agent to.
 */
async function ask(args: Record<string, unknown>, client = asker.mcp): Promise<Receipt> {
  let refusal = "";
  for (const end = Date.now() + 90_000; Date.now() < end; ) {
    const asked = await client.callTool({ name: "ask_human", arguments: args });
    if (!asked.isError) return asked.structuredContent as unknown as Receipt;
    refusal = textOf(asked);
    if (!/^not_supported: (support-unknown|no-capable-reader): /.test(refusal)) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`ask_human was refused: ${refusal}`);
}

/** A choice between two fixtures, with the plan the agent follows if no one answers in 15 minutes. */
async function askAdvice(question: string): Promise<Receipt> {
  const before = clock.now();
  const receipt = await ask({
    question,
    kind: "choice",
    options: FIXTURES,
    expires_in: "15m",
    planned_fallback: PLAN,
  });
  expect(receipt).toMatchObject({
    reply_mode: "advisory",
    planned_fallback: PLAN,
    enforced_requirement: "human-required",
  });
  // Worked out on the system's clock, wherever it has been moved to.
  const window = Date.parse(receipt.expires_at) - before;
  expect(window).toBeGreaterThanOrEqual(15 * MINUTE - 1_000);
  expect(window).toBeLessThanOrEqual(15 * MINUTE + 5_000);
  await published(receipt.question_id);
  return receipt;
}

async function decision(id: string, client = asker.mcp): Promise<Record<string, unknown>> {
  const read = await client.callTool({ name: "get_decision", arguments: { question_id: id } });
  expect(read.isError, textOf(read)).toBeFalsy();
  return read.structuredContent as Record<string, unknown>;
}

/** Waits for the relay to confirm it holds the question: moving time before that would test the publish queue. */
async function published(id: string): Promise<void> {
  await expect
    .poll(async () => (await decision(id)).status, { timeout: 60_000, intervals: [1_000] })
    .toBe("open");
}

/** Moves every clock to `ms` past a deadline. */
function pastDeadline(expiresAt: string, ms = 30_000): Promise<void> {
  return clock.advance(Math.max(0, Math.ceil(Date.parse(expiresAt) - clock.now())) + ms);
}

const BLOCK_END = "[END DAINTREE DECISION ANSWER]";

/** Every whole Decisions block for question `id` in what `agent`'s terminal received after `from`. */
function blocksFor(id: string, from: number, agent = asker): string[] {
  const typed = readFakeAgentStdin(binDir, agent.paneId).slice(from);
  return typed
    .split("[DAINTREE DECISION ANSWER]")
    .slice(1)
    .filter((b) => b.includes(BLOCK_END) && b.includes(`question_id: ${id} `))
    .map((b) => b.slice(0, b.indexOf(BLOCK_END)));
}

const stdinLength = (agent = asker) => readFakeAgentStdin(binDir, agent.paneId).length;

async function agentState(id: string): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${id}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

/** A turn of work that ends at the prompt, as a real agent's does after it asks. */
async function workThenSettle(agent: DecisionsAgent): Promise<void> {
  await sendFakeAgentCommand(binDir, "work", 15_000, agent.paneId);
  await expect.poll(() => agentState(agent.paneId), { timeout: 30_000 }).toBe("working");
  await sendFakeAgentCommand(binDir, "idle", 15_000, agent.paneId);
  await expect.poll(() => agentState(agent.paneId), { timeout: 30_000 }).toBe("waiting");
}

/** What a closed question must never have become: an answer, a choice or an approval. */
function expectNothingDecided(read: Record<string, unknown>): void {
  expect(read).toMatchObject({ choice: null, provenance: null, answers: [] });
}

const inboxButton = () => page.locator('button[aria-haspopup="dialog"][aria-label^="Decisions inbox"]');

/**
 * Nothing on this computer still asks the person about it: the toolbar count
 * is gone, the asking pane's chip is gone, and the inbox lists it outside
 * Needs you.
 */
async function expectNoStaleAsk(question: string): Promise<void> {
  await expect(inboxButton()).toHaveAttribute("aria-label", "Decisions inbox", { timeout: 30_000 });
  await expect(inboxButton().locator(".toolbar-count")).toHaveAttribute("data-visible", "false");
  await expect(
    page.locator(`[data-panel-id="${asker.paneId}"] [data-testid="terminal-decisions-chip"]`)
  ).toHaveCount(0, { timeout: 30_000 });
  const opened = await dispatchAction(page, "decisions.openInbox", undefined, { source: "test" });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  const groups = page.locator('[data-testid="decisions-inbox-groups"]');
  await expect(groups).toContainText(question, { timeout: 30_000 });
  await expect(page.locator('[data-testid="decisions-inbox-group-needs-you"]')).not.toContainText(
    question
  );
  await page.keyboard.press("Escape");
  await expect(groups).toHaveCount(0, { timeout: 10_000 });
}

/** Waits a while in real time with the clocks still, then checks nothing more came. */
async function expectQuietFor(ms: number, check: () => void): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  check();
}

test.beforeAll(async () => {
  if (!DECISIONS_CHECKOUT) return;
  relay = localRelay(undefined, { clocked: true });
  await relay.start();
  clock = new DecisionsTestClock(relay);
  workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-decisions-advisory-"));
  binDir = installFakeAgent(workDir, { perPane: true });
  ctx = await launchApp(clock.launch(fakeAgentEnv(binDir)));
  await clock.attachApp(ctx.app);
  const fixture = createFixtureRepo({ name: "decisions-advisory" });
  mkdirSync(path.join(fixture.dir, "screens"), { recursive: true });
  writeFileSync(path.join(fixture.dir, "screens", "after.png"), Buffer.from(PNG_GREEN, "base64"));
  writeFileSync(path.join(fixture.dir, "screens", "before.png"), Buffer.from(PNG_RED, "base64"));
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  page = ctx.window;

  ({ context, phone } = await launchPhone(mkdtempSync(path.join(workDir, "phone-"))));
  await clock.attachPhone(context);
  phone.on("pageerror", (e) => phoneProblems.push(`pageerror: ${e.message}`));
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus && phone) {
    await phone.screenshot({ fullPage: true, path: testInfo.outputPath("phone.png") });
    await page?.screenshot({ path: testInfo.outputPath("desktop.png") }).catch(() => {});
    for (const agent of [asker, bystander].filter(Boolean)) {
      await testInfo.attach(`stdin-${agent.paneId}`, {
        body: readFakeAgentStdin(binDir, agent.paneId),
        contentType: "text/plain",
      });
    }
  }
});

test.afterAll(async () => {
  await asker?.mcp.close().catch(() => {});
  await bystander?.mcp.close().catch(() => {});
  await context?.close();
  if (ctx?.app) await closeApp(ctx.app);
  await relay?.stop();
});

test("Daintree, the relay and the phone share one clock, and the phone is paired", async () => {
  test.setTimeout(240_000);
  // Main reads the moved clock both ways; the relay runs on it too.
  await clock.advance(MINUTE);
  const offsets = await mainClockOffsets(ctx.app);
  expect(Math.abs(offsets.now - MINUTE)).toBeLessThan(5_000);
  expect(Math.abs(offsets.date - MINUTE)).toBeLessThan(5_000);

  await connectRelay(page, relay);
  await saveAndVerifyKit(ctx.app, page, path.join(workDir, "decisions-recovery.json"));
  await pairPhone(page, phone, relay);
  await closeSettings(page);
  expect(phoneProblems, phoneProblems.join("\n")).toEqual([]);
});

test("two agents start, each with its own daintree-decisions server", async () => {
  test.setTimeout(180_000);
  asker = await launchDecisionsAgent(page, binDir);
  bystander = await launchDecisionsAgent(page, binDir);
  const tools = (await asker.mcp.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["ask_human", "get_decision"]));
  await workThenSettle(asker);
  await workThenSettle(bystander);
});

test("an ignored advisory question closes once, in the pane that asked, with its plan due and nothing decided", async () => {
  test.setTimeout(300_000);
  const question = "Which fixture should the parser tests use?";
  const fromAsker = stdinLength(asker);
  const fromBystander = stdinLength(bystander);
  const { question_id: id, expires_at: expiresAt } = await askAdvice(question);

  // The agent learns its deadline and plan at once, and reads them back by id; the other pane can't.
  expect(await decision(id)).toMatchObject({
    status: "open",
    reply_mode: "advisory",
    planned_fallback: PLAN,
    expires_at: expiresAt,
    fallback_due: false,
    advisory_timeout: null,
  });
  const foreign = await bystander.mcp.callTool({
    name: "get_decision",
    arguments: { question_id: id },
  });
  expect(foreign.isError).toBe(true);

  // The person sees it waiting: on the phone with its deadline and plan, and in the toolbar count.
  await expect(inboxButton()).toHaveAttribute("aria-label", "Decisions inbox — 1 question waiting", {
    timeout: 30_000,
  });
  await openQuestionOnPhone(phone, question);
  const due = phone.locator(".msg-meta .due");
  await expect(due).toContainText("Reply by", { timeout: 20_000 });
  await expect(due.locator("time")).toHaveAttribute("datetime", expiresAt);
  const plan = phone.getByRole("note", { name: "Your agent’s plan" });
  await expect(plan).toContainText(PLAN);

  // A minute short of the deadline, nothing is due and nothing has been typed.
  await clock.advance(Math.ceil(Date.parse(expiresAt) - clock.now()) - MINUTE);
  await expectQuietFor(5_000, () => expect(blocksFor(id, fromAsker)).toEqual([]));
  expect(await decision(id)).toMatchObject({ status: "open", fallback_due: false });

  // Past it, the notice is typed into the asking pane, once.
  await pastDeadline(expiresAt);
  await expect
    .poll(() => blocksFor(id, fromAsker).length, { timeout: 90_000, intervals: [1_000] })
    .toBe(1);
  const [notice] = blocksFor(id, fromAsker);
  expect(notice).toContain("source: system\nstatus: advisory-unanswered\n");
  expect(notice).toContain(`deadline: ${expiresAt}\ndisposition: fallback-due\nauthorised: no\n`);
  expect(notice).not.toMatch(/^choice/m);
  const injection = /^injection_id: (\S+)$/m.exec(notice)?.[1];
  expect(injection).toBeTruthy();

  // The same result by id: expired, the plan due, the notice delivered, and nobody chose anything.
  await expect
    .poll(async () => (await decision(id)).advisory_timeout, { timeout: 30_000 })
    .toMatchObject({ notice: "delivered" });
  const read = await decision(id);
  expect(read).toMatchObject({
    status: "expired",
    closed_reason: "expired",
    fallback_due: true,
    planned_fallback: PLAN,
    advisory_timeout: {
      deadline: expiresAt,
      disposition: "fallback-due",
      notice: "delivered",
      injection_id: injection,
      agent_action: "unobserved",
    },
  });
  expectNothingDecided(read);

  await expect(phone.getByText("No answer by the deadline").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(due).toHaveCount(0);
  await expectNoStaleAsk(question);

  // Time goes on: nothing more for it, and never anything in the other pane.
  await clock.advance(5 * MINUTE);
  await expectQuietFor(10_000, () => {
    expect(blocksFor(id, fromAsker)).toHaveLength(1);
    expect(readFakeAgentStdin(binDir, bystander.paneId).slice(fromBystander)).not.toContain(id);
  });
});

test("a timely phone answer reaches the agent as the person's, and the deadline passing changes nothing", async () => {
  test.setTimeout(300_000);
  const question = "Which fixture should the importer tests use?";
  const from = stdinLength();
  const { question_id: id, expires_at: expiresAt } = await askAdvice(question);

  // Ten minutes in, the person picks the option that isn't the plan.
  await clock.advance(10 * MINUTE);
  await answerOnPhone(phone, question, { option: /A SQLite file per test/ });
  await expect
    .poll(() => blocksFor(id, from).length, { timeout: 90_000, intervals: [1_000] })
    .toBe(1);
  const [answer] = blocksFor(id, from);
  expect(answer).toContain("source: human");
  expect(answer).toContain("choice: sqlite");
  expect(answer).not.toContain("status: advisory-unanswered");
  expect(await decision(id)).toMatchObject({
    status: "human-answered",
    provenance: "human",
    choice: "sqlite",
    fallback_due: false,
    advisory_timeout: null,
  });

  await pastDeadline(expiresAt);
  await expectQuietFor(15_000, () => expect(blocksFor(id, from)).toHaveLength(1));
  expect(await decision(id)).toMatchObject({
    status: "human-answered",
    choice: "sqlite",
    fallback_due: false,
  });
  await expectNoStaleAsk(question);
});

test("a dismissal on the phone is a decline, never a timeout, and its deadline makes nothing due", async () => {
  test.setTimeout(300_000);
  const question = "Which fixture should the exporter tests use?";
  const from = stdinLength();
  const { question_id: id, expires_at: expiresAt } = await askAdvice(question);

  await openQuestionOnPhone(phone, question);
  await phone.locator(".ws-head").getByRole("button", { name: "More" }).click();
  await phone.getByRole("menuitem", { name: "Dismiss question…" }).click();
  await phone.getByRole("button", { name: "Dismiss question" }).click();
  await expect(phone.getByText("Declined by you").first()).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(() => blocksFor(id, from).length, { timeout: 90_000, intervals: [1_000] })
    .toBe(1);
  const [declined] = blocksFor(id, from);
  expect(declined).toContain("source: human\nstatus: declined\nauthorised: no\n");
  const read = await decision(id);
  expect(read).toMatchObject({ status: "cancelled", closed_reason: "declined", fallback_due: false });
  expectNothingDecided(read);

  await pastDeadline(expiresAt);
  await expectQuietFor(15_000, () => expect(blocksFor(id, from)).toHaveLength(1));
  expect(await decision(id)).toMatchObject({ closed_reason: "declined", fallback_due: false });
  await expectNoStaleAsk(question);
});

test("a final design approval can't be asked as advice, and expires unapproved", async () => {
  test.setTimeout(300_000);
  const question = "Approve the redesigned settings page?";
  const from = stdinLength();
  const gated = {
    question,
    workflow_gate_id: "design-review/final",
    attachments: [
      { local_resource_id: "screens/before.png", role: "before" },
      { local_resource_id: "screens/after.png", role: "after" },
    ],
    expires_in: "15m",
  };
  const refused = await asker.mcp.callTool({
    name: "ask_human",
    arguments: { ...gated, planned_fallback: "Ship it as it is." },
  });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toMatch(/^validation_error: gated: /);

  const { question_id: id, expires_at: expiresAt, reply_mode } = await ask(gated);
  expect(reply_mode).toBe("blocking");
  await published(id);
  expect(await decision(id)).toMatchObject({
    requirement: "human-required",
    workflow_gate_id: "design-review/final",
    planned_fallback: null,
    fallback_due: false,
  });

  await pastDeadline(expiresAt);
  await expect
    .poll(() => blocksFor(id, from).length, { timeout: 90_000, intervals: [1_000] })
    .toBe(1);
  const [expired] = blocksFor(id, from);
  expect(expired).toContain("source: system\nstatus: expired\nauthorised: no\n");
  expect(expired).not.toContain("advisory-unanswered");
  const read = await decision(id);
  expect(read).toMatchObject({
    status: "expired",
    requirement: "human-required",
    reply_mode: "blocking",
    fallback_due: false,
    advisory_timeout: null,
  });
  expectNothingDecided(read);
  await expectNoStaleAsk(question);
});

test("a draft in the asking pane's composer holds the notice, which is typed once the draft goes", async () => {
  test.setTimeout(300_000);
  const question = "Which fixture should the formatter tests use?";
  const from = stdinLength();
  const { question_id: id, expires_at: expiresAt } = await askAdvice(question);

  const editor = page.locator(`[data-panel-id="${asker.paneId}"] .cm-content`).first();
  await editor.click();
  await page.keyboard.type("Half a reply to the agent");
  await expect(editor).toContainText("Half a reply to the agent");

  await pastDeadline(expiresAt);
  // Expired and its plan due by id, but nothing typed over the draft, past the closure's 15-second wait too.
  await expect
    .poll(async () => (await decision(id)).advisory_timeout, { timeout: 60_000 })
    .toMatchObject({ disposition: "fallback-due", notice: "pending" });
  await expectQuietFor(20_000, () => expect(blocksFor(id, from)).toEqual([]));

  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await expect(editor.locator(".cm-placeholder")).toBeVisible();
  await expect
    .poll(() => blocksFor(id, from).length, { timeout: 120_000, intervals: [1_000] })
    .toBe(1);
  expect(blocksFor(id, from)[0]).toContain("status: advisory-unanswered");
  await expect
    .poll(async () => (await decision(id)).advisory_timeout, { timeout: 30_000 })
    .toMatchObject({ notice: "delivered" });
  await expectQuietFor(10_000, () => expect(blocksFor(id, from)).toHaveLength(1));
  await expectNoStaleAsk(question);
});

interface CreateFault {
  real: (input: string, init?: RequestInit) => Promise<Response>;
  armed: boolean;
  holding: boolean;
  lostStatus: number;
  creates: number;
}

test("a question whose first publish reply is lost reaches the phone once and closes once", async () => {
  test.setTimeout(300_000);
  const question = "Which fixture should the linter tests use?";
  const from = stdinLength();
  // The next question create reaches the relay and its reply is lost; retries fail until released.
  await ctx.app.evaluate(({ net }) => {
    const g = globalThis as unknown as { __e2eCreateFault?: CreateFault };
    const real = g.__e2eCreateFault?.real ?? net.fetch.bind(net);
    const fault: CreateFault = { real, armed: true, holding: false, lostStatus: 0, creates: 0 };
    g.__e2eCreateFault = fault;
    net.fetch = (async (input: string, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if ((init?.method ?? "GET").toUpperCase() === "POST" && url.pathname === "/api/v1/questions") {
        fault.creates++;
        if (fault.armed) {
          fault.armed = false;
          fault.holding = true;
          const res = await fault.real(input, init);
          fault.lostStatus = res.status;
          await res.arrayBuffer().catch(() => undefined);
          throw new TypeError("net::ERR_CONNECTION_RESET");
        }
        if (fault.holding) throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
      }
      return fault.real(input, init);
    }) as typeof net.fetch;
  });
  const faultState = () =>
    ctx.app.evaluate(() => {
      const f = (globalThis as unknown as { __e2eCreateFault: CreateFault }).__e2eCreateFault;
      return { lostStatus: f.lostStatus, creates: f.creates, holding: f.holding };
    });

  try {
    const receipt = await ask({
      question,
      kind: "choice",
      options: FIXTURES,
      expires_in: "15m",
      planned_fallback: PLAN,
    });
    expect(receipt.reply_mode).toBe("advisory");
    const id = receipt.question_id;
    // The relay took it, and Daintree never heard so from the create itself.
    await expect.poll(async () => (await faultState()).lostStatus, { timeout: 30_000 }).toBe(201);
    await new Promise((r) => setTimeout(r, 5_000));
    await ctx.app.evaluate(() => {
      (globalThis as unknown as { __e2eCreateFault: CreateFault }).__e2eCreateFault.holding = false;
    });
    await published(id);

    // One question on the phone, not two.
    await openInbox(phone);
    await expect(
      phone.getByRole("main").getByRole("link").filter({ hasText: question })
    ).toHaveCount(1, { timeout: 30_000 });

    await pastDeadline(receipt.expires_at);
    await expect
      .poll(() => blocksFor(id, from).length, { timeout: 90_000, intervals: [1_000] })
      .toBe(1);
    expect(blocksFor(id, from)[0]).toContain("status: advisory-unanswered");
    const read = await decision(id);
    expect(read).toMatchObject({ status: "expired", fallback_due: true });
    expectNothingDecided(read);
    await expectQuietFor(10_000, () => expect(blocksFor(id, from)).toHaveLength(1));
    await test.info().attach("create-fault", {
      body: JSON.stringify(await faultState()),
      contentType: "application/json",
    });
    await expectNoStaleAsk(question);
  } finally {
    await ctx.app.evaluate(({ net }) => {
      const g = globalThis as unknown as { __e2eCreateFault?: CreateFault };
      if (g.__e2eCreateFault) net.fetch = g.__e2eCreateFault.real as typeof net.fetch;
    });
  }
});
