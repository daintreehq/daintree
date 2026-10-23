import { DEFAULT_DISABLED_PLUGIN_IDS } from "../../../shared/config/pluginDefaults";

/**
 * The "vanilla" Daintree contract (#14129): a fresh profile, built-ins at their
 * shipped defaults, no installed or project-local plugins, and a local project
 * with ordinary terminal panels. GitHub and GitLab stay enabled — an install
 * with them removed is a different product, and measuring it would hide the
 * cost vanilla users actually pay.
 *
 * Pure data, shared by the unit tests that assert operation counts and by the
 * manual packaged measurement, so both describe the same installation.
 */

export const VANILLA_PANEL_COUNTS = [20, 100] as const;
export type VanillaPanelCount = (typeof VANILLA_PANEL_COUNTS)[number];

export interface VanillaPluginPolicy {
  /** Built-ins that need an explicit enable choice and therefore must be idle. */
  readonly defaultDisabledPluginIds: readonly string[];
  /** Plugins the user installed; always empty for vanilla. */
  readonly installedPluginIds: readonly string[];
  /** Plugins found under the project's `.daintree/plugins`; always empty. */
  readonly projectPluginIds: readonly string[];
  /** Plugin preference overrides written to the profile; absent so defaults apply. */
  readonly pluginPreferenceOverrides: null;
}

export function vanillaPluginPolicy(): VanillaPluginPolicy {
  return {
    defaultDisabledPluginIds: [...DEFAULT_DISABLED_PLUGIN_IDS],
    installedPluginIds: [],
    projectPluginIds: [],
    pluginPreferenceOverrides: null,
  };
}

export function parseVanillaPanelCount(value: string | undefined): VanillaPanelCount {
  const parsed = Number(value);
  const match = VANILLA_PANEL_COUNTS.find((count) => count === parsed);
  if (match === undefined) {
    throw new Error(
      `--panels must be one of ${VANILLA_PANEL_COUNTS.join(", ")} (got: ${value ?? "(none)"})`
    );
  }
  return match;
}

export interface VanillaFixtureReadiness {
  panelCount: VanillaPanelCount;
  livePanelCount: number;
  /** Non-builtin plugins the running app loaded from the profile. */
  installedPluginIds: readonly string[];
  /** Plugins the running app loaded from the project's `.daintree/plugins`. */
  projectPluginIds: readonly string[];
}

/**
 * Why a run does not describe vanilla Daintree; empty is the only pass. A run
 * that fails here is discarded rather than reported, since its numbers would be
 * attributed to a configuration that was not the one measured.
 */
export function vanillaFixtureProblems(readiness: VanillaFixtureReadiness): string[] {
  const problems: string[] = [];
  if (readiness.livePanelCount !== readiness.panelCount) {
    problems.push(`expected ${readiness.panelCount} panels, found ${readiness.livePanelCount}`);
  }
  if (readiness.installedPluginIds.length > 0) {
    problems.push(`installed plugins present: ${readiness.installedPluginIds.join(", ")}`);
  }
  if (readiness.projectPluginIds.length > 0) {
    problems.push(`project plugins present: ${readiness.projectPluginIds.join(", ")}`);
  }
  return problems;
}

export interface ProcessMetric {
  type: string;
  name?: string;
  cpuCumulativeSeconds: number;
  workingSetKb: number;
  idleWakeupsPerSecond: number;
}

export interface VanillaProcessTotals {
  processCount: number;
  utilityProcessCount: number;
  cpuSeconds: number;
  workingSetKb: number;
  idleWakeupsPerSecond: number;
}

export function totalProcessMetrics(metrics: readonly ProcessMetric[]): VanillaProcessTotals {
  let cpuSeconds = 0;
  let workingSetKb = 0;
  let idleWakeupsPerSecond = 0;
  let utilityProcessCount = 0;
  for (const metric of metrics) {
    cpuSeconds += metric.cpuCumulativeSeconds;
    workingSetKb += metric.workingSetKb;
    idleWakeupsPerSecond += metric.idleWakeupsPerSecond;
    if (metric.type === "Utility") utilityProcessCount++;
  }
  return {
    processCount: metrics.length,
    utilityProcessCount,
    cpuSeconds,
    workingSetKb,
    idleWakeupsPerSecond,
  };
}
