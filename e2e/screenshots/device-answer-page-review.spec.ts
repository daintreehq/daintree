/**
 * Device answer page visual-review harness.
 *
 * The page a paired phone loads to answer waiting agents is served by
 * `DeviceAnswerService` with its own CSP, so this boots the real service on a
 * loopback port with fixture deps (settings in memory, waiting runs and answer
 * outcomes from the scenario below) and loads the page in a phone-sized
 * Chromium. Every request goes through the real HTTP API, the real Host and
 * origin checks and the real error strings; only the agents are invented.
 * The page's clock is frozen, so polls run only when a step advances it.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DEVICE_ANSWER is set.
 *
 *   DAINTREE_SHOT_DEVICE_ANSWER=1 npx playwright test --project=screenshots device-answer-page
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVICE_ANSWER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           output directory (default artifacts/device-answer-shots)
 *   DAINTREE_SHOT_CONFIGS        comma-separated viewports, e.g. 375-light,320-dark
 *                                (default: 375, 320 and 768 wide, light and dark)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter (step names below)
 *
 * Output: <dir>/<NN-step>--<width>-<scheme>.png
 *
 * Verification contract: every step asserts the state it drove rendered
 * before writing a file, and a step that throws records a failure instead of
 * writing one. The test fails at the end with the states it couldn't capture.
 */

import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { DeviceAnswerService } from "../../electron/services/deviceAnswer/DeviceAnswerService";
import { hashDeviceToken } from "../../electron/services/deviceAnswer/deviceAuth";
import type { DeviceAnswerSettings } from "../../shared/types/ipc/deviceAnswer";
import type {
  DeviceWaitingList,
  DeviceWaitingRun,
} from "../../electron/services/deviceAnswer/deviceAnswerRuns";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVICE_ANSWER;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join("artifacts", "device-answer-shots")
);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface ViewportConfig {
  id: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
}

const ALL_CONFIGS: ViewportConfig[] = [375, 320, 768].flatMap((width) =>
  (["light", "dark"] as const).map((scheme) => ({
    id: `${width}-${scheme}`,
    width,
    height: width === 768 ? 1024 : width === 320 ? 568 : 812,
    scheme,
  }))
);
const CONFIGS = process.env.DAINTREE_SHOT_CONFIGS
  ? ALL_CONFIGS.filter((c) => process.env.DAINTREE_SHOT_CONFIGS!.split(",").includes(c.id))
  : ALL_CONFIGS;

const TOKEN = "harness-device-token-0123456789abcdef";
const DEVICE_ID = "device-harness";
/** 14:02 on the device's clock, so every time on the page is predictable. */
const NOW = new Date(2026, 9, 29, 14, 2, 0).getTime();
const LOCAL = "Greg's MacBook Pro";

// --- fixtures ---------------------------------------------------------------

const COLS = 120;

function boxed(lines: string[]): string[] {
  const inner = COLS - 4;
  return [
    "╭" + "─".repeat(COLS - 2) + "╮",
    ...lines.map((line) => "│ " + line.slice(0, inner).padEnd(inner) + " │"),
    "╰" + "─".repeat(COLS - 2) + "╯",
  ];
}

/** The bottom 40 rows of a Claude Code approval prompt, 120 columns wide. */
function claudeApprovalScreen(command: string, options: string[], purpose: string): string {
  const history = [
    "⏺ Read(electron/services/deviceAnswer/deviceAnswerPage.ts)",
    "  ⎿  Read 349 lines (ctrl+o to expand)",
    "",
    "⏺ The poll re-renders every card with replaceChildren(), so the answer result is wiped 600 ms after it lands. I'll key",
    "  the cards by run and patch them in place instead, keeping the screen's scroll position across polls.",
    "",
    "⏺ Update(electron/services/deviceAnswer/deviceAnswerPage.ts)",
    "  ⎿  Updated electron/services/deviceAnswer/deviceAnswerPage.ts with 42 additions and 17 removals",
    "       98      const markStale = () => {",
    '       99 -      for (const card of $("runs").querySelectorAll(".run")) {',
    "      100 +      for (const entry of cards.values()) {",
    '      101 +        entry.card.classList.add("stale");',
    "",
    "⏺ Now the tests for the receipt and the stale note.",
    "",
    "⏺ Write(electron/services/deviceAnswer/__tests__/deviceAnswerPage.test.ts)",
    "  ⎿  Wrote 64 lines to electron/services/deviceAnswer/__tests__/deviceAnswerPage.test.ts",
    "",
    "⏺ Running the page tests to check the receipt holds across a poll.",
    "",
  ];
  const box = boxed([
    "Bash command",
    "",
    "  " + command,
    "  " + purpose,
    "",
    "Do you want to proceed?",
    ...options.map((option, i) => (i === 0 ? "❯ " : "  ") + `${i + 1}. ${option}`),
  ]);
  const rows = [...history, ...box];
  return rows.slice(-40).join("\n");
}

function codexQuestionScreen(): string {
  const rows = [
    "• Explored",
    "  └ Read package.json, vite.config.ts, src/main.tsx",
    "",
    "• The build has two entry points that both define a `--color-surface` token, and they disagree in dark mode. Which",
    "  one should win?",
    "",
    "› 1. Keep the theme package's token and delete the app override",
    "  2. Keep the app override and stop importing the theme token",
    "  3. Leave both and add a lint rule",
    "",
    "  Press enter to confirm or esc to cancel",
  ];
  return rows.join("\n");
}

function run(overrides: Partial<DeviceWaitingRun>): DeviceWaitingRun {
  return {
    runId: "run-1",
    spawnedAt: 1000,
    project: "web-app",
    title: "Fix the login redirect",
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "approval",
    since: NOW - 3 * 60_000,
    parked: false,
    snoozed: false,
    screen: claudeApprovalScreen(
      "npm test -- src/auth/__tests__/redirect.test.ts",
      [
        "Yes",
        "Yes, and don't ask again for npm test commands in /Users/greg/Projects/web-app",
        "No, and tell Claude what to do differently (esc)",
      ],
      "Run the login redirect tests"
    ),
    choices: [
      "Yes",
      "Yes, and don't ask again for npm test commands in /Users/greg/Projects/web-app",
      "No, and tell Claude what to do differently (esc)",
    ],
    hostId: "local",
    host: LOCAL,
    agentName: overrides.agentId === "codex" ? "Codex" : "Claude",
    ...overrides,
  } as DeviceWaitingRun;
}

const LONG_HOST = "studio-03 (office rack, second shelf)";

const SEVERAL: DeviceWaitingList = {
  runs: [
    run({ runId: "a", since: NOW - 42 * 60_000 }),
    run({
      runId: "b",
      hostId: "studio-03",
      host: LONG_HOST,
      project: "customer-portal-billing-migration-2026",
      title: "Migrate invoice PDFs to the new renderer and backfill the archive for every customer",
      agentId: "codex",
      waitingReason: "question",
      since: NOW - 11 * 60_000,
      screen: codexQuestionScreen(),
      choices: [
        "Keep the theme package's token and delete the app override",
        "Keep the app override and stop importing the theme token",
        "Leave both and add a lint rule",
      ],
    }),
    run({
      runId: "c",
      project: "daintree",
      title: null,
      parked: true,
      since: NOW - 2 * 60 * 60_000,
    }),
    run({
      runId: "d",
      hostId: "studio-03",
      host: LONG_HOST,
      project: "api",
      title: "Rotate the staging keys",
      snoozed: true,
      since: NOW - 25_000,
    }),
  ],
  hosts: [{ hostId: "studio-03", host: LONG_HOST, status: "ok" }],
};

// --- the service ------------------------------------------------------------

interface Scenario {
  waiting: DeviceWaitingList;
  answer: (request: { runId: string; label: string }) => Promise<void>;
}

interface Harness {
  service: DeviceAnswerService;
  settings: DeviceAnswerSettings;
  scenario: Scenario;
  origin: string;
}

function refusal(message: string): Error {
  return Object.assign(new Error(message), { userMessage: message });
}

async function startService(paired: boolean): Promise<Harness> {
  const harness = {
    settings: {
      enabled: true,
      port: 0,
      tailnetHost: null,
      devices: paired
        ? [
            {
              id: DEVICE_ID,
              name: "Greg's iPhone",
              tokenHash: hashDeviceToken(TOKEN),
              pairedAt: NOW - 86_400_000,
              lastSeenAt: null,
            },
          ]
        : [],
      answers: [],
    } as DeviceAnswerSettings,
    scenario: {
      waiting: { runs: [run({})], hosts: [] },
      answer: async () => {},
    } as Scenario,
  } as Harness;
  harness.service = new DeviceAnswerService({
    readSettings: () => harness.settings,
    writeSettings: (next) => {
      harness.settings = next;
    },
    // As createDeviceAnswerService sends it: this machine named on every list.
    listWaiting: async () => {
      const list = structuredClone(harness.scenario.waiting);
      // Longest waiting first, whichever machine, as the real list is sorted.
      list.runs.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
      return { computer: LOCAL, ...list };
    },
    answer: (request) => harness.scenario.answer(request),
    hostName: (hostId) => hostId,
    onStatusChanged: () => {},
  });
  await harness.service.init();
  const port = harness.service.boundPort;
  if (port === null) throw new Error("device answer listener didn't start");
  harness.origin = `http://127.0.0.1:${port}`;
  return harness;
}

// --- driving the page -------------------------------------------------------

async function openPage(
  browser: Browser,
  config: ViewportConfig,
  harness: Harness,
  paired: boolean
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: 2,
    isMobile: config.width < 600,
    hasTouch: true,
    colorScheme: config.scheme,
  });
  if (paired) {
    await context.addInitScript((token) => {
      localStorage.setItem("daintree-device-token", token);
    }, TOKEN);
  }
  const page = await context.newPage();
  await page.clock.install({ time: NOW - 5_000 });
  await page.clock.pauseAt(NOW);
  await page.goto(harness.origin + "/");
  return page;
}

/** Advance the page past one poll interval and let the read land. */
async function nextPoll(page: Page): Promise<void> {
  const before = await waitingReads(page);
  await page.clock.runFor(3_000);
  await expect.poll(() => waitingReads(page), { timeout: 10_000 }).toBeGreaterThan(before);
  // The read's body and the render that follows it.
  await page.waitForTimeout(150); // settle render after a real fetch under a frozen clock
}

const readCounts = new WeakMap<Page, number>();
async function waitingReads(page: Page): Promise<number> {
  return readCounts.get(page) ?? 0;
}
function countReads(page: Page): void {
  readCounts.set(page, 0);
  page.on("requestfinished", (request) => {
    if (request.url().includes("/api/waiting")) {
      readCounts.set(page, (readCounts.get(page) ?? 0) + 1);
    }
  });
}

async function cardCount(page: Page, n: number): Promise<void> {
  await expect(page.locator("#runs .run")).toHaveCount(n, { timeout: 10_000 });
}

function card(page: Page, index: number) {
  return page.locator("#runs .run").nth(index);
}

async function press(page: Page, index: number, label: string): Promise<void> {
  await card(page, index)
    .getByRole("button", { name: label, exact: true })
    .first()
    .click({ timeout: 5_000 });
}

async function pairWith(page: Page, code: string): Promise<void> {
  await page.locator("#code").fill(code, { timeout: 5_000 });
  await page.locator("#name").fill("Greg's iPhone", { timeout: 5_000 });
  await page.locator("#pair-form").getByRole("button", { name: /^Pair/ }).click({ timeout: 5_000 });
}

async function fullShot(page: Page, file: string): Promise<void> {
  // From the top, so the sticky header sits where a phone first shows it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
}

async function viewportShot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: file, animations: "disabled" });
}

interface Step {
  name: string;
  paired: boolean;
  /** Drive the page to the state, assert it rendered, and write the file. */
  run: (page: Page, harness: Harness, file: string) => Promise<void>;
  /** Fixture changes before the page loads. */
  setup?: (harness: Harness) => void | Promise<void>;
}

const STEPS: Step[] = [
  {
    name: "pair-empty",
    paired: false,
    run: async (page, _h, file) => {
      await expect(page.locator("#pair")).toBeVisible();
      await fullShot(page, file);
    },
  },
  {
    name: "pair-busy",
    paired: false,
    run: async (page, harness, file) => {
      harness.service.createPairingCode();
      await page.route("**/api/pair", () => {}); // held open: the request never answers
      await pairWith(page, "ABCD-EFGH");
      await expect(page.locator("#pair-form button[type=submit]")).toBeDisabled();
      await page.clock.runFor(500);
      await fullShot(page, file);
    },
  },
  {
    name: "pair-wrong-code",
    paired: false,
    run: async (page, harness, file) => {
      harness.service.createPairingCode();
      await pairWith(page, "WXYZ-2345");
      await expect(page.locator("#pair-error")).toContainText("didn't work");
      await fullShot(page, file);
    },
  },
  {
    name: "pair-no-code",
    paired: false,
    run: async (page, _h, file) => {
      await pairWith(page, "WXYZ-2345");
      await expect(page.locator("#pair-error")).toContainText("No pairing code is open");
      await fullShot(page, file);
    },
  },
  {
    name: "pair-too-many",
    paired: false,
    run: async (page, harness, file) => {
      for (let i = 0; i < 10; i++) {
        await fetch(harness.origin + "/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Daintree-Device": "1" },
          body: JSON.stringify({ code: "XXXX-XXXX" }),
        });
      }
      await pairWith(page, "WXYZ-2345");
      await expect(page.locator("#pair-error")).toContainText("Too many tries");
      await fullShot(page, file);
    },
  },
  {
    name: "pair-unreachable",
    paired: false,
    run: async (page, _h, file) => {
      await page.route("**/api/pair", (route) => route.abort("connectionrefused"));
      await pairWith(page, "ABCD-EFGH");
      await expect(page.locator("#pair-error")).toContainText("Couldn't reach");
      await fullShot(page, file);
    },
  },
  {
    name: "pair-after-401",
    paired: true,
    run: async (page, harness, file) => {
      await cardCount(page, 1);
      harness.service.revokeDevice(DEVICE_ID);
      await page.clock.runFor(3_000);
      await expect(page.locator("#pair")).toBeVisible({ timeout: 10_000 });
      await fullShot(page, file);
    },
  },
  {
    name: "one-card",
    paired: true,
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await fullShot(page, file);
    },
  },
  {
    name: "one-card-viewport",
    paired: true,
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await viewportShot(page, file);
    },
  },
  {
    name: "several-cards",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = SEVERAL;
    },
    run: async (page, _h, file) => {
      await cardCount(page, 4);
      await fullShot(page, file);
    },
  },
  {
    name: "many-long-options",
    paired: true,
    setup: (h) => {
      const choices = [
        "Yes",
        "Yes, allow all edits during this session (shift+tab)",
        "Yes, and don't ask again for git push --force-with-lease origin design/issue-15080-device-answer-phone-page",
        "Yes, but only for files under electron/services/deviceAnswer",
        "No, keep the current branch as it is and stop here",
        "No, and tell Claude what to do differently (esc)",
      ];
      h.scenario.waiting = {
        runs: [
          run({
            screen: claudeApprovalScreen(
              "git push --force-with-lease",
              choices,
              "Push the rebased branch"
            ),
            choices,
          }),
        ],
        hosts: [],
      };
    },
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await fullShot(page, file);
    },
  },
  {
    name: "no-options-and-unreadable",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = {
        runs: [
          run({
            runId: "x",
            waitingReason: "prompt",
            screen: [
              "⏺ Done. The receipt now holds across polls and the stale note sits on each card.",
              "",
              "╭" + "─".repeat(118) + "╮",
              "│ >" + " ".repeat(116) + "│",
              "╰" + "─".repeat(118) + "╯",
              "  ? for shortcuts",
            ].join("\n"),
            choices: [],
          }),
          run({
            runId: "y",
            project: "api",
            title: "Rotate the staging keys",
            screen: null,
            choices: [],
          }),
        ],
        hosts: [],
      };
    },
    run: async (page, _h, file) => {
      await cardCount(page, 2);
      await fullShot(page, file);
    },
  },
  {
    name: "answer-outcomes",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = {
        runs: [
          run({ runId: "ok", project: "web-app" }),
          run({ runId: "refused", project: "api", title: "Rotate the staging keys" }),
          run({ runId: "lost", project: "daintree", title: "Tidy the release notes" }),
          run({ runId: "held", project: "docs", title: "Rewrite the pairing guide" }),
        ],
        hosts: [],
      };
      h.scenario.answer = async ({ runId }) => {
        if (runId === "ok") {
          // Answered: the agent moves on and the next read no longer lists it.
          h.scenario.waiting = {
            ...h.scenario.waiting,
            runs: h.scenario.waiting.runs.filter((r) => r.runId !== "ok"),
          };
          return;
        }
        if (runId === "refused") {
          throw refusal("This project is being driven from another screen. Nothing was pressed.");
        }
        if (runId === "held") await new Promise(() => {});
      };
    },
    run: async (page, harness, file) => {
      await cardCount(page, 4);
      await page.route("**/api/answer", async (route) => {
        const body = route.request().postDataJSON() as { runId?: string };
        if (body.runId === "lost") return route.abort("connectionreset");
        return route.continue();
      });
      const settle = async () => {
        await page.waitForTimeout(300); // let the answer's reply land under a frozen clock
        await page.clock.runFor(700);
        await page.waitForTimeout(300); // the re-poll the answer schedules
      };
      await press(page, 0, "Yes");
      await settle();
      await nextPoll(page);
      const cardIndex = async (project: string) =>
        (await page.locator("#runs .run").allTextContents()).findIndex((t) => t.includes(project));
      await press(page, await cardIndex("api"), "Yes");
      await settle();
      await nextPoll(page);
      await press(page, await cardIndex("daintree"), "Yes");
      await settle();
      await nextPoll(page);
      await press(page, await cardIndex("docs"), "Yes");
      await page.waitForTimeout(300); // the held answer's in-flight render
      await page.clock.runFor(500);
      expect(harness.scenario.waiting.runs.some((r) => r.runId === "ok")).toBe(false);
      await expect(page.locator("#runs")).toContainText("Pressing");
      await fullShot(page, file);
    },
  },
  {
    name: "stale-scrolled",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = SEVERAL;
    },
    run: async (page, _h, file) => {
      await cardCount(page, 4);
      await page.clock.runFor(60_000 - 3_000);
      await page.route("**/api/waiting*", (route) => route.abort("connectionrefused"));
      await page.clock.runFor(3_000);
      await expect(page.locator("#status")).toContainText("Couldn't reach", { timeout: 10_000 });
      await page.clock.runFor(2 * 60_000);
      await page.waitForTimeout(200); // the failed reads' renders
      await card(page, 2).scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const third = document.querySelectorAll("#runs .run")[2] as HTMLElement | undefined;
        third?.scrollIntoView({ block: "start" });
      });
      await viewportShot(page, file);
    },
  },
  {
    name: "back-from-background",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = SEVERAL;
    },
    run: async (page, _h, file) => {
      await cardCount(page, 4);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.runFor(47 * 60_000);
      // The read that the return starts is still on its way.
      await page.route("**/api/waiting*", () => {});
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.runFor(500);
      await page.waitForTimeout(200); // the return's render
      await viewportShot(page, file);
    },
  },
  {
    name: "host-notes",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = {
        runs: [run({})],
        hosts: [
          { hostId: "studio-03", host: "studio-03", status: "ok" },
          { hostId: "mini", host: "Mac mini", status: "ok" },
          { hostId: "studio-04", host: "studio-04", status: "needs-update" },
          { hostId: "laptop", host: "Old laptop", status: "not-connected" },
        ],
      };
    },
    run: async (page, harness, file) => {
      await cardCount(page, 1);
      harness.scenario.waiting = {
        ...harness.scenario.waiting,
        hosts: harness.scenario.waiting.hosts.map((h) =>
          h.hostId === "mini" ? { ...h, status: "unreachable" } : h
        ),
      };
      await page.clock.runFor(5 * 60_000);
      await page.waitForTimeout(300); // the reads' renders
      await expect(page.locator("#hosts")).toContainText("Mac mini");
      await fullShot(page, file);
    },
  },
  {
    name: "hosts-unlisted",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = { runs: [run({})], hosts: [], hostsUnlisted: true };
    },
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await expect(page.locator("#hosts")).toContainText("Couldn't list");
      await fullShot(page, file);
    },
  },
  {
    name: "empty-all-read",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = {
        runs: [],
        hosts: [
          { hostId: "studio-03", host: "studio-03", status: "ok" },
          { hostId: "mini", host: "Mac mini", status: "ok" },
        ],
      };
    },
    run: async (page, _h, file) => {
      await expect(page.locator("#empty")).toBeVisible({ timeout: 10_000 });
      await viewportShot(page, file);
    },
  },
  {
    name: "empty-host-missing",
    paired: true,
    setup: (h) => {
      h.scenario.waiting = {
        runs: [],
        hosts: [
          { hostId: "studio-03", host: "studio-03", status: "ok" },
          { hostId: "mini", host: "Mac mini", status: "not-connected" },
        ],
      };
    },
    run: async (page, _h, file) => {
      await expect(page.locator("#empty")).toBeVisible({ timeout: 10_000 });
      await viewportShot(page, file);
    },
  },
  {
    name: "unpair-confirm",
    paired: true,
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await page.locator("#forget").click({ timeout: 5_000 });
      await expect(page.getByRole("dialog")).toBeVisible();
      await viewportShot(page, file);
    },
  },
  {
    name: "unpair-failed",
    paired: true,
    run: async (page, _h, file) => {
      await cardCount(page, 1);
      await page.route("**/api/unpair", (route) => route.abort("connectionrefused"));
      await page.locator("#forget").click({ timeout: 5_000 });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /unpair/i })
        .click({ timeout: 5_000 });
      await expect(page.locator("#unpair-error")).toContainText(/Couldn't (confirm )?unpair/, {
        timeout: 10_000,
      });
      await viewportShot(page, file);
    },
  },
];

test.describe("device answer page review", () => {
  test("captures every state", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_DEVICE_ANSWER is required for the device answer page capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_DEVICE_ANSWER to run the device answer page capture");
    test.setTimeout(30 * 60_000);
    mkdirSync(OUT_DIR, { recursive: true });
    for (const name of readdirSync(OUT_DIR)) {
      if (name.endsWith(".png")) rmSync(path.join(OUT_DIR, name));
    }
    const browser = await chromium.launch();
    const failures: string[] = [];
    let written = 0;
    try {
      for (const config of CONFIGS) {
        for (const [index, step] of STEPS.entries()) {
          if (ONLY.length > 0 && !ONLY.includes(step.name)) continue;
          const file = path.join(
            OUT_DIR,
            `${String(index + 1).padStart(2, "0")}-${step.name}--${config.id}.png`
          );
          const harness = await startService(step.paired);
          let page: Page | null = null;
          try {
            await step.setup?.(harness);
            page = await openPage(browser, config, harness, step.paired);
            countReads(page);
            if (step.paired) await expect(page.locator("#main")).toBeVisible({ timeout: 10_000 });
            await step.run(page, harness, file);
            written += 1;
          } catch (error) {
            rmSync(file, { force: true });
            failures.push(
              `${step.name} @ ${config.id}: ${(error as Error).message.split("\n")[0]}`
            );
          } finally {
            await page?.context().close();
            await harness.service.dispose();
          }
        }
      }
    } finally {
      await browser.close();
    }
    const onDisk = readdirSync(OUT_DIR).filter((name) => name.endsWith(".png")).length;
    console.log(`[device-answer-review] wrote ${written} PNGs to ${OUT_DIR} (${onDisk} on disk)`);
    expect(onDisk).toBe(written);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
