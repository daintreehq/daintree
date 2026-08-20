// eager-import-allow: reads portable config via store.get synchronously while building a bundle
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
import { UserAgentConfigSchema } from "../../shared/types/index.js";
import type { TerminalRecipe, UserAgentConfig } from "../../shared/types/index.js";
import {
  validatePathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "../../shared/utils/pathPattern.js";
import {
  CONFIG_BUNDLE_SECTION_IDS,
  type ConfigBundlePreviewSection,
  type ConfigBundleSectionId,
  type ConfigImportLeafResult,
  type ConfigImportReport,
  type ConfigImportSectionReport,
} from "../../shared/types/configBundle.js";
import type { ConfigBundleSections } from "../utils/configBundleIO.js";

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
 * The pre-import snapshot is the value returned by each section's `read()` —
 * the same function the exporter uses — so a section can never be applied
 * without being snapshotted first.
 */

export interface ConfigBundleServiceDeps {
  /** Rebuilds the application menu after keybinding overrides change. */
  rebuildMenu: () => Promise<void>;
}

interface SectionDiff {
  add: string[];
  update: string[];
  unchanged: string[];
}

interface SectionHandler {
  id: ConfigBundleSectionId;
  /** Current portable value. Doubles as the exporter payload and the snapshot. */
  read: () => Promise<unknown>;
  /** Compare an incoming payload against the current value, per leaf. */
  diff: (incoming: unknown, current: unknown) => SectionDiff;
  /** Write + read back. Returns one result per requested leaf. */
  apply: (incoming: unknown, current: unknown) => Promise<ConfigImportLeafResult[]>;
  /** Put the snapshot back after a failed import. */
  restore: (snapshot: unknown) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural equality via canonical JSON — sufficient for config leaves. */
function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Diff a keyed record: present-here-only is an add, different is an update,
 * identical is unchanged. Keys only on the target are untouched and unreported —
 * import merges, it never deletes.
 */
function diffRecord(incoming: unknown, current: unknown): SectionDiff {
  const result: SectionDiff = { add: [], update: [], unchanged: [] };
  if (!isRecord(incoming)) return result;
  const currentRecord = isRecord(current) ? current : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(currentRecord, key)) result.add.push(key);
    else if (sameValue(value, currentRecord[key])) result.unchanged.push(key);
    else result.update.push(key);
  }
  return result;
}

function unchangedLeaf(key: string): ConfigImportLeafResult {
  return { key, status: "unchanged" };
}

function skippedLeaf(key: string, reason: string): ConfigImportLeafResult {
  return { key, status: "skipped", reason };
}

export class ConfigBundleService {
  private readonly handlers: SectionHandler[];

  constructor(private readonly deps: ConfigBundleServiceDeps) {
    this.handlers = [
      this.userAgentRegistrySection(),
      this.agentSettingsSection(),
      this.keybindingOverridesSection(),
      this.appThemeSection(),
      this.notificationSettingsSection(),
      this.worktreeConfigSection(),
      this.globalRecipesSection(),
    ];
  }

  private handlerFor(id: ConfigBundleSectionId): SectionHandler | undefined {
    return this.handlers.find((h) => h.id === id);
  }

  /** Current value of every portable section, for the exporter. */
  async collect(): Promise<ConfigBundleSections> {
    const sections: ConfigBundleSections = {};
    for (const handler of this.handlers) {
      sections[handler.id] = await handler.read();
    }
    return sections;
  }

  /** Per-section add/update/unchanged counts for the pre-import confirmation. */
  async preview(
    incoming: Partial<Record<ConfigBundleSectionId, unknown>>
  ): Promise<ConfigBundlePreviewSection[]> {
    const previews: ConfigBundlePreviewSection[] = [];
    for (const id of CONFIG_BUNDLE_SECTION_IDS) {
      const payload = incoming[id];
      if (payload === undefined) continue;
      const handler = this.handlerFor(id);
      if (!handler) continue;
      const current = await handler.read();
      const diff = handler.diff(payload, current);
      previews.push({
        section: id,
        add: diff.add.length,
        update: diff.update.length,
        unchanged: diff.unchanged.length,
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
    incoming: Partial<Record<ConfigBundleSectionId, unknown>>
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
        const reason = error instanceof Error ? error.message : String(error);
        // `snapshots` only ever holds sections whose apply was entered, so a
        // failure in the very first section's `read()` leaves nothing to undo.
        const restorable = snapshots.filter((s) => s.handler.id !== id);
        const failedRestores = await this.rollback(restorable);
        rolledBack = restorable.length > 0 && failedRestores.length === 0;

        if (failedRestores.length > 0) {
          // Saying "no changes were kept" here would be a claim we just watched
          // fail. Name the sections that are now in an unknown state instead.
          errors.push(
            `${id}: ${reason}. Undoing the earlier sections also failed, so ${failedRestores.join(", ")} may be partly changed.`
          );
        } else if (restorable.length > 0) {
          errors.push(`${id}: ${reason}. No changes were kept.`);
        } else {
          errors.push(`${id}: ${reason}. Nothing was changed.`);
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

        return { outcome: "rolled-back", sections: settled, errors, rolledBack };
      }
    }

    return { outcome: "applied", sections, errors, rolledBack };
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
    return {
      id: "userAgentRegistry",
      read: async () => loadSanitizedUserAgentRegistry(),
      diff: diffRecord,
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};
        const service = new UserAgentRegistryService();

        for (const [id, config] of Object.entries(incoming)) {
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
    // Only the per-agent record travels. The root-level globals
    // (`globalSkipPermissions`, `globalUseAltScreen`) are permission posture
    // rather than preference, and silently turning one on via an imported file
    // is not a decision this feature should make for the user.
    const readAgents = (): Record<string, unknown> => {
      const settings = store.get("agentSettings");
      return isRecord(settings) && isRecord(settings.agents) ? settings.agents : {};
    };

    return {
      id: "agentSettings",
      read: async () => readAgents(),
      diff: diffRecord,
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

        const merged: Record<string, unknown> = { ...currentRecord };
        const pending: string[] = [];

        for (const [agentId, entry] of Object.entries(incoming)) {
          if (!isRecord(entry)) {
            results.push(skippedLeaf(agentId, "Agent settings entry is not an object"));
            continue;
          }
          if (sameValue(entry, currentRecord[agentId])) {
            results.push(unchangedLeaf(agentId));
            continue;
          }
          // Mirrors the `agentSettings:set` handler: merge over the existing
          // entry, then drop retired legacy keys so they are never written back
          // (stripping after the merge also clears one already persisted).
          const mergedEntry = {
            ...(isRecord(currentRecord[agentId]) ? currentRecord[agentId] : {}),
            ...entry,
          };
          const { selected: _selected, enabled: _enabled, ...safeEntry } = mergedEntry;

          // Compared against `{}` when the agent is new, so an entry made up
          // entirely of retired keys reads as "nothing to write" rather than as
          // a difference from `undefined`.
          const existingEntry = isRecord(currentRecord[agentId]) ? currentRecord[agentId] : {};
          if (sameValue(safeEntry, existingEntry)) {
            // Every field the bundle carried for this agent was a retired key,
            // so nothing it asked for can land. Reporting it applied would
            // credit a write that never happens.
            results.push(skippedLeaf(agentId, "Only retired settings, nothing to apply"));
            continue;
          }

          merged[agentId] = safeEntry;
          pending.push(agentId);
        }

        if (pending.length > 0) {
          store.set("agentSettings.agents", merged);
        }

        const readBack = readAgents();
        for (const agentId of pending) {
          results.push(
            sameValue(readBack[agentId], merged[agentId])
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

  private keybindingOverridesSection(): SectionHandler {
    return {
      id: "keybindingOverrides",
      read: async () => getValidatedOverrides(),
      diff: diffRecord,
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
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        if (!isRecord(incoming)) return results;
        const currentRecord = isRecord(current) ? current : {};

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
          results.push(
            sameValue(readTheme()[field], normalized)
              ? { key: field, status: "applied" }
              : skippedLeaf(field, "Value did not persist")
          );
        }

        return results;
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
          if (!(key in sanitized)) {
            results.push(
              skippedLeaf(
                key,
                key.endsWith("SoundFile")
                  ? "That sound file isn't available on this machine"
                  : "Not a supported notification setting"
              )
            );
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

    return {
      id: "globalRecipes",
      read: async () => projectStore.getGlobalRecipes(),
      diff: (incoming, current) => {
        const result: SectionDiff = { add: [], update: [], unchanged: [] };
        const currentById = byId(current);
        for (const [id, recipe] of byId(incoming)) {
          const existing = currentById.get(id);
          if (!existing) result.add.push(id);
          else if (sameValue(recipe, existing)) result.unchanged.push(id);
          else result.update.push(id);
        }
        return result;
      },
      apply: async (incoming, current) => {
        const results: ConfigImportLeafResult[] = [];
        const currentById = byId(current);
        const pending: string[] = [];

        for (const [id, recipe] of byId(incoming)) {
          const existing = currentById.get(id);
          if (existing && sameValue(recipe, existing)) {
            results.push(unchangedLeaf(id));
            continue;
          }
          if (typeof recipe.name !== "string" || !recipe.name.trim()) {
            results.push(skippedLeaf(id, "Recipe has no name"));
            continue;
          }
          if (!Array.isArray(recipe.terminals)) {
            results.push(skippedLeaf(id, "Recipe has no terminals"));
            continue;
          }

          if (existing) {
            // id/projectId/createdAt are owned by the target store — merging by
            // id is what makes a repeat import a no-op instead of a duplicate.
            const { id: _id, projectId: _projectId, createdAt: _createdAt, ...updates } = recipe;
            await projectStore.updateGlobalRecipe(id, updates as Partial<TerminalRecipe>);
          } else {
            await projectStore.addGlobalRecipe({
              ...(recipe as unknown as TerminalRecipe),
              projectId: undefined,
              createdAt: typeof recipe.createdAt === "number" ? recipe.createdAt : Date.now(),
            });
          }
          pending.push(id);
        }

        if (pending.length === 0) return results;

        const incomingById = byId(incoming);
        const readBackById = byId(await projectStore.getGlobalRecipes());
        for (const id of pending) {
          const stored = readBackById.get(id);
          if (!stored) {
            results.push(skippedLeaf(id, "Recipe did not persist"));
            continue;
          }
          // Compare the fields the bundle actually asked for. Checking only that
          // the id exists would report a recipe as applied even when the store
          // stripped half of it on the way in. `createdAt`/`projectId` are the
          // target store's to own, so they are excluded from the comparison.
          const requested = incomingById.get(id) ?? {};
          const mismatched = Object.keys(requested).filter(
            (key) =>
              key !== "createdAt" && key !== "projectId" && !sameValue(requested[key], stored[key])
          );
          results.push(
            mismatched.length === 0
              ? { key: id, status: "applied" }
              : skippedLeaf(id, `Stored without ${mismatched.join(", ")}`)
          );
        }
        return results;
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
