import { mkdirSync, realpathSync, writeFileSync } from "fs";
import path from "path";
import { REAL_CLAUDE, type Director } from "./harness";
import { TASKS, TOOLBAR_CLAUDE, TOOLBAR_AGENT } from "./scenesA";

const hybridInput = (id: string) => `[data-panel-id="${id}"] .cm-content`;

async function gridPanelIds(d: Director): Promise<string[]> {
  return d.page
    .locator('[data-panel-location="grid"][data-panel-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel-id")!));
}

/** 83.5 – 108.5: worktrees are workspaces holding terminals, agents and panels. */
export async function sceneWorktrees(d: Director): Promise<void> {
  await d.switchProject("brush-cms");
  await d.selectWorktree("feature/asset-library");
  await d.agent({ worktree: "feature/asset-library", task: TASKS.assets });
  await d.selectWorktree("bugfix/auth-redirect");
  await d.page.waitForTimeout(2000);

  await d.beginScene("D-worktrees", 83.5, 108.5);
  await d.beat(83.8, "sweep worktrees", () =>
    d.moveTo('[data-worktree-row]:has([data-worktree-is-main="true"])', 900, 0.3, 0.07)
  );
  await d.beat(85.6, "sweep 2", () =>
    d.moveTo(
      '[data-worktree-row]:has([data-worktree-branch="bugfix/auth-redirect"])',
      900,
      0.3,
      0.07
    )
  );
  await d.beat(87.0, "sweep 3", () =>
    d.moveTo(
      '[data-worktree-row]:has([data-worktree-branch="feature/rich-text-editor"])',
      800,
      0.3,
      0.07
    )
  );
  await d.beat(88.6, "sweep 4", () =>
    d.moveTo(
      '[data-worktree-row]:has([data-worktree-branch="feature/asset-library"])',
      800,
      0.3,
      0.07
    )
  );
  await d.beat(91.6, "main worktree", () => d.pickWorktree("main"));
  await d.beat(94.6, "secondary worktree", () => d.pickWorktree("feature/asset-library", 800));
  await d.beat(97.5, "hover workspace", () => d.demo("moveTo", 60, 45, 1200));
  await d.beat(100.4, "terminal", async () => {
    const r = await d.dispatch<{ terminalId: string }>("terminal.new", {});
    setTimeout(() => {
      void d
        .demo(
          "typeInTerminal",
          `[data-panel-id="${r.terminalId}"]`,
          "git --no-pager log --oneline --graph --all",
          18
        )
        .then(() => d.demo("sendKeyToTerminal", `[data-panel-id="${r.terminalId}"]`, "enter"))
        .catch(() => {});
    }, 600);
  });
  await d.beat(102.7, "agent terminal", async () => {
    const id = await d.clickLaunch(TOOLBAR_AGENT("Codex"), 700);
    void d
      .ready(id)
      .then(() => d.page.waitForTimeout(800))
      .then(() => d.say(id, "Add drag and drop uploads to the asset library in src/assets"))
      .catch(() => {});
  });
  await d.beat(104.6, "file browser panel", () => d.dispatch("worktree.openFileBrowserPanel", {}));
  await d.beat(106.0, "rest", () => d.demo("moveTo", 64, 60, 1200));
  await d.endScene(108.5);
}

/** 108.5 – 143.8: plan in main, spin out a worktree, review, merge. */
export async function sceneWorkflow(d: Director): Promise<void> {
  const repo = d.projects.get("brush-cms")!.repo;
  await d.selectWorktree("main");
  for (const id of await gridPanelIds(d))
    await d.dispatch("terminal.close", { terminalId: id }).catch(() => {});
  await d.page.waitForTimeout(1500);

  let main = "";
  const branch = "feature/editor-toolbar";
  const wtPath = path.join(path.dirname(repo.dir), "brush-cms-worktrees", "feature-editor-toolbar");

  await d.beginScene("E-workflow", 108.5, 143.8);
  await d.beat(109.2, "start claude", async () => {
    main = await d.clickLaunch(TOOLBAR_CLAUDE, 900);
    void d.ready(main);
  });
  await d.beat(112.2, "spotlight main card", () =>
    d.demo("spotlight", '[data-worktree-is-main="true"]', 6)
  );
  await d.beat(113.8, "dismiss", () => d.demo("dismissSpotlight"));
  await d.beat(114.2, "type plan", async () => {
    await d.moveTo(hybridInput(main), 500);
    await d.demo(
      "type",
      hybridInput(main),
      REAL_CLAUDE
        ? "Plan a formatting toolbar for src/editor. No code yet"
        : "Plan a formatting toolbar for the editor",
      24
    );
  });
  await d.beat(116.6, "send plan", async () => {
    await d.page.keyboard.press("Enter");
    if (REAL_CLAUDE) return;
    await d.task(main, {
      title: "Plan editor toolbar",
      spin: "Planning",
      then: "done",
      stepMs: 450,
      steps: [
        "• Read(src/editor/RichTextEditor.tsx)",
        "| Read 142 lines",
        '• Search(pattern: "toolbar", path: "src")',
        "| Found 2 files",
        "• Plan:",
        "|   1. Toolbar component with bold, italic, code, link",
        "|   2. Keyboard shortcuts wired to editor commands",
        "|   3. Tests for each command",
      ],
    });
  });
  await d.beat(119.2, "type worktree", async () => {
    await d.demo(
      "type",
      hybridInput(main),
      REAL_CLAUDE
        ? "Then create a new worktree and branch for it and implement it there"
        : "Create a worktree and branch, then implement it there",
      26
    );
  });
  await d.beat(122.3, "send worktree", async () => {
    await d.page.keyboard.press("Enter");
    if (!REAL_CLAUDE) {
      await d.task(main, {
        title: "Plan editor toolbar",
        spin: "Creating worktree",
        then: "done",
        stepMs: 500,
        steps: [
          `• Bash(git worktree add ../brush-cms-worktrees/feature-editor-toolbar -b ${branch})`,
          `| Preparing worktree (new branch '${branch}')`,
        ],
        summary: `Created ${branch}. Implementation is running there.`,
      });
    }
    // Daintree registers projects by resolved path (/tmp is /private/tmp on macOS).
    const root = realpathSync(repo.dir);
    await d.dispatch("worktree.create", {
      // The selector names the repository by one of its worktrees; main is always there.
      worktreeId: await d.worktreeId("main"),
      options: {
        baseBranch: "main",
        newBranch: branch,
        path: path.join(path.dirname(root), "brush-cms-worktrees", "feature-editor-toolbar"),
      },
    });
  });
  // The planning agent is picked up by its header and dropped onto the new worktree's card:
  // Daintree moves the live panel into that worktree.
  await d.beat(123.9, "drag agent into new worktree", async () => {
    const card = `[data-worktree-branch="${branch}"]`;
    await d.page.locator(card).first().waitFor({ state: "visible", timeout: 2500 });
    await d.demo("drag", `[data-panel-id="${main}"] [data-pane-chrome]`, card, 1300);
    // The diff the review below shows; the live agent keeps working on top of it.
    mkdirSync(path.join(wtPath, "src/editor"), { recursive: true });
    writeFileSync(path.join(wtPath, "src/editor/Toolbar.tsx"), TOOLBAR_SRC);
    writeFileSync(path.join(wtPath, "src/editor/Toolbar.test.tsx"), TOOLBAR_TEST);
    writeFileSync(
      path.join(wtPath, "src/editor/RichTextEditor.tsx"),
      'import { Toolbar } from "./Toolbar";\n\nexport function RichTextEditor() {\n  return (\n    <div className="editor-shell">\n      <Toolbar />\n      <div className="editor" contentEditable suppressContentEditableWarning />\n    </div>\n  );\n}\n'
    );
  });
  await d.beat(125.8, "open new worktree", async () => {
    await d.pickWorktree(branch, 900);
    // After a cross-worktree move Daintree offers "Tell it to continue in <worktree>"; use it.
    const handoff = d.page
      .locator(`[data-panel-id="${main}"]`)
      .getByText(/Tell it to continue in/i)
      .first();
    if (
      await handoff
        .waitFor({ state: "visible", timeout: 2000 })
        .then(() => true)
        .catch(() => false)
    ) {
      await d.click(handoff, 600);
      d.note("clicked continue-in-worktree handoff");
    } else if (REAL_CLAUDE) {
      d.note("no handoff banner; prompting directly");
      void d
        .say(main, "Now implement the toolbar here: bold, italic, code and link, with tests")
        .catch(() => {});
    }
  });
  await d.beat(130.0, "open review", async () => {
    await d
      .moveTo(
        `[data-worktree-row]:has([data-worktree-branch="${branch}"]) [aria-label^="Open Review &"]`,
        700
      )
      .catch(() => {});
    await d.dispatch("worktree.openReviewHub", { worktreeId: await d.worktreeId(branch) });
  });
  await d.beat(131.6, "hover files", () =>
    d.moveTo('[data-testid="review-hub-content"]', 900, 0.3, 0.35)
  );
  // The planning agent now lives in the new worktree, so main gets a fresh agent for the merge.
  // It launches as the review closes so it is up and typing on the narration's cue.
  let merger = "";
  await d.beat(134.9, "close review, back to main", async () => {
    await d.page.keyboard.press("Escape");
    await d.pickWorktree("main", 450);
    merger = await d.clickLaunch(TOOLBAR_CLAUDE, 350);
  });
  // Real keystrokes into the focused input: the demo typer spends a fixed time per character,
  // which ran this 38-character message past Enter at 139.0.
  await d.beat(136.9, "type merge", async () => {
    const input = d.page.locator(hybridInput(merger)).first();
    await input.click({ timeout: 1500 }).catch(() => {});
    await d.page.keyboard.type(`Merge ${branch} into main`, { delay: 30 });
  });
  await d.beat(139.0, "send merge", async () => {
    await d.page.keyboard.press("Enter");
    if (REAL_CLAUDE) {
      // Claude may still be booting when Enter lands; confirm it picked the merge up.
      void (async () => {
        for (let i = 0; i < 20; i++) {
          await d.page.waitForTimeout(700);
          if ((await d.agentState(merger)).includes("working")) return;
          if (i % 4 === 3)
            await d
              .demo("sendKeyToTerminal", `[data-panel-id="${merger}"]`, "enter")
              .catch(() => {});
        }
      })().catch(() => {});
      return;
    }
    await d.task(merger, {
      title: "Merge editor toolbar",
      spin: "Merging",
      then: "done",
      stepMs: 520,
      steps: [
        `• Bash(git merge --no-ff ${branch})`,
        "| Merge made by the 'ort' strategy.",
        "|  3 files changed, 117 insertions(+), 2 deletions(-)",
        "• Bash(npm test)",
        "| ✓ 61 tests passed",
      ],
      summary: `Merged ${branch} into main. All 61 tests pass.`,
    });
  });
  await d.endScene(143.8);
}

/** 143.8 – 170.5: arm a fleet of waiting agents and broadcast one reply. */
export async function sceneFleet(d: Director): Promise<void> {
  await d.selectWorktree("feature/rich-text-editor");
  for (const id of await gridPanelIds(d))
    await d.dispatch("terminal.close", { terminalId: id }).catch(() => {});
  const specs = [
    {
      ...TASKS.toolbar!,
      prompt:
        "Plan a link picker for the editor toolbar in src/editor. Show me the plan, then ask me in plain text (not a multiple-choice question) to confirm before you implement anything",
      title: "Link picker",
    },
    {
      ...TASKS.toolbar!,
      prompt:
        "Plan markdown shortcuts (# for headings, ** for bold) for src/editor. Show me the plan, then ask me in plain text (not a multiple-choice question) to confirm before you implement anything",
      title: "Markdown shortcuts",
    },
    {
      ...TASKS.toolbar!,
      prompt:
        "Plan collaborative cursors for the editor in src/editor. Show me the plan, then ask me in plain text (not a multiple-choice question) to confirm before you implement anything",
      title: "Collab cursors",
    },
    {
      ...TASKS.toolbar!,
      prompt:
        "Plan pasting images from the clipboard into the editor in src/editor. Show me the plan, then ask me in plain text (not a multiple-choice question) to confirm before you implement anything",
      title: "Image paste",
    },
  ];
  const ids: string[] = [];
  // A mixed fleet: one broadcast reaches every CLI.
  const fleetAgents = ["claude", "codex", "grok", "antigravity"];
  for (const [i, sp] of specs.entries()) {
    ids.push(
      await d.agent({
        worktree: "feature/rich-text-editor",
        task: sp,
        agentId: fleetAgents[i % fleetAgents.length],
      })
    );
  }
  if (REAL_CLAUDE) {
    for (const id of ids) {
      await d.waitState(id, "working", 30_000);
    }
    for (const id of ids) {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline && (await d.agentState(id)).includes("working"))
        await d.page.waitForTimeout(1000);
      d.note(`fleet agent ${id} settled as ${await d.agentState(id)}`);
    }
  } else {
    await d.page.waitForTimeout(2500);
    for (const [i, id] of ids.entries()) {
      await d.task(id, {
        ...specs[i]!,
        prompt: undefined,
        then: "done",
        steps: ["• Bash(npm test -- editor)", "| ✓ 18 tests passed"],
        stepMs: 200,
        summary: "Done with this step. Shall I keep going?",
        onReply: { ...specs[i]!, prompt: undefined, then: "loop" },
      });
    }
    await d.page.waitForTimeout(10000);
  }

  // Keystrokes typed straight into an armed terminal fan out to the fleet only with the
  // hybrid input bar off; the bar's own send path goes to one agent.
  await d.dispatch("terminalConfig.setHybridInputEnabled", { enabled: false });
  await d.page.waitForTimeout(800);

  await d.beginScene("F-fleet", 143.8, 170.5);
  await d.beat(144.6, "hover grid", () => d.demo("moveTo", 40, 40, 1400));
  await d.beat(151.0, "sweep", () => d.demo("moveTo", 78, 40, 1800));
  await d.beat(155.8, "sweep", () => d.demo("moveTo", 78, 78, 1600));
  for (const [i, id] of ids.entries()) {
    await d.beat(160.8 + i * 0.7, `arm ${i + 1}`, async () => {
      // Cursor visits each header; arming goes through the action only, since a header
      // click also changes selection and can undo the arm.
      await d.moveTo(`[data-panel-id="${id}"]`, 450, 0.3, 0.03);
      await d.dispatch("terminal.arm", { terminalId: id });
    });
  }
  await d.beat(163.7, "check fleet", async () => {
    const chip = await d.page
      .locator('[data-testid="fleet-armed-count-chip"]')
      .first()
      .getAttribute("aria-label", { timeout: 1500 })
      .catch(() => null);
    const armed = await d.page.locator('[data-panel-id][data-selected="true"]').count();
    d.note(`fleet armed: chip=${chip} selectedPanels=${armed}`);
  });
  await d.beat(164.0, "type in fleet", async () => {
    // Armed panels hide their input bars; typing lands in the focused terminal and fans out.
    await d.moveTo(`[data-panel-id="${ids[0]}"] .xterm-screen`, 500, 0.4, 0.8);
    await d.demo("click");
    await d.page.keyboard.type("please continue", { delay: 85 });
  });
  await d.beat(167.5, "enter", () => d.page.keyboard.press("Enter"));
  await d.beat(168.0, "rest", () => d.demo("moveTo", 55, 50, 1200));
  await d.endScene(170.5);
  await d.dispatch("terminal.disarmAll").catch(() => {});
  await d.dispatch("terminalConfig.setHybridInputEnabled", { enabled: true }).catch(() => {});
}

const TOOLBAR_SRC = `import { editor } from "./instance";

const COMMANDS = [
  { label: "Bold", shortcut: "Mod-b", run: () => editor.chain().focus().toggleBold().run() },
  { label: "Italic", shortcut: "Mod-i", run: () => editor.chain().focus().toggleItalic().run() },
  { label: "Code", shortcut: "Mod-e", run: () => editor.chain().focus().toggleCode().run() },
  { label: "Link", shortcut: "Mod-k", run: () => editor.chain().focus().toggleLink().run() },
];

export function Toolbar() {
  return (
    <div role="toolbar" aria-label="Formatting" className="toolbar">
      {COMMANDS.map((c) => (
        <button key={c.label} type="button" title={\`\${c.label} (\${c.shortcut})\`} onClick={c.run}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
`;

const TOOLBAR_TEST = `import { render, fireEvent } from "@testing-library/react";
import { Toolbar } from "./Toolbar";

test("renders every formatting command", () => {
  const { getAllByRole } = render(<Toolbar />);
  expect(getAllByRole("button")).toHaveLength(4);
});
`;
