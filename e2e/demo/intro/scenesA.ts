import { REAL_CLAUDE, type Director } from "./harness";
import type { AgentTask } from "./fakeClaude";

export const TOOLBAR_CLAUDE = '[aria-label^="Start Claude"]';
const chip = (id: string) => `[data-panel-id="${id}"] [role="status"][aria-label^="Agent state:"]`;
const panel = (id: string) => `[data-panel-id="${id}"]`;

export const TASKS: Record<string, AgentTask> = {
  toolbar: {
    prompt:
      "Add a formatting toolbar (bold, italic, code, link) to src/editor/RichTextEditor.tsx and cover it with a small test",
    title: "Formatting toolbar",
    spin: "Implementing toolbar",
    then: "loop",
    steps: [
      "• Read(src/editor/RichTextEditor.tsx)",
      "| Read 142 lines",
      "• Update(src/editor/Toolbar.tsx)",
      "| Updated src/editor/Toolbar.tsx with 38 additions",
      "• Bash(npm test -- editor)",
      "| ✓ 18 tests passed",
    ],
  },
  auth: {
    prompt:
      "Fix the open redirect in src/auth/redirect.ts so only same-origin paths are allowed, then add tests for it",
    title: "Auth redirect fix",
    spin: "Tracing redirect",
    then: "loop",
    steps: [
      "• Search(pattern: \"searchParams.get('next')\")",
      "| Found 2 files",
      "• Update(src/auth/redirect.ts)",
      "| Updated with 11 additions and 2 removals",
    ],
  },
  assets: {
    prompt:
      "Make the asset library in src/assets searchable by name with a debounced query, and explain the approach",
    title: "Asset search",
    spin: "Wiring search",
    then: "loop",
    steps: [
      "• Read(src/assets/AssetLibrary.tsx)",
      "| Read 34 lines",
      "• Update(src/assets/useAssets.ts)",
      "| Updated with 9 additions",
    ],
  },
  api: {
    prompt:
      "Design and add rate limiting middleware to src/api/server.ts. Think it through carefully first",
    title: "API rate limiting",
    spin: "Adding middleware",
    then: "loop",
    steps: [
      "• Read(src/api/server.ts)",
      "| Read 61 lines",
      "• Write(src/api/rateLimit.ts)",
      "| Wrote 44 lines",
    ],
  },
};

/** Prompts that end in a genuine question within seconds, so the agent is waiting on you (auto mode approves tools). */
export const WAIT_PROMPTS = {
  tests:
    "Look at src/auth/redirect.ts and the tests in tests/. Ask me one question about how strict the redirect rules should be, then stop and wait for my answer",
  bench:
    "We want to batch writes in src/queue.ts. Ask me whether latency or throughput matters more for this, then stop and wait for my answer",
};

export function asking(base: AgentTask, question: string): AgentTask {
  return {
    ...base,
    prompt: undefined,
    then: "ask",
    steps: [base.steps![0]!],
    stepMs: 250,
    question,
    after: { ...base, prompt: undefined, then: "loop" },
  };
}

/** Toolbar launch buttons, labelled `Start <name>` by AgentButton. */
export const TOOLBAR_AGENT = (name: string) => `[aria-label^="Start ${name}"]`;

/** Launches in scene A: a different CLI on each button, each given real work. */
const GRID_LAUNCHES: Array<{ name: string; prompt: string; asks?: boolean }> = [
  {
    name: "Codex",
    prompt:
      "Look at src/auth/redirect.ts and tests/. Ask me one short question about how strict the redirect rules should be, then stop and wait for my answer.",
    asks: true,
  },
  {
    name: "Antigravity",
    prompt:
      "Make the asset library in src/assets searchable by name with a debounced query, and explain the approach.",
  },
  {
    name: "Grok",
    prompt:
      "Design rate limiting middleware for src/api/server.ts. Think it through carefully, then implement it.",
  },
];

/** 0 – 27: the grid reflows as agents launch; working vs waiting indicators. */
export async function sceneGrid(d: Director, s: { first: string }): Promise<string[]> {
  const ids = [s.first];
  await d.beginScene("A-grid", 0, 27);
  await d.beat(0.4, "cursor to toolbar", () =>
    d.moveTo(TOOLBAR_AGENT(GRID_LAUNCHES[0]!.name), 1600)
  );
  const launchAt = [2.9, 4.3, 5.9];
  for (const [i, spec] of GRID_LAUNCHES.entries()) {
    await d.beat(launchAt[i]!, `launch ${spec.name}`, async () => {
      const button = d.page.locator(TOOLBAR_AGENT(spec.name)).first();
      let id: string;
      if (await button.isVisible().catch(() => false)) {
        id = await d.clickLaunch(TOOLBAR_AGENT(spec.name), i === 0 ? 250 : 500);
      } else {
        // Not on the toolbar this run: the cursor stays on the toolbar while the action launches it.
        d.note(`toolbar button for ${spec.name} missing; launching via action`);
        id = (
          await d.dispatch<{ terminalId: string }>("agent.launch", {
            agentId: spec.name.toLowerCase(),
            location: "grid",
            force: true,
          })
        ).terminalId;
      }
      ids.push(id);
      void d
        .ready(id)
        .then(() => d.page.waitForTimeout(1200))
        .then(() => d.say(id, spec.prompt))
        .catch(() => {});
    });
  }
  await d.beat(8.6, "cursor to chip 1", () => d.moveTo(chip(ids[0]!), 900));
  await d.beat(9.4, "spotlight chip 1", () => d.demo("spotlight", chip(ids[0]!), 18));
  await d.beat(11.2, "cursor to chip 3", async () => {
    await d.demo("dismissSpotlight");
    await d.moveTo(chip(ids[2] ?? ids[0]!), 700);
    await d.demo("spotlight", chip(ids[2] ?? ids[0]!), 18);
  });
  await d.beat(13.2, "dismiss", () => d.demo("dismissSpotlight"));

  // Working: hold until some agent really reads working, then cut straight to it.
  await d.at(14.9);
  const working = await d.waitAny(ids, "working", 45_000);
  d.cutTo(15.2, `working ${working ?? "none"}`);
  await d.beat(15.2, "spotlight working", async () => {
    const id = working ?? ids[0]!;
    // Spotlight first so the highlight lands on the cut; the cursor follows.
    await d.demo("spotlight", panel(id), 6);
    await d.moveTo(chip(id), 600);
  });

  // Waiting: the amber circle can take a minute to arrive; record through the wait and
  // cut it out, so the highlight lands the moment it appears.
  await d.at(17.2);
  await d.demo("dismissSpotlight").catch(() => {});
  const waiting = await d.waitWaitingAfterWork(ids, 180_000);
  d.cutTo(17.5, `waiting ${waiting ?? "none"}`);
  await d.beat(17.5, "spotlight waiting", async () => {
    const id = waiting ?? ids[1]!;
    await d.demo("spotlight", panel(id), 6);
    await d.moveTo(chip(id), 600);
  });
  await d.beat(21.4, "dismiss", () => d.demo("dismissSpotlight"));
  await d.beat(22.5, "idle cursor", () => d.demo("moveTo", 62, 58, 1400));
  await d.endScene(27);
  return ids;
}

/** 27 – 57: across projects with Pilot (⌥⌘O) and the project view (⌥⌘I). */
export async function scenePilot(d: Director): Promise<void> {
  await d.beginScene("B-pilot", 27, 57);
  await d.beat(27.6, "cursor to project switcher", () =>
    d.moveTo('[data-testid="project-switcher-trigger"]', 900)
  );
  await d.beat(28.9, "open switcher", () => d.demo("click"));
  await d.beat(32.6, "close switcher", () => d.page.keyboard.press("Escape"));
  await d.beat(34.0, "caption ⌥⌘O", () =>
    d.demo("annotate", "", "⌥  ⌘  O", "screen-center", "xl", "keys")
  );
  await d.beat(35.2, "open pilot", async () => {
    await d.demo("dismissAnnotation", "keys");
    await d.openPilot("pilot.toggle");
  });
  await d.beat(37.0, "hover groups", () => d.moveTo('[data-testid="pilot-group-header"]', 900));
  await d.beat(39.6, "attention filter", () =>
    d.click(
      d.page
        .locator(
          '[data-testid="pilot-filter-bar"] button, [data-testid="pilot-filter-bar"] [role="tab"]'
        )
        .filter({ hasText: "Attention" })
        .first(),
      800
    )
  );
  await d.beat(41.9, "hover waiting row", async () => {
    // Real Claude names its own sessions, so prefer the Surge Checkout row, then any
    // wallet/payment wording, then whichever agent is first in the attention list.
    const rows = d.page.locator('[data-testid="pilot-row"]');
    const candidates = [
      rows.filter({ hasText: /apple|wallet/i }).first(),
      rows.filter({ hasText: /pay|checkout/i }).first(),
      d.page
        .locator('[data-testid="pilot-group-header"]:has-text("Surge") ~ [data-testid="pilot-row"]')
        .first(),
      rows.first(),
    ];
    for (const row of candidates) {
      if (await row.isVisible().catch(() => false)) return d.moveTo(row, 800);
    }
    throw new Error("no pilot row to open");
  });
  await d.beat(43.5, "open waiting agent", async () => {
    await d.demo("click");
    await d.page.waitForTimeout(400);
    await d.follow();
  });
  await d.beat(45.3, "answer question", async () => {
    const input = d.page.locator('[data-panel-location="grid"] .cm-content').first();
    await d.moveTo(input, 700);
    await d.demo(
      "type",
      '[data-panel-location="grid"] .cm-content',
      REAL_CLAUDE ? "Use the Payment Request API" : "Yes, use the new wallet API",
      20
    );
  });
  await d.beat(48.4, "send", () => d.page.keyboard.press("Enter"));
  await d.beat(51.2, "caption ⌥⌘I", () =>
    d.demo("annotate", "", "⌥  ⌘  I", "screen-center", "xl", "keys")
  );
  await d.beat(52.5, "project agents", async () => {
    await d.demo("dismissAnnotation", "keys");
    await d.openPilot("pilot.openProject");
  });
  await d.beat(54.0, "hover rows", () => d.moveTo('[data-testid="pilot-row"]', 900));
  await d.endScene(57);
  await d.page.keyboard.press("Escape").catch(() => {});
}

/** 57 – 83.5: a small setup is fine; scaling means projects, worktrees, agents. */
export async function sceneScale(d: Director): Promise<void> {
  await d.beginScene("C-scale", 57, 83.5);
  await d.beat(58.0, "rest cursor", () => d.demo("moveTo", 55, 55, 1500));
  await d.beat(74.2, "to switcher", () =>
    d.moveTo('[data-testid="project-switcher-trigger"]', 800)
  );
  await d.beat(75.0, "open switcher", () => d.demo("click"));
  await d.beat(76.3, "pick orbital", async () => {
    const opt = d.page
      .locator('[data-testid="project-switcher-palette"] [role="option"]')
      .filter({ hasText: "Orbital Sync" })
      .first();
    await d.moveTo(opt, 500);
    await d.demo("click");
    await d.page.waitForTimeout(400);
    await d.follow();
  });
  await d.beat(78.0, "pick worktree", () => d.pickWorktree("feature/offline-queue"));
  await d.beat(79.4, "all agents", () => d.openPilot("pilot.toggle"));
  await d.beat(80.9, "attention filter", () =>
    d.click(
      d.page
        .locator(
          '[data-testid="pilot-filter-bar"] button, [data-testid="pilot-filter-bar"] [role="tab"]'
        )
        .filter({ hasText: "Attention" })
        .first(),
      700
    )
  );
  await d.endScene(83.5);
  await d.page.keyboard.press("Escape").catch(() => {});
}
