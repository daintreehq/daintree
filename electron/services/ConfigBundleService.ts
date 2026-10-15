// eager-import-allow: reads portable config via store.get synchronously while building a bundle
import { createHash } from "node:crypto";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import {
  UserAgentRegistryService,
  loadSanitizedUserAgentRegistry,
} from "./UserAgentRegistryService.js";
import { getValidatedOverrides } from "./keybindingOverridesStore.js";
import { getAllowedSoundFiles } from "./getSoundService.js";
import { appCustomSchemesWriteSchema } from "../schemas/customSchemes.js";
import { sanitizeNotificationSettingsPatch } from "../utils/notificationSettingsPatch.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { SAFE_AGENT_ID_PATTERN, UserAgentConfigSchema } from "../../shared/types/index.js";
import {
  getAgentPreset,
  getEffectiveAgentConfig,
  isBuiltInAgent,
} from "../../shared/config/agentRegistry.js";
import { isAgentInstalled } from "../../shared/utils/agentAvailability.js";
import {
  comboAsReadOn,
  readShortcutOn,
  shortcutPlatform,
} from "../../shared/utils/keybindingPortability.js";
import type { CliAvailability } from "../../shared/types/ipc/system.js";
import { buildDefaultKeybindings } from "../../shared/config/defaultKeybindings.js";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/themes.js";
import type { TerminalRecipe, UserAgentConfig } from "../../shared/types/index.js";
import {
  validatePathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "../../shared/utils/pathPattern.js";
import {
  CONFIG_BUNDLE_SECTION_IDS,
  CONFIG_BUNDLE_SECTION_LABELS,
  type ConfigBundlePreviewChange,
  type ConfigBundlePreviewSection,
  type ConfigBundlePreviewSkip,
  type ConfigBundleSectionId,
  type ConfigImportLeafResult,
  type ConfigImportReport,
  type ConfigImportSectionReport,
} from "../../shared/types/configBundle.js";
import type { ConfigBundleSections } from "../utils/configBundleIO.js";
import { readAgentDefaults, restoreAgentDefaults, setAgentDefaults } from "./agentDefaults.js";
import {
  isStorableAssistantAgentId,
  isStorableDefaultAgent,
  type AgentDefaultsPatch,
} from "../../shared/types/ipc/agentDefaults.js";
import {
  diffRecord,
  displayScalar,
  emptyCheck,
  humanizeKey,
  isRecord,
  listLeafValue,
  recordLeafValue,
  sameValue,
  skippedLeaf,
  stableStringify,
  unchangedLeaf,
  withListLeaf,
  withRecordLeaf,
  type SectionCheck,
  type SectionContext,
  type SectionDiff,
  type SectionHandler,
  planUndo,
  settleUndo,
  type UndoLeaf,
  type UndoLeafResult,
  type UndoPlan,
} from "./configBundle/sectionKit.js";
import {
  customPresetIds,
  mergeAgentEntry,
  mergeEnv,
  projectAgentEntry,
  projectAgents,
} from "./configBundle/agentSettingsMerge.js";
import {
  agentUpdateChecksSection,
  assistantModelsSection,
  globalEnvironmentSection,
  hibernationSection,
  idleBackgroundAutoCloseSection,
  idleTerminalNotifySection,
  permissionBypassSection,
  pluginUpdateChecksSection,
  sessionRestoreSection,
} from "./configBundle/settingsSections.js";

/**
 * Reads and writes the portable configuration sections behind Export/Import
 * Configuration (#11889).
 *
 * Two rules shape this file:
 *
 * 1. **Every write goes through the domain's own validation.** There is no
 *    general "reload config" reconciliation path in this app, so each section
 *    is applied via the same validator the settings UI uses. Several of those
 *    validators are silent per-key allowlists — `notification:settings-set`
 *    drops a sound file that doesn't exist on this machine, and
 *    `UserAgentRegistryService` refuses a built-in agent id — and they signal a
 *    rejection by simply not writing.
 * 2. **Therefore nothing is reported as applied until it has been read back.**
 *    Each `apply` re-reads through the section's own getter and compares against
 *    what was asked for. A resolved write proves nothing.
 *
 * The pre-import snapshot is the value returned by each section's `read()`, so
 * a section can never be applied without being snapshotted first. What leaves
 * the machine is that value passed through the section's `export()`, which
 * keeps only the fields `shared/config/portableSettings.ts` lets travel: a
 * snapshot restored from the exported projection would erase everything the
 * projection left out.
 */

/** The leaves one section's apply changed, in the shape an undo takes them back. */
export interface CapturedSection {
  section: ConfigBundleSectionId;
  leaves: UndoLeaf[];
}

export interface UndoSectionResult {
  section: ConfigBundleSectionId;
  leaves: UndoLeafResult[];
}

export interface ConfigBundleServiceDeps {
  /** Rebuilds the application menu after keybinding overrides change. */
  rebuildMenu: () => Promise<void>;
  /**
   * Repaints the Windows native caption strip after the theme changes. Writing
   * `appTheme` through the store alone leaves the strip in the previous theme's
   * colours until an OS appearance change reapplies them (#11766), which is why
   * the real theme setters call this on every write.
   */
  refreshTitleBar: () => Promise<void>;
  /** Which agent CLIs this machine has; null (or absent) before the first scan. */
  availability?: () => CliAvailability | null;
  /** Whether a custom agent's command resolves here. Assumed to when absent. */
  commandAvailable?: (command: string) => Promise<boolean>;
  /** The platform shortcuts are read for; this process's own by default. */
  platform?: NodeJS.Platform;
}

const PRESET_MISSING = "That preset isn't defined";
const CLI_MISSING = "Its CLI isn't installed, so it can't be used until it is";

/** "Keyboard shortcuts" → "keyboard shortcuts", for use mid-sentence. */
function sectionName(id: ConfigBundleSectionId): string {
  return CONFIG_BUNDLE_SECTION_LABELS[id].toLowerCase();
}

/** Settings-page wording, so the preview names a setting the way Settings does. */
const THEME_FIELD_LABELS: Record<string, string> = {
  colorSchemeId: "Color scheme",
  followSystem: "Match system appearance",
  preferredDarkSchemeId: "Dark theme",
  preferredLightSchemeId: "Light theme",
  colorVisionMode: "Color vision",
  accentColorOverride: "Accent color",
};

const AGENT_DEFAULT_FIELD_LABELS: Record<string, string> = {
  assistantAgentId: "Assistant agent",
  defaultAgent: "Default agent",
};

const NOTIFICATION_FIELD_LABELS: Record<string, string> = {
  enabled: "Notifications",
  completedEnabled: "Finished alerts",
  waitingEnabled: "Waiting alerts",
  soundEnabled: "Sounds",
  completedSoundFile: "Finished sound",
  waitingSoundFile: "Waiting sound",
  escalationSoundFile: "Escalation sound",
  waitingEscalationEnabled: "Waiting escalation",
  waitingEscalationDelayMs: "Escalation delay",
  workingPulseEnabled: "Working pulse",
  workingPulseSoundFile: "Working pulse sound",
  uiFeedbackSoundEnabled: "Interface sounds",
  flashEnabled: "All-clear flash",
  quietHoursEnabled: "Quiet hours",
  quietHoursStartMin: "Quiet hours start",
  quietHoursEndMin: "Quiet hours end",
  quietHoursWeekdays: "Quiet hours days",
  groupByContext: "Group by context",
};

/** Notification settings store minutes-since-midnight and millisecond delays; show them as time. */
function displayNotificationValue(key: string, value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key.endsWith("Min")) {
      const minutes = ((Math.floor(value) % 1440) + 1440) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    }
    if (key.endsWith("Ms")) {
      const seconds = Math.round(value / 1000);
      return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
    }
  }
  return displayScalar(value);
}

let defaultShortcutDescriptions: Map<string, string> | undefined;
function shortcutLabel(actionId: string): string {
  defaultShortcutDescriptions ??= new Map(
    buildDefaultKeybindings(process.platform === "win32", process.platform === "linux")
      .filter((b) => typeof b.description === "string" && b.description !== "")
      .map((b) => [b.actionId, b.description as string])
  );
  return defaultShortcutDescriptions.get(actionId) ?? actionId;
}

function schemeName(id: unknown, ...schemeLists: unknown[]): string | undefined {
  if (typeof id !== "string") return undefined;
  for (const list of schemeLists) {
    if (!Array.isArray(list)) continue;
    const match = list.find((s) => isRecord(s) && s.id === id);
    if (isRecord(match) && typeof match.name === "string") return match.name;
  }
  return BUILT_IN_APP_SCHEMES.find((s) => s.id === id)?.name ?? id;
}

function recordName(record: unknown, key: string): string | undefined {
  const entry = isRecord(record) ? record[key] : undefined;
  return isRecord(entry) && typeof entry.name === "string" && entry.name.trim() !== ""
    ? entry.name
    : undefined;
}

/**
 * Name one leaf the diff reported, so the confirmation can list what the
 * import replaces. Labels fall back to the raw key rather than dropping an
 * entry — an unnamed row is still better than a count that hides it.
 */
function describeLeaf(
  id: ConfigBundleSectionId,
  key: string,
  kind: "add" | "update",
  incoming: unknown,
  current: unknown,
  ctx: SectionContext
): ConfigBundlePreviewChange {
  const incomingRecord = isRecord(incoming) ? incoming : {};
  const currentRecord = isRecord(current) ? current : {};

  /**
   * A replacement is named by what the user has now, since that is what they
   * lose; the incoming name rides along only when the import changes it.
   */
  const named = (
    incomingName: string | undefined,
    currentName: string | undefined,
    suffix = ""
  ): ConfigBundlePreviewChange => {
    const label = (kind === "update" ? (currentName ?? incomingName) : incomingName) ?? key;
    const renamed =
      kind === "update" && currentName && incomingName && incomingName !== currentName
        ? { renamedTo: `${incomingName}${suffix}` }
        : {};
    return { key, kind, label: `${label}${suffix}`, ...renamed };
  };

  switch (id) {
    case "userAgentRegistry":
      return named(recordName(incomingRecord, key), recordName(currentRecord, key));
    case "agentSettings":
      return { key, kind, label: getEffectiveAgentConfig(key)?.name ?? key };
    case "agentDefaults": {
      const show = (value: unknown) =>
        value === null
          ? "None"
          : typeof value === "string"
            ? (getEffectiveAgentConfig(value)?.name ?? value)
            : undefined;
      return {
        key,
        kind,
        label: AGENT_DEFAULT_FIELD_LABELS[key] ?? humanizeKey(key),
        from: kind === "update" ? show(currentRecord[key]) : undefined,
        to: show(incomingRecord[key]),
      };
    }
    case "keybindingOverrides": {
      // Read the way the receiving machine reads it: Cmd is Ctrl off a Mac,
      // and Linux keeps some combinations clear for the desktop.
      const target = shortcutPlatform(ctx.platform);
      const combos = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((c): c is string => typeof c === "string" && c.trim() !== "")
          : [];
      const reading = readShortcutOn(key, combos(incomingRecord[key]), target);
      const before = combos(currentRecord[key])
        .map((combo) => comboAsReadOn(combo, target))
        .join(", ");
      return {
        key,
        kind,
        label: shortcutLabel(key),
        from: kind === "update" ? before || "No shortcut" : undefined,
        to: reading.readsAs || "No shortcut",
        ...(reading.note ? { note: reading.note } : {}),
      };
    }
    case "appTheme": {
      if (key.startsWith("theme:")) {
        const schemeId = key.slice("theme:".length);
        return named(
          schemeName(schemeId, incomingRecord.customSchemes),
          schemeName(schemeId, currentRecord.customSchemes),
          " (custom theme)"
        );
      }
      const isScheme = key.endsWith("SchemeId");
      const show = (value: unknown) =>
        isScheme
          ? schemeName(value, incomingRecord.customSchemes, currentRecord.customSchemes)
          : displayScalar(value);
      return {
        key,
        kind,
        label: THEME_FIELD_LABELS[key] ?? humanizeKey(key),
        from: kind === "update" ? show(currentRecord[key]) : undefined,
        to: show(incomingRecord[key]),
      };
    }
    case "notificationSettings":
      return {
        key,
        kind,
        label: NOTIFICATION_FIELD_LABELS[key] ?? humanizeKey(key),
        from: kind === "update" ? displayNotificationValue(key, currentRecord[key]) : undefined,
        to: displayNotificationValue(key, incomingRecord[key]),
      };
    case "worktreeConfig":
      return {
        key,
        kind,
        label: "Path pattern",
        from: kind === "update" ? displayScalar(currentRecord[key], Infinity) : undefined,
        to: displayScalar(incomingRecord[key], Infinity),
      };
    case "globalRecipes": {
      const nameIn = (list: unknown) => {
        const recipe = Array.isArray(list)
          ? list.find((r) => isRecord(r) && String(r.id) === key)
          : undefined;
        const name = isRecord(recipe) && typeof recipe.name === "string" ? recipe.name.trim() : "";
        return name || undefined;
      };
      return named(nameIn(incoming), nameIn(current));
    }
    default:
      return { key, kind, label: humanizeKey(key) };
  }
}

function refusedNotificationReason(key: string): string {
  return key.endsWith("SoundFile")
    ? "That sound file isn't available"
    : "Not a supported notification setting";
}

function recipeRefusal(recipe: Record<string, unknown>): string | null {
  if (typeof recipe.name !== "string" || !recipe.name.trim()) return "Recipe has no name";
  if (!Array.isArray(recipe.terminals)) return "Recipe has no terminals";
  return null;
}

export class ConfigBundleService {
  private readonly handlers: SectionHandler[];

  constructor(private readonly deps: ConfigBundleServiceDeps) {
    const availability = () => this.deps.availability?.() ?? null;
    this.handlers = [
      this.userAgentRegistrySection(),
      this.agentSettingsSection(),
      this.agentDefaultsSection(),
      permissionBypassSection(),
      assistantModelsSection(availability),
      this.keybindingOverridesSection(),
      this.appThemeSection(),
      this.notificationSettingsSection(),
      this.worktreeConfigSection(),
      this.globalRecipesSection(),
      hibernationSection(),
      sessionRestoreSection(),
      idleTerminalNotifySection(),
      idleBackgroundAutoCloseSection(),
      agentUpdateChecksSection(),
      pluginUpdateChecksSection(),
      globalEnvironmentSection(),
    ];
  }

  private handlerFor(id: ConfigBundleSectionId): SectionHandler | undefined {
    return this.handlers.find((h) => h.id === id);
  }

  private context(incoming: Partial<Record<ConfigBundleSectionId, unknown>>): SectionContext {
    return {
      incoming,
      availability: this.deps.availability?.() ?? null,
      platform: this.deps.platform ?? process.platform,
      commandAvailable: this.deps.commandAvailable ?? (async () => true),
    };
  }

  /**
   * The portable value of each section asked for (every one by default): only
   * the fields `portableSettings.ts` lets travel, before secret omission.
   */
  async collect(ids?: readonly ConfigBundleSectionId[]): Promise<ConfigBundleSections> {
    const sections: ConfigBundleSections = {};
    for (const id of CONFIG_BUNDLE_SECTION_IDS) {
      if (ids && !ids.includes(id)) continue;
      const handler = this.handlerFor(id);
      if (!handler) continue;
      const current = await handler.read();
      sections[id] = handler.export ? handler.export(current) : current;
    }
    return sections;
  }

  /**
   * A digest of everything the given sections could change, as it is now. A
   * preview made against one revision is only applied while it still holds,
   * so a setting changed in between is never written over unseen.
   */
  async revision(ids: readonly string[]): Promise<string> {
    const parts: Array<[ConfigBundleSectionId, unknown]> = [];
    for (const id of CONFIG_BUNDLE_SECTION_IDS) {
      if (!ids.includes(id)) continue;
      const handler = this.handlerFor(id);
      if (handler) parts.push([id, await handler.read()]);
    }
    return createHash("sha256").update(stableStringify(parts)).digest("hex");
  }

  /**
   * Per-section counts, the named leaves behind them, and the leaves this
   * machine would refuse with why, for the confirmation before anything is
   * written.
   */
  async preview(
    incoming: Partial<Record<ConfigBundleSectionId, unknown>>
  ): Promise<ConfigBundlePreviewSection[]> {
    const ctx = this.context(incoming);
    const previews: ConfigBundlePreviewSection[] = [];
    for (const id of CONFIG_BUNDLE_SECTION_IDS) {
      const payload = incoming[id];
      if (payload === undefined) continue;
      const handler = this.handlerFor(id);
      if (!handler) continue;
      const current = await handler.read();
      const diff = handler.diff(payload, current, ctx);
      const check: SectionCheck = handler.check
        ? await handler.check(payload, current, ctx)
        : emptyCheck();
      const describe = (key: string, kind: "add" | "update"): ConfigBundlePreviewChange => {
        const change = handler.describe
          ? handler.describe(key, kind, payload, current, ctx)
          : describeLeaf(id, key, kind, payload, current, ctx);
        const note = check.notes.get(key);
        return note && !change.note ? { ...change, note } : change;
      };
      const kept = (keys: string[]) => keys.filter((key) => !check.skipped.has(key));
      const update = kept(diff.update);
      const add = kept(diff.add);
      const skipped: ConfigBundlePreviewSkip[] = [...check.skipped].map(([key, reason]) => ({
        key,
        reason,
        label:
          check.labels?.get(key) ??
          (diff.add.includes(key) || diff.update.includes(key)
            ? describe(key, diff.add.includes(key) ? "add" : "update").label
            : key),
      }));
      previews.push({
        section: id,
        add: add.length,
        update: update.length,
        unchanged: kept(diff.unchanged).length,
        changes: [
          ...update.map((key) => describe(key, "update")),
          ...add.map((key) => describe(key, "add")),
        ],
        ...(skipped.length > 0 ? { skipped } : {}),
      });
    }
    return previews;
  }

  /**
   * Apply each present section, snapshotting first. A section that throws rolls
   * back everything already applied — a half-applied bundle across two stores is
   * worse than none at all.
   *
   * A section whose individual leaves were rejected by their own validator is
   * NOT a failure: those leaves are reported skipped and the import stands.
   */
  async apply(
    incoming: Partial<Record<ConfigBundleSectionId, unknown>>,
    options: { capture?: CapturedSection[] } = {}
  ): Promise<ConfigImportReport> {
    const snapshots: Array<{ handler: SectionHandler; snapshot: unknown }> = [];
    const sections: ConfigImportSectionReport[] = [];
    const errors: string[] = [];
    let rolledBack = false;

    for (const id of CONFIG_BUNDLE_SECTION_IDS) {
      const payload = incoming[id];
      const handler = this.handlerFor(id);
      if (!handler) continue;

      if (payload === undefined) {
        sections.push({
          section: id,
          present: false,
          applied: 0,
          unchanged: 0,
          skipped: 0,
          failed: 0,
          leaves: [],
          errors: [],
        });
        continue;
      }

      let current: unknown;
      try {
        current = await handler.read();
        // Snapshot before the first write of this section, never after.
        snapshots.push({ handler, snapshot: current });
        const leaves = await handler.apply(payload, current);
        if (options.capture) await this.capture(handler, current, leaves, options.capture);
        sections.push({
          section: id,
          present: true,
          applied: leaves.filter((l) => l.status === "applied").length,
          unchanged: leaves.filter((l) => l.status === "unchanged").length,
          skipped: leaves.filter((l) => l.status === "skipped").length,
          failed: leaves.filter((l) => l.status === "failed").length,
          leaves,
          errors: [],
        });
      } catch (error) {
        const reason = formatErrorMessage(error, "the section could not be applied");
        // The FAILING section is rolled back too: its snapshot is only pushed
        // once `read()` resolved, and every section can write more than once
        // before throwing, so excluding it would strand exactly the partial
        // writes this rollback exists to undo. A failure inside `read()` pushes
        // nothing, so the "nothing was changed" case is still reported honestly.
        const restorable = snapshots;
        const failedRestores = await this.rollback(restorable);
        rolledBack = restorable.length > 0 && failedRestores.length === 0;

        // These reach the import dialog verbatim, so sections are named the
        // way the dialog's own rows name them rather than by store key.
        const failure = `Couldn't import ${sectionName(id)}: ${reason}.`;
        if (failedRestores.length > 0) {
          // Saying "no changes were kept" here would be a claim we just watched
          // fail. Name the sections that are now in an unknown state instead.
          errors.push(
            `${failure} Undoing the earlier sections also failed, so ${failedRestores.map(sectionName).join(", ")} may be partly changed.`
          );
        } else if (restorable.length > 0) {
          errors.push(`${failure} No changes were kept.`);
        } else {
          errors.push(`${failure} Nothing was changed.`);
        }

        // Leaves recorded before the failure describe writes that have since
        // been undone, so they would misreport the final state.
        const settled = rolledBack
          ? sections.map((section) =>
              section.present
                ? { ...section, applied: 0, unchanged: 0, skipped: 0, failed: 0, leaves: [] }
                : section
            )
          : sections;

        return {
          outcome: "rolled-back",
          sections: settled,
          errors,
          rolledBack,
          restoreFailed: failedRestores.length > 0,
        };
      }
    }

    return { outcome: "applied", sections, errors, rolledBack };
  }

  /**
   * What each applied leaf held before and after, read back from the store
   * rather than taken from the payload, so an undo compares against what
   * actually landed. A leaf the read-back shows unchanged isn't kept.
   */
  private async capture(
    handler: SectionHandler,
    before: unknown,
    leaves: ConfigImportLeafResult[],
    into: CapturedSection[]
  ): Promise<void> {
    const applied = leaves.filter((leaf) => leaf.status === "applied");
    if (applied.length === 0) return;
    const after = await handler.read();
    const leafOf = handler.leafValue ?? recordLeafValue;
    const changed: UndoLeaf[] = [];
    for (const { key } of applied) {
      const was = leafOf(before, key);
      const now = leafOf(after, key);
      if (sameValue(was, now)) continue;
      changed.push({
        key,
        ...(was !== undefined ? { before: was } : {}),
        ...(now !== undefined ? { after: now } : {}),
      });
    }
    if (changed.length > 0) into.push({ section: handler.id, leaves: changed });
  }

  /**
   * Take a copy back, leaf by leaf, latest section first. A leaf still holding
   * what the copy wrote gets its earlier value back (or goes, if the copy added
   * it); one already back as it was is left; anything else was edited since and
   * stays as it is. Nothing outside the copy's leaves is written.
   */
  async undo(sections: readonly CapturedSection[]): Promise<UndoSectionResult[]> {
    const order = (id: ConfigBundleSectionId) => CONFIG_BUNDLE_SECTION_IDS.indexOf(id);
    const results: UndoSectionResult[] = [];
    for (const { section, leaves } of [...sections].sort(
      (a, b) => order(b.section) - order(a.section)
    )) {
      const handler = this.handlerFor(section);
      if (!handler) {
        results.push({ section, leaves: leaves.map(({ key }) => ({ key, status: "failed" })) });
        continue;
      }
      try {
        results.push({
          section,
          leaves: handler.undo
            ? await handler.undo(leaves)
            : await this.undoLeaves(handler, leaves),
        });
      } catch (error) {
        console.error(`[ConfigBundleService] Failed to undo ${section}:`, error);
        results.push({ section, leaves: leaves.map(({ key }) => ({ key, status: "failed" })) });
      }
    }
    return results;
  }

  private async undoLeaves(handler: SectionHandler, leaves: UndoLeaf[]): Promise<UndoLeafResult[]> {
    const leafOf = handler.leafValue ?? recordLeafValue;
    const plan = planUndo(leaves, await handler.read(), leafOf, handler.withLeaf);
    if (plan.pending.length === 0) return settleUndo(leaves, plan, undefined, leafOf);
    // `restore` writes the section as a whole, but from the current value
    // with only these leaves swapped, so everything else is written back as
    // it already is.
    await handler.restore(plan.next);
    return settleUndo(leaves, plan, await handler.read(), leafOf);
  }

  /**
   * Restore in reverse order so later sections unwind before earlier ones.
   * Returns the ids that could not be restored — a failed restore is exactly
   * the case the caller must not describe as "nothing changed".
   */
  private async rollback(
    snapshots: Array<{ handler: SectionHandler; snapshot: unknown }>
  ): Promise<ConfigBundleSectionId[]> {
    const failed: ConfigBundleSectionId[] = [];
    for (const { handler, snapshot } of [...snapshots].reverse()) {
      try {
        await handler.restore(snapshot);
      } catch (error) {
        console.error(`[ConfigBundleService] Failed to roll back ${handler.id}:`, error);
        failed.push(handler.id);
      }
    }
    return failed;
  }

  // --- Sections ---

  private userAgentRegistrySection(): SectionHandler {
    /**
     * An update lays the incoming fields over the target's definition rather
     * than replacing it: a field withheld at the source (an `args` list that
     * held a secret) is absent, and must leave the target's own alone.
     */
    const merged = (incoming: unknown, existing: unknown): unknown =>
      isRecord(incoming) && isRecord(existing) ? { ...existing, ...incoming } : incoming;

    return {
      id: "userAgentRegistry",
      read: async () => loadSanitizedUserAgentRegistry(),
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        if (!isRecord(incoming)) return result;
        const currentRecord = isRecord(current) ? current : {};
        for (const [id, config] of Object.entries(incoming)) {
          const existing = currentRecord[id];
          if (existing === undefined) result.add.push(id);
          else if (sameValue(merged(config, existing), existing)) result.unchanged.push(id);
          else result.update.push(id);
        }
        return result;
      },
      check: async (incoming, current, ctx) => {
        const check = emptyCheck();
        if (!isRecord(incoming)) return check;
        const currentRecord = isRecord(current) ? current : {};
        for (const [id, incomingConfig] of Object.entries(incoming)) {
          const config = merged(incomingConfig, currentRecord[id]);
          if (sameValue(config, currentRecord[id])) continue;
          const parsed = UserAgentConfigSchema.safeParse(config);
          if (!parsed.success) {
            check.skipped.set(id, "Agent definition is not valid");
          } else if (parsed.data.id !== id) {
            check.skipped.set(id, `Agent id doesn't match its key (${parsed.data.id})`);
          } else if (isBuiltInAgent(id)) {
            check.skipped.set(id, "Uses the id of a built-in agent");
          } else if (
            !SAFE_AGENT_ID_PATTERN.test(id) ||
            !SAFE_AGENT_ID_PATTERN.test(parsed.data.command)
          ) {
            check.skipped.set(id, "Its id or command has characters Daintree doesn't allow");
          } else {
            // Copied anyway: the definition is still worth having, and a
            // custom agent is never made a default by this.
            const known = ctx.availability?.[id];
            const installed =
              known !== undefined
                ? isAgentInstalled(known)
                : await ctx.commandAvailable(parsed.data.command);
            if (!installed) check.notes.set(id, CLI_MISSING);
          }
        }
        return check;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};
        const service = new UserAgentRegistryService();

        for (const [id, incomingConfig] of Object.entries(incoming)) {
          const config = merged(incomingConfig, currentRecord[id]);
          if (sameValue(config, currentRecord[id])) {
            results.push(unchangedLeaf(id));
            continue;
          }

          const parsed = UserAgentConfigSchema.safeParse(config);
          if (!parsed.success) {
            results.push(skippedLeaf(id, "Agent definition is not valid"));
            continue;
          }
          if (parsed.data.id !== id) {
            results.push(skippedLeaf(id, `Agent id doesn't match its key (${parsed.data.id})`));
            continue;
          }

          // addAgent refuses built-in ids and unsafe commands; updateAgent
          // refuses an id change. Let them decide rather than pre-judging here.
          const existing = service.getAgent(id);
          const outcome = existing
            ? service.updateAgent(id, parsed.data as UserAgentConfig)
            : service.addAgent(parsed.data as UserAgentConfig);

          if (!outcome.success) {
            results.push(skippedLeaf(id, outcome.error ?? "Rejected by the agent registry"));
            continue;
          }

          const readBack = service.getAgent(id);
          results.push(
            sameValue(readBack, parsed.data)
              ? { key: id, status: "applied" }
              : skippedLeaf(id, "Value did not persist")
          );
        }
        return results;
      },
      restore: async (snapshot) => {
        store.set("userAgentRegistry", snapshot as Record<string, UserAgentConfig>);
        new UserAgentRegistryService().reload();
      },
    };
  }

  private agentSettingsSection(): SectionHandler {
    // Field level, both ways (#13346): only the fields `portableSettings.ts`
    // names leave, and an incoming entry is merged into the target's field by
    // field, its env maps per name and its presets per id. Bypass travels in
    // its own opt-in section; the root-level `globalUseAltScreen` doesn't
    // travel at all, since this payload is the per-agent record.
    const readAgents = (): Record<string, unknown> => {
      const settings = store.get("agentSettings");
      return isRecord(settings) && isRecord(settings.agents) ? settings.agents : {};
    };

    /**
     * The entry the target ends up with. A default preset the target doesn't
     * define (built in, already custom there, or arriving in this same entry)
     * is left as the target has it rather than pointed at nothing.
     */
    const resolve = (agentId: string, currentEntry: unknown, entry: Record<string, unknown>) => {
      const merged = mergeAgentEntry(currentEntry, entry);
      const wanted =
        typeof entry.presetId === "string" && entry.presetId !== "" ? entry.presetId : undefined;
      const known =
        wanted === undefined ||
        customPresetIds(merged).includes(wanted) ||
        getAgentPreset(agentId, wanted) !== undefined;
      return known
        ? { merged, presetSkipped: false }
        : { merged: mergeAgentEntry(currentEntry, entry, false), presetSkipped: true };
    };
    const presetKey = (agentId: string) => `${agentId}.presetId`;
    const NOTHING_PORTABLE = "Nothing in it can be copied";

    return {
      id: "agentSettings",
      read: async () => readAgents(),
      export: (current) => projectAgents(current),
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        if (!isRecord(incoming)) return result;
        const currentRecord = isRecord(current) ? current : {};
        for (const [agentId, entry] of Object.entries(incoming)) {
          const existing = currentRecord[agentId];
          if (!isRecord(entry)) result.update.push(agentId);
          else if (!isRecord(existing)) result.add.push(agentId);
          else if (
            sameValue(resolve(agentId, existing, entry).merged, mergeAgentEntry(existing, {}))
          ) {
            result.unchanged.push(agentId);
          } else result.update.push(agentId);
        }
        return result;
      },
      check: async (incoming, current, ctx) => {
        const check: SectionCheck = { ...emptyCheck(), labels: new Map() };
        if (!isRecord(incoming)) return check;
        const currentRecord = isRecord(current) ? current : {};
        for (const [agentId, entry] of Object.entries(incoming)) {
          const name = getEffectiveAgentConfig(agentId)?.name ?? agentId;
          if (!isRecord(entry)) {
            check.skipped.set(agentId, "Agent settings entry is not an object");
            continue;
          }
          if (projectAgentEntry(entry) === undefined) {
            check.skipped.set(agentId, NOTHING_PORTABLE);
            continue;
          }
          const { presetSkipped } = resolve(agentId, currentRecord[agentId], entry);
          // A custom agent arriving in the same copy brings its own presets.
          const incomingAgent = isRecord(ctx.incoming.userAgentRegistry)
            ? ctx.incoming.userAgentRegistry[agentId]
            : undefined;
          const arriving =
            isRecord(incomingAgent) && Array.isArray(incomingAgent.presets)
              ? incomingAgent.presets.some((p) => isRecord(p) && p.id === entry.presetId)
              : false;
          if (presetSkipped && !arriving) {
            check.skipped.set(presetKey(agentId), PRESET_MISSING);
            check.labels?.set(presetKey(agentId), `${name} default preset`);
          }
          if (
            isBuiltInAgent(agentId) &&
            ctx.availability &&
            !isAgentInstalled(ctx.availability[agentId])
          ) {
            check.notes.set(agentId, CLI_MISSING);
          }
        }
        return check;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

        const next: Record<string, unknown> = { ...currentRecord };
        const pending: string[] = [];

        for (const [agentId, entry] of Object.entries(incoming)) {
          if (!isRecord(entry)) {
            results.push(skippedLeaf(agentId, "Agent settings entry is not an object"));
            continue;
          }
          if (projectAgentEntry(entry) === undefined) {
            results.push(skippedLeaf(agentId, NOTHING_PORTABLE));
            continue;
          }
          const existing = currentRecord[agentId];
          const { merged, presetSkipped } = resolve(agentId, existing, entry);
          if (presetSkipped) results.push(skippedLeaf(presetKey(agentId), PRESET_MISSING));
          if (sameValue(merged, mergeAgentEntry(existing, {}))) {
            results.push(unchangedLeaf(agentId));
            continue;
          }
          next[agentId] = merged;
          pending.push(agentId);
        }

        if (pending.length > 0) {
          store.set("agentSettings.agents", next);
        }

        const readBack = readAgents();
        for (const agentId of pending) {
          results.push(
            sameValue(readBack[agentId], next[agentId])
              ? { key: agentId, status: "applied" }
              : skippedLeaf(agentId, "Value did not persist")
          );
        }
        return results;
      },
      restore: async (snapshot) => {
        store.set("agentSettings.agents", (snapshot ?? {}) as Record<string, unknown>);
      },
    };
  }

  private agentDefaultsSection(): SectionHandler {
    // Only leaves the host actually has travel, so exporting from a host that
    // never chose a default can't turn into a clear on the machine importing it.
    const isKnownLeaf = (key: string): key is keyof AgentDefaultsPatch =>
      key === "assistantAgentId" || key === "defaultAgent";
    const isStorable = (key: keyof AgentDefaultsPatch, value: unknown) =>
      value === null ||
      (key === "assistantAgentId"
        ? isStorableAssistantAgentId(value)
        : isStorableDefaultAgent(value));

    return {
      id: "agentDefaults",
      read: async () => readAgentDefaults(),
      diff: (incoming, current) => {
        const known = isRecord(incoming)
          ? Object.fromEntries(Object.entries(incoming).filter(([key]) => isKnownLeaf(key)))
          : incoming;
        return diffRecord(known, current);
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

        const patch: AgentDefaultsPatch = {};
        const pending: Array<keyof AgentDefaultsPatch> = [];
        for (const [key, value] of Object.entries(incoming)) {
          if (!isKnownLeaf(key)) {
            results.push(skippedLeaf(key, "Not a supported default agent setting"));
            continue;
          }
          if (!isStorable(key, value)) {
            results.push(skippedLeaf(key, "Not a valid agent"));
            continue;
          }
          if (Object.hasOwn(currentRecord, key) && sameValue(value, currentRecord[key])) {
            results.push(unchangedLeaf(key));
            continue;
          }
          (patch as Record<string, unknown>)[key] = value;
          pending.push(key);
        }

        if (pending.length > 0) setAgentDefaults(patch);

        const readBack = readAgentDefaults();
        for (const key of pending) {
          results.push(
            Object.hasOwn(readBack, key) && sameValue(readBack[key], patch[key])
              ? { key, status: "applied" }
              : skippedLeaf(key, "Value did not persist")
          );
        }
        return results;
      },
      restore: async (snapshot) => {
        restoreAgentDefaults(isRecord(snapshot) ? (snapshot as AgentDefaultsPatch) : {});
      },
    };
  }

  private keybindingOverridesSection(): SectionHandler {
    return {
      id: "keybindingOverrides",
      read: async () => getValidatedOverrides(),
      diff: diffRecord,
      check: async (incoming) => {
        const check = emptyCheck();
        if (!isRecord(incoming)) return check;
        for (const [actionId, combos] of Object.entries(incoming)) {
          if (!Array.isArray(combos) || combos.some((c) => typeof c !== "string")) {
            check.skipped.set(actionId, "Shortcut list is not an array of strings");
          }
        }
        return check;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

        const merged: Record<string, string[]> = { ...(currentRecord as Record<string, string[]>) };
        const pending: string[] = [];

        for (const [actionId, combos] of Object.entries(incoming)) {
          if (actionId.trim() === "") continue;
          if (!Array.isArray(combos) || combos.some((c) => typeof c !== "string")) {
            results.push(skippedLeaf(actionId, "Shortcut list is not an array of strings"));
            continue;
          }
          const cleaned = (combos as string[]).filter((c) => c.trim() !== "");
          if (sameValue(cleaned, currentRecord[actionId])) {
            results.push(unchangedLeaf(actionId));
            continue;
          }
          merged[actionId] = cleaned;
          pending.push(actionId);
        }

        if (pending.length > 0) {
          store.set("keybindingOverrides.overrides", merged);
          await this.deps.rebuildMenu();
        }

        // getValidatedOverrides re-validates against the live action list, so an
        // override for an action this build no longer has is dropped here.
        const readBack = getValidatedOverrides();
        for (const actionId of pending) {
          results.push(
            sameValue(readBack[actionId], merged[actionId])
              ? { key: actionId, status: "applied" }
              : skippedLeaf(actionId, "Not a known action in this version")
          );
        }
        return results;
      },
      // On the stored map, not `read()`: that drops overrides for actions this
      // build doesn't have registered right now (a plugin's), and writing it
      // back would lose them.
      undo: async (leaves) => {
        const plan = planUndo(leaves, store.get("keybindingOverrides.overrides") ?? {});
        if (plan.pending.length > 0) {
          store.set("keybindingOverrides.overrides", plan.next as Record<string, string[]>);
          await this.deps.rebuildMenu();
        }
        return settleUndo(leaves, plan, store.get("keybindingOverrides.overrides"));
      },
      restore: async (snapshot) => {
        store.set("keybindingOverrides.overrides", (snapshot ?? {}) as Record<string, string[]>);
        await this.deps.rebuildMenu();
      },
    };
  }

  private appThemeSection(): SectionHandler {
    const SCALAR_FIELDS = [
      "colorSchemeId",
      "followSystem",
      "preferredDarkSchemeId",
      "preferredLightSchemeId",
      "colorVisionMode",
      "accentColorOverride",
    ] as const;

    const VALID_COLOR_VISION_MODES = new Set(["default", "red-green", "blue-yellow"]);

    const readTheme = (): Record<string, unknown> => {
      const config = store.get("appTheme");
      return isRecord(config) ? config : {};
    };

    const validateScalar = (field: string, value: unknown): string | null => {
      switch (field) {
        case "colorSchemeId":
        case "preferredDarkSchemeId":
        case "preferredLightSchemeId":
          return typeof value === "string" && value.trim() !== "" ? null : "Not a valid theme id";
        case "followSystem":
          return typeof value === "boolean" ? null : "Not a boolean";
        case "colorVisionMode":
          return typeof value === "string" && VALID_COLOR_VISION_MODES.has(value)
            ? null
            : "Not a supported colour-vision mode";
        case "accentColorOverride":
          return value === null || (typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value))
            ? null
            : "Not a valid accent colour";
        default:
          return "Unsupported field";
      }
    };

    return {
      id: "appTheme",
      read: async () => {
        const theme = readTheme();
        const portable: Record<string, unknown> = {};
        for (const field of SCALAR_FIELDS) {
          if (theme[field] !== undefined) portable[field] = theme[field];
        }
        // `recentSchemeIds` is deliberately absent — it is an MRU of this
        // machine's browsing, not a preference worth carrying.
        if (Array.isArray(theme.customSchemes)) portable.customSchemes = theme.customSchemes;
        return portable;
      },
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        if (!isRecord(incoming)) return result;
        const currentRecord = isRecord(current) ? current : {};

        for (const field of SCALAR_FIELDS) {
          if (incoming[field] === undefined) continue;
          if (currentRecord[field] === undefined) result.add.push(field);
          else if (sameValue(incoming[field], currentRecord[field])) result.unchanged.push(field);
          else result.update.push(field);
        }

        if (Array.isArray(incoming.customSchemes)) {
          const currentById = new Map(
            (Array.isArray(currentRecord.customSchemes) ? currentRecord.customSchemes : [])
              .filter(isRecord)
              .map((s) => [String(s.id), s])
          );
          for (const scheme of incoming.customSchemes) {
            if (!isRecord(scheme)) continue;
            const key = `theme:${String(scheme.id)}`;
            const existing = currentById.get(String(scheme.id));
            if (!existing) result.add.push(key);
            else if (sameValue(scheme, existing)) result.unchanged.push(key);
            else result.update.push(key);
          }
        }
        return result;
      },
      check: async (incoming, current) => {
        const check = emptyCheck();
        if (!isRecord(incoming)) return check;
        const currentRecord = isRecord(current) ? current : {};
        if (Array.isArray(incoming.customSchemes)) {
          const currentById = new Map(
            (Array.isArray(currentRecord.customSchemes) ? currentRecord.customSchemes : [])
              .filter(isRecord)
              .map((s) => [String(s.id), s])
          );
          for (const scheme of incoming.customSchemes.filter(isRecord)) {
            const id = String(scheme.id);
            if (sameValue(scheme, currentById.get(id))) continue;
            if (!appCustomSchemesWriteSchema.safeParse([scheme]).success) {
              check.skipped.set(`theme:${id}`, "Theme definition is not valid");
            }
          }
        }
        for (const field of SCALAR_FIELDS) {
          const value = incoming[field];
          if (value === undefined || sameValue(value, currentRecord[field])) continue;
          const invalid = validateScalar(field, value);
          if (invalid) check.skipped.set(field, invalid);
        }
        return check;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};
        let wrote = false;

        // Custom schemes first: a colorSchemeId pointing at an imported scheme
        // only resolves once that scheme exists.
        if (incoming.customSchemes !== undefined) {
          const incomingSchemes = Array.isArray(incoming.customSchemes)
            ? incoming.customSchemes.filter(isRecord)
            : [];
          const currentSchemes = Array.isArray(currentRecord.customSchemes)
            ? (currentRecord.customSchemes as unknown[]).filter(isRecord)
            : [];

          const mergedById = new Map(currentSchemes.map((s) => [String(s.id), s]));
          // Validate each incoming scheme on its own BEFORE it can displace the
          // existing entry. Merging first and filtering the merged array
          // afterwards would delete the user's existing scheme whenever the
          // imported one under the same id turned out to be invalid — and would
          // drop any unrelated pre-existing scheme that no longer validates.
          const pending = new Map<string, Record<string, unknown>>();
          for (const scheme of incomingSchemes) {
            const id = String(scheme.id);
            if (sameValue(scheme, mergedById.get(id))) {
              results.push(unchangedLeaf(`theme:${id}`));
              continue;
            }
            if (!appCustomSchemesWriteSchema.safeParse([scheme]).success) {
              results.push(skippedLeaf(`theme:${id}`, "Theme definition is not valid"));
              continue;
            }
            // Last one wins if the bundle repeats an id, so each id reports once.
            mergedById.set(id, scheme);
            pending.set(id, scheme);
          }

          if (pending.size > 0) {
            // Existing schemes are carried through untouched rather than
            // re-parsed, so a forward-compatible field written by a newer build
            // isn't stripped off a scheme this import never mentioned.
            store.set("appTheme.customSchemes", [...mergedById.values()] as never);
            wrote = true;

            const persisted = readTheme().customSchemes;
            const readBackById = new Map(
              (Array.isArray(persisted) ? (persisted as unknown[]) : [])
                .filter(isRecord)
                .map((s) => [String(s.id), s] as const)
            );
            for (const [id, scheme] of pending) {
              results.push(
                sameValue(readBackById.get(id), scheme)
                  ? { key: `theme:${id}`, status: "applied" }
                  : skippedLeaf(`theme:${id}`, "Value did not persist")
              );
            }
          }
        }

        for (const field of SCALAR_FIELDS) {
          const value = incoming[field];
          if (value === undefined) continue;
          if (sameValue(value, currentRecord[field])) {
            results.push(unchangedLeaf(field));
            continue;
          }
          const invalid = validateScalar(field, value);
          if (invalid) {
            results.push(skippedLeaf(field, invalid));
            continue;
          }
          const normalized =
            typeof value === "string" && field !== "accentColorOverride" ? value.trim() : value;
          store.set(`appTheme.${field}` as never, normalized as never);
          wrote = true;
          results.push(
            sameValue(readTheme()[field], normalized)
              ? { key: field, status: "applied" }
              : skippedLeaf(field, "Value did not persist")
          );
        }

        // Same follow-up the real theme setters make after their own store.set.
        if (wrote) await this.deps.refreshTitleBar();

        return results;
      },
      leafValue: (value, key) =>
        key.startsWith("theme:")
          ? listLeafValue(isRecord(value) ? value.customSchemes : undefined, key.slice(6))
          : recordLeafValue(value, key),
      withLeaf: (value, key, leaf) => {
        if (!key.startsWith("theme:")) return withRecordLeaf(value, key, leaf);
        const record = isRecord(value) ? value : {};
        return { ...record, customSchemes: withListLeaf(record.customSchemes, key.slice(6), leaf) };
      },
      restore: async (snapshot) => {
        const theme = readTheme();
        const snapshotRecord = isRecord(snapshot) ? snapshot : {};
        // Restore only the portable keys — `recentSchemeIds` and anything else
        // this feature never touched must survive the rollback untouched.
        const next: Record<string, unknown> = { ...theme };
        for (const field of [...SCALAR_FIELDS, "customSchemes"] as const) {
          if (snapshotRecord[field] === undefined) delete next[field];
          else next[field] = snapshotRecord[field];
        }
        store.set("appTheme", next as never);
        // A rollback that left the caption strip on the imported theme would be
        // the same stale-strip bug, just reached from the other direction.
        await this.deps.refreshTitleBar();
      },
    };
  }

  private notificationSettingsSection(): SectionHandler {
    const readSettings = (): Record<string, unknown> => {
      const settings = store.get("notificationSettings");
      return isRecord(settings) ? settings : {};
    };

    return {
      id: "notificationSettings",
      read: async () => readSettings(),
      diff: diffRecord,
      check: async (incoming) => {
        const check = emptyCheck();
        if (!isRecord(incoming)) return check;
        const sanitized = sanitizeNotificationSettingsPatch(
          incoming,
          await getAllowedSoundFiles()
        ) as Record<string, unknown>;
        for (const key of Object.keys(incoming)) {
          if (!Object.prototype.hasOwnProperty.call(sanitized, key)) {
            check.skipped.set(key, refusedNotificationReason(key));
          }
        }
        return check;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

        // Normalize BEFORE comparing, not after. The sanitizer clamps
        // (a 1ms escalation delay becomes 30s, a fractional quiet-hour minute is
        // floored), so comparing the raw request against the stored value would
        // report a difference that no write can ever close — the same bundle
        // would show a pending change on every future import.
        const sanitized = sanitizeNotificationSettingsPatch(
          incoming,
          await getAllowedSoundFiles()
        ) as Record<string, unknown>;

        const pending: string[] = [];
        for (const key of Object.keys(incoming)) {
          // `in` would walk the prototype chain, so a section key like
          // `toString` or `__proto__` (an own property once JSON.parse made it)
          // would pass this gate and then be misreported as "unchanged".
          if (!Object.prototype.hasOwnProperty.call(sanitized, key)) {
            results.push(skippedLeaf(key, refusedNotificationReason(key)));
            continue;
          }
          if (sameValue(sanitized[key], currentRecord[key])) {
            results.push(unchangedLeaf(key));
            continue;
          }
          pending.push(key);
        }

        for (const key of pending) {
          store.set(`notificationSettings.${key}` as never, sanitized[key] as never);
        }

        const readBack = readSettings();
        for (const key of pending) {
          results.push(
            sameValue(readBack[key], sanitized[key])
              ? { key, status: "applied" }
              : skippedLeaf(key, "Value did not persist")
          );
        }
        return results;
      },
      restore: async (snapshot) => {
        store.set("notificationSettings", (snapshot ?? {}) as never);
      },
    };
  }

  private worktreeConfigSection(): SectionHandler {
    const readPattern = (): string => {
      const raw = store.get("worktreeConfig");
      return isRecord(raw) && typeof raw.pathPattern === "string" && raw.pathPattern.trim()
        ? raw.pathPattern
        : DEFAULT_WORKTREE_PATH_PATTERN;
    };

    return {
      id: "worktreeConfig",
      read: async () => ({ pathPattern: readPattern() }),
      check: async (incoming, current) => {
        const check = emptyCheck();
        if (!isRecord(incoming) || incoming.pathPattern === undefined) return check;
        if (typeof incoming.pathPattern !== "string") {
          check.skipped.set("pathPattern", "Path pattern is not a string");
          return check;
        }
        if (isRecord(current) && incoming.pathPattern === current.pathPattern) return check;
        const validation = validatePathPattern(incoming.pathPattern.trim());
        if (!validation.valid) {
          check.skipped.set("pathPattern", validation.error ?? "Path pattern is not valid");
        }
        return check;
      },
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        if (!isRecord(incoming) || typeof incoming.pathPattern !== "string") return result;
        const currentPattern = isRecord(current) ? current.pathPattern : undefined;
        if (incoming.pathPattern === currentPattern) result.unchanged.push("pathPattern");
        else result.update.push("pathPattern");
        return result;
      },
      apply: async (incoming, current) => {
        if (!isRecord(incoming)) return [];
        const { pathPattern } = incoming;
        if (typeof pathPattern !== "string") {
          return [skippedLeaf("pathPattern", "Path pattern is not a string")];
        }
        const currentPattern = isRecord(current) ? current.pathPattern : undefined;
        if (pathPattern === currentPattern) return [unchangedLeaf("pathPattern")];

        const trimmed = pathPattern.trim();
        const validation = validatePathPattern(trimmed);
        if (!validation.valid) {
          return [skippedLeaf("pathPattern", validation.error ?? "Path pattern is not valid")];
        }

        store.set("worktreeConfig.pathPattern", trimmed);
        return [
          readPattern() === trimmed
            ? { key: "pathPattern", status: "applied" }
            : skippedLeaf("pathPattern", "Value did not persist"),
        ];
      },
      restore: async (snapshot) => {
        const pattern =
          isRecord(snapshot) && typeof snapshot.pathPattern === "string"
            ? snapshot.pathPattern
            : DEFAULT_WORKTREE_PATH_PATTERN;
        store.set("worktreeConfig.pathPattern", pattern);
      },
    };
  }

  private globalRecipesSection(): SectionHandler {
    const byId = (recipes: unknown): Map<string, Record<string, unknown>> => {
      const list = Array.isArray(recipes) ? recipes.filter(isRecord) : [];
      return new Map(list.map((r) => [String(r.id), r]));
    };

    /**
     * An existing recipe as the update leaves it. Terminals have no ids, so
     * each merges with the target's terminal at the same position: a field
     * the incoming one carries wins, its env merges per name, and a field it
     * lacks (withheld at the source as a secret, a command holding a token)
     * keeps the target's own value rather than being erased.
     */
    const merged = (
      recipe: Record<string, unknown>,
      existing: Record<string, unknown> | undefined
    ): Record<string, unknown> => {
      if (!existing) return recipe;
      const next: Record<string, unknown> = { ...existing, ...recipe };
      if (Array.isArray(recipe.terminals) && Array.isArray(existing.terminals)) {
        const before = existing.terminals as unknown[];
        next.terminals = recipe.terminals.map((terminal, index) => {
          const prior = before[index];
          if (!isRecord(terminal) || !isRecord(prior)) return terminal;
          const next: Record<string, unknown> = { ...prior, ...terminal };
          if (isRecord(prior.env)) next.env = mergeEnv(prior.env, terminal.env);
          return next;
        });
      }
      return next;
    };

    return {
      id: "globalRecipes",
      read: async () => projectStore.getGlobalRecipes(),
      check: async (incoming, current) => {
        const check = emptyCheck();
        const currentById = byId(current);
        for (const [id, recipe] of byId(incoming)) {
          const existing = currentById.get(id);
          if (existing && sameValue(merged(recipe, existing), existing)) continue;
          const reason = recipeRefusal(recipe);
          if (reason) check.skipped.set(id, reason);
        }
        return check;
      },
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        const currentById = byId(current);
        for (const [id, recipe] of byId(incoming)) {
          const existing = currentById.get(id);
          if (!existing) result.add.push(id);
          else if (sameValue(merged(recipe, existing), existing)) result.unchanged.push(id);
          else result.update.push(id);
        }
        return result;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        const currentById = byId(current);
        const pending = new Map<string, Record<string, unknown>>();

        for (const [id, recipe] of byId(incoming)) {
          const existing = currentById.get(id);
          const next = merged(recipe, existing);
          if (existing && sameValue(next, existing)) {
            results.push(unchangedLeaf(id));
            continue;
          }
          const refusal = recipeRefusal(recipe);
          if (refusal) {
            results.push(skippedLeaf(id, refusal));
            continue;
          }

          if (existing) {
            // id/projectId/createdAt are owned by the target store — merging by
            // id is what makes a repeat import a no-op instead of a duplicate.
            const { id: _id, projectId: _projectId, createdAt: _createdAt, ...updates } = recipe;
            if (next.terminals !== undefined) updates.terminals = next.terminals;
            await projectStore.updateGlobalRecipe(id, updates as Partial<TerminalRecipe>);
          } else {
            await projectStore.addGlobalRecipe({
              ...(recipe as unknown as TerminalRecipe),
              projectId: undefined,
              createdAt: typeof recipe.createdAt === "number" ? recipe.createdAt : Date.now(),
            });
          }
          pending.set(id, next);
        }

        if (pending.size === 0) return results;

        const incomingById = byId(incoming);
        const readBackById = byId(await projectStore.getGlobalRecipes());
        for (const [id, next] of pending) {
          const stored = readBackById.get(id);
          if (!stored) {
            results.push(skippedLeaf(id, "Recipe did not persist"));
            continue;
          }
          // Compare the fields the bundle actually asked for, as the merge
          // wrote them. Checking only that the id exists would report a recipe
          // as applied even when the store stripped half of it on the way in.
          // `createdAt`/`projectId` are the target store's to own, so they are
          // excluded from the comparison.
          const requested = incomingById.get(id) ?? {};
          const mismatched = Object.keys(requested).filter(
            (key) =>
              key !== "createdAt" && key !== "projectId" && !sameValue(next[key], stored[key])
          );
          results.push(
            mismatched.length === 0
              ? { key: id, status: "applied" }
              : skippedLeaf(id, `Stored without ${mismatched.join(", ")}`)
          );
        }
        return results;
      },
      leafValue: listLeafValue,
      // Not `restore`: it deletes and re-adds, and the undo must leave every
      // recipe it isn't taking back exactly where and as it is. Compared and
      // written in one turn of the recipe queue, so an edit can't land between.
      undo: async (leaves) => {
        let plan: UndoPlan | undefined;
        await projectStore.transformGlobalRecipes((recipes) => {
          plan = planUndo(leaves, recipes, listLeafValue, withListLeaf);
          return plan.pending.length > 0 ? (plan.next as TerminalRecipe[]) : null;
        });
        if (!plan) throw new Error("The recipe store did not run the undo");
        return settleUndo(
          leaves,
          plan,
          plan.pending.length > 0 ? await projectStore.getGlobalRecipes() : undefined,
          listLeafValue
        );
      },
      restore: async (snapshot) => {
        const snapshotById = byId(snapshot);
        const liveById = byId(await projectStore.getGlobalRecipes());

        for (const [id, recipe] of snapshotById) {
          // Delete-then-add rather than update: `updateGlobalRecipe` merges a
          // partial, so a field the import ADDED to a recipe that never had it
          // would survive the "restore" — leaving the rollback incomplete.
          // Replacing the record outright is the only exact inverse available.
          if (liveById.has(id)) await projectStore.deleteGlobalRecipe(id);
          await projectStore.addGlobalRecipe(recipe as unknown as TerminalRecipe);
        }
        for (const id of liveById.keys()) {
          if (!snapshotById.has(id)) await projectStore.deleteGlobalRecipe(id);
        }
      },
    };
  }
}
