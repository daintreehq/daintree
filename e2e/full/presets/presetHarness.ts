import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { expect, type Page } from "@playwright/test";
import { dispatchAction } from "../../helpers/actions";
import {
  fakeAgentEnv,
  installFakeAgent,
  readFakeAgentLaunchLog,
  type FakeAgentLaunchRecord,
} from "../../helpers/fakeAgent";
import { removePathSync } from "../../helpers/fixtures";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { E2E_TEMP_PREFIX, recordTempDir } from "../../helpers/tempDirs";

/**
 * A fake `claude` (and optionally `codex`) on PATH. Launchable is the
 * precondition for the toolbar split-button, its preset chevron and the
 * launcher's preset disclosure, and every launch lands in the agent's own
 * record of the argv and env it actually received.
 */
export interface FakeAgents {
  claudeBin: string;
  codexBin: string | null;
  env: Record<string, string>;
  dispose(): void;
}

export function installPresetAgents(
  fixtureDir: string,
  options: { codex?: boolean } = {}
): FakeAgents {
  const claudeBin = installFakeAgent(fixtureDir, { recordEnv: ["DAINTREE_E2E_PRESET"] });
  let codexDir: string | null = null;
  let codexBin: string | null = null;
  if (options.codex) {
    // One identity per bin dir, so Codex gets a directory of its own.
    codexDir = mkdtempSync(path.join(tmpdir(), `${E2E_TEMP_PREFIX}preset-codex-`));
    recordTempDir(codexDir);
    codexBin = installFakeAgent(codexDir, { identity: "codex" });
  }
  const bins = [claudeBin, ...(codexBin ? [codexBin] : [])];
  const env = {
    ...fakeAgentEnv(claudeBin),
    PATH: [...bins, process.env.PATH ?? ""].join(path.delimiter),
    DAINTREE_CLI_PATH_PREPEND: bins.join(path.delimiter),
  };
  return {
    claudeBin,
    codexBin,
    env,
    dispose: () => {
      if (codexDir) removePathSync(codexDir);
    },
  };
}

/**
 * Launch records the binary wrote after the first `since` launches. Pass
 * `paneId` whenever another pane may launch the same binary meanwhile: a
 * restored agent panel relaunches on boot, and on Windows its record can land
 * after `since` was read.
 */
export async function waitForLaunchesSince(
  binDir: string,
  since: number,
  count = 1,
  options: { paneId?: string } = {}
): Promise<FakeAgentLaunchRecord[]> {
  const fresh = (): FakeAgentLaunchRecord[] =>
    readFakeAgentLaunchLog(binDir)
      .slice(since)
      .filter((record) => options.paneId === undefined || record.paneId === options.paneId);
  await expect
    .poll(() => fresh().length, {
      message: `expected ${count} new fake-agent launch(es) in ${binDir}${
        options.paneId ? ` from pane ${options.paneId}` : ""
      }`,
      timeout: T_LONG,
    })
    .toBeGreaterThanOrEqual(count);
  return fresh();
}

export async function setAgentSettings(
  page: Page,
  agentId: string,
  settings: Record<string, unknown>
): Promise<void> {
  const result = await dispatchAction(page, "agentSettings.set", { agentId, settings });
  expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
}

export async function setAgentPinned(page: Page, agentId: string, pinned: boolean): Promise<void> {
  await setAgentSettings(page, agentId, { pinned });
}

/** Close Settings if it is open and wait until it has actually gone. */
export async function closeSettings(page: Page): Promise<void> {
  const heading = page.locator(SEL.settings.heading);
  if (await heading.isVisible()) {
    await page.locator(SEL.settings.closeButton).click();
  }
  await expect(heading).toBeHidden({ timeout: T_MEDIUM });
}

export interface PersistedPreset {
  id: string;
  name: string;
  env?: Record<string, string>;
  args?: string[];
  color?: string;
}

export async function readCustomPresets(
  page: Page,
  agentId = "claude"
): Promise<PersistedPreset[]> {
  return page.evaluate(async (id) => {
    const settings = await window.electron.agentSettings.get();
    const agents = settings.agents as
      Record<string, { customPresets?: PersistedPreset[] } | undefined> | undefined;
    const presets = agents?.[id]?.customPresets;
    return Array.isArray(presets) ? presets : [];
  }, agentId);
}

export async function readSelectedPresetId(page: Page, agentId = "claude"): Promise<string | null> {
  return page.evaluate(async (id) => {
    const settings = await window.electron.agentSettings.get();
    const agents = settings.agents as Record<string, { presetId?: string } | undefined> | undefined;
    return agents?.[id]?.presetId ?? null;
  }, agentId);
}
