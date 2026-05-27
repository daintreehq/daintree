import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { expect, type Page, type ElectronApplication } from "@playwright/test";
import { SEL } from "./selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "./timeouts";
import { ensureWindowFocused } from "./focus";

export function commandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function nodeScriptCommand(scriptPath: string, args: string[] = []): string {
  return ["node", commandArg(scriptPath), ...args].join(" ");
}

export function sameFilesystemEntry(left: string, right: string): boolean {
  const leftReal = fs.realpathSync(left);
  const rightReal = fs.realpathSync(right);
  if (leftReal === rightReal) return true;

  if (process.platform === "win32") {
    const leftNative = fs.realpathSync.native(left).toLowerCase();
    const rightNative = fs.realpathSync.native(right).toLowerCase();
    if (leftNative === rightNative) return true;
  }

  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

export function writeResourceHelper(daintreeDir: string, stateFile: string): string {
  const scriptPath = path.join(daintreeDir, "resource-action.cjs");
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      `const stateFile = ${JSON.stringify(stateFile)};`,
      "const action = process.argv[2];",
      "const writeState = (status) => fs.writeFileSync(stateFile, JSON.stringify({ status }));",
      "if (action === 'provision' || action === 'resume') {",
      "  writeState('ready');",
      "} else if (action === 'pause') {",
      "  writeState('paused');",
      "} else if (action === 'teardown') {",
      "  fs.rmSync(stateFile, { force: true });",
      "} else if (action === 'status') {",
      "  try { process.stdout.write(fs.readFileSync(stateFile, 'utf8')); }",
      "  catch { process.stdout.write(JSON.stringify({ status: 'unknown' })); }",
      "} else if (action === 'env-status') {",
      "  const markerFile = process.argv[3];",
      "  fs.writeFileSync(markerFile, [",
      "    process.env.DAINTREE_WORKTREE_NAME || '',",
      "    process.env.DAINTREE_WORKTREE_PATH || '',",
      "    process.env.DAINTREE_PROJECT_ROOT || '',",
      "  ].join('\\n'));",
      "  try { process.stdout.write(fs.readFileSync(stateFile, 'utf8')); }",
      "  catch { process.stdout.write(JSON.stringify({ status: 'unknown' })); }",
      "} else if (action === 'connect') {",
      "  console.log(process.argv.slice(3).join(' '));",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  console.error('Unknown resource action: ' + action);",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n")
  );
  return scriptPath;
}

export function writeResourceConfig(repoDir: string) {
  const daintreeDir = path.join(repoDir, ".daintree");
  fs.mkdirSync(daintreeDir, { recursive: true });

  const stateFile = path.join(daintreeDir, "resource-state.json");
  const helperScript = writeResourceHelper(daintreeDir, stateFile);

  const config = {
    setup: [],
    teardown: [],
    resource: {
      provision: [nodeScriptCommand(helperScript, [commandArg("provision")])],
      teardown: [nodeScriptCommand(helperScript, [commandArg("teardown")])],
      resume: [nodeScriptCommand(helperScript, [commandArg("resume")])],
      pause: [nodeScriptCommand(helperScript, [commandArg("pause")])],
      status: nodeScriptCommand(helperScript, [commandArg("status")]),
      connect: nodeScriptCommand(helperScript, [
        commandArg("connect"),
        "CONNECTED_TO_{{worktree_name}}",
      ]),
    },
  };

  fs.writeFileSync(path.join(daintreeDir, "config.json"), JSON.stringify(config, null, 2));

  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add resource config"], { cwd: repoDir, stdio: "ignore" });
}

export async function createWorktree(window: Page, branch: string) {
  const newBtn = window.locator('button[aria-label="Create new worktree"]');
  await newBtn.click();

  const dialog = window.locator(SEL.worktree.newDialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

  const branchInput = window.locator(SEL.worktree.branchNameInput);
  await branchInput.fill(branch);

  const pathInput = window.locator('[data-testid="worktree-path-input"]');
  await expect
    .poll(async () => (await pathInput.inputValue()).trim().length, {
      timeout: T_LONG,
      message: "Worktree path should auto-populate",
    })
    .toBeGreaterThan(0);

  const createBtn = window.locator(SEL.worktree.createButton);
  await createBtn.click();

  const card = window.locator(SEL.worktree.card(branch));
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

export async function deleteWorktree(window: Page, app: ElectronApplication, branch: string) {
  const card = window.locator(SEL.worktree.card(branch));
  const actionsBtn = card.locator(SEL.worktree.actionsMenu);
  await ensureWindowFocused(app);
  await actionsBtn.click();

  const deleteItem = window.getByRole("menuitem", { name: /delete/i });
  await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
  await deleteItem.hover();
  await deleteItem.click();

  const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
  await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
  await confirmBtn.click();

  await waitForWorktreeCardRemoval(window, branch);
}

export async function waitForWorktreeCardRemoval(window: Page, branch: string) {
  const card = window.locator(SEL.worktree.card(branch));

  await expect
    .poll(
      async () => {
        const count = await card.count();
        if (count === 0) return 0;

        await window.evaluate(() => (window as any).electron.worktree.refresh());
        return card.count();
      },
      {
        timeout: T_LONG,
        message: `Worktree card ${branch} should disappear after delete`,
      }
    )
    .toBe(0);
}
