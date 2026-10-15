import { randomBytes } from "node:crypto";
import {
  isConfigBundleSectionId,
  type ConfigBundlePreviewSection,
  type ConfigBundleSectionId,
  type ConfigImportLeafResult,
  type ConfigImportReport,
} from "../../../shared/types/configBundle.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CapturedSection, ConfigBundleService } from "../../services/ConfigBundleService.js";
import type {
  SettingsCopyLastCopy,
  SettingsCopyUndoLeaf,
} from "../../../shared/types/ipc/settingsCopy.js";
import type { LinkSession } from "../link/session.js";
import type { LastCopyRecord } from "./LastCopyStore.js";
import {
  SettingsCopyApplySchema,
  SettingsCopyLinkMethod,
  SettingsCopyPreviewSchema,
  SettingsCopyUndoSchema,
  type SettingsCopyPreviewRequest,
  type SettingsCopyPreviewResult,
  type SettingsCopyStatusResult,
  type SettingsCopyUndoLinkResult,
} from "./linkMethods.js";

export interface HostSettingsCopyDeps {
  service(): Promise<Pick<ConfigBundleService, "preview" | "apply" | "revision" | "undo">>;
  /** Where the last copy received is kept, with what an undo needs. */
  records: {
    read(): Promise<LastCopyRecord | null>;
    write(record: LastCopyRecord): Promise<LastCopyRecord>;
  };
  /** The queue every config write on this machine goes through. */
  runWrite<T>(write: () => Promise<T>): Promise<T>;
  /** Bring this machine's services and every window in line after a write. */
  reconcile(): Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
  ticketTtlMs?: number;
}

interface Ticket {
  sections: Partial<Record<ConfigBundleSectionId, unknown>>;
  ids: ConfigBundleSectionId[];
  revision: string;
  expiresAt: number;
  /** Leaves the preview refused and the payload no longer carries, reported with the result. */
  refused: Map<ConfigBundleSectionId, ConfigImportLeafResult[]>;
  /** What the preview called each changed leaf, `section:key`, for the record. */
  labels: Map<string, string>;
}

function splitPayload(request: SettingsCopyPreviewRequest): {
  sections: Partial<Record<ConfigBundleSectionId, unknown>>;
  unknownSections: string[];
} {
  const sections: Partial<Record<ConfigBundleSectionId, unknown>> = {};
  const unknownSections: string[] = [];
  for (const [id, payload] of Object.entries(request.sections)) {
    if (isConfigBundleSectionId(id)) sections[id] = payload;
    else unknownSections.push(id);
  }
  return { sections, unknownSections };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The payload minus every keyed entry the preview said it would skip. Some
 * verdicts rest on things outside the sections' own revision (whether an
 * agent is installed, or can run the assistant), so they are decided once,
 * here, and an apply can never write what its preview refused.
 */
function withoutRefused(
  sections: Partial<Record<ConfigBundleSectionId, unknown>>,
  previews: ConfigBundlePreviewSection[]
): {
  sections: Partial<Record<ConfigBundleSectionId, unknown>>;
  refused: Map<ConfigBundleSectionId, ConfigImportLeafResult[]>;
} {
  const kept = { ...sections };
  const refused = new Map<ConfigBundleSectionId, ConfigImportLeafResult[]>();
  for (const preview of previews) {
    const payload = kept[preview.section];
    if (!isRecord(payload) || !preview.skipped?.length) continue;
    const next = { ...payload };
    const leaves: ConfigImportLeafResult[] = [];
    for (const skip of preview.skipped) {
      if (!Object.prototype.hasOwnProperty.call(next, skip.key)) continue;
      delete next[skip.key];
      leaves.push({ key: skip.key, status: "skipped", reason: skip.reason });
    }
    kept[preview.section] = next;
    if (leaves.length > 0) refused.set(preview.section, leaves);
  }
  return { sections: kept, refused };
}

/** Put the refused leaves back into the report, so it lists everything the preview did. */
function withRefused(
  report: ConfigImportReport,
  refused: Map<ConfigBundleSectionId, ConfigImportLeafResult[]>
): ConfigImportReport {
  if (refused.size === 0 || report.outcome !== "applied") return report;
  return {
    ...report,
    sections: report.sections.map((section) => {
      const leaves = refused.get(section.section);
      if (!leaves) return section;
      return {
        ...section,
        skipped: section.skipped + leaves.length,
        leaves: [...section.leaves, ...leaves],
      };
    }),
  };
}

/** Long enough to read a long preview; a person who leaves it longer previews again. */
const TICKET_TTL_MS = 15 * 60_000;
const MAX_TICKETS_PER_SESSION = 4;

/** The record as a Shell may see it: names of what changed, never a value. */
function publicCopy(record: LastCopyRecord): SettingsCopyLastCopy {
  if (record.copy.undo !== "available" || !record.leaves) return record.copy;
  return {
    ...record.copy,
    changed: record.leaves.map(({ section, key, label }) => ({ section, key, label })),
  };
}

function undoStale(): AppError {
  return new AppError({
    code: "SETTINGS_COPY_UNDO_STALE",
    message: "That copy can no longer be undone",
    userMessage: "There's a newer copy, or this one was already undone. Refresh to see it.",
  });
}

function stale(): AppError {
  return new AppError({
    code: "SETTINGS_PREVIEW_STALE",
    message: "Settings changed since the copy was previewed",
    userMessage: "Settings here changed since the preview. Preview again.",
  });
}

/**
 * Host side of Copy settings (#13346). A preview is worked out here, against
 * this machine's live settings and with its own validators, and kept: apply
 * takes the ticket and writes exactly the payload that was previewed, after
 * checking that nothing it could change has changed since. Nothing is written
 * unless a Shell's person asks, and nothing is kept past its session.
 */
export class HostSettingsCopy {
  private readonly sessions = new WeakMap<LinkSession, Map<string, Ticket>>();
  private disposed = false;

  constructor(private readonly deps: HostSettingsCopyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** `source` is the name the Shell gave when it connected, recorded as who copied. */
  attach(session: LinkSession, source = ""): void {
    if (this.disposed || this.sessions.has(session)) return;
    const tickets = new Map<string, Ticket>();
    this.sessions.set(session, tickets);
    const unregister = [
      session.registerCallHandler(SettingsCopyLinkMethod.PREVIEW, SettingsCopyPreviewSchema, (p) =>
        this.preview(tickets, p)
      ),
      session.registerCallHandler(SettingsCopyLinkMethod.APPLY, SettingsCopyApplySchema, (p) =>
        this.apply(tickets, p.ticket, source)
      ),
      session.registerCallHandler(SettingsCopyLinkMethod.STATUS, SettingsCopyPreviewSchema, (p) =>
        this.status(p)
      ),
      session.registerCallHandler(SettingsCopyLinkMethod.UNDO, SettingsCopyUndoSchema, (p) =>
        this.undo(p.copyId)
      ),
    ];
    session.onClose(() => {
      tickets.clear();
      for (const dispose of unregister) dispose();
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private async preview(
    tickets: Map<string, Ticket>,
    request: SettingsCopyPreviewRequest
  ): Promise<SettingsCopyPreviewResult> {
    const { sections, unknownSections } = splitPayload(request);
    const ids = Object.keys(sections) as ConfigBundleSectionId[];
    const service = await this.deps.service();
    // Inside the write queue, so no other write lands between the preview
    // and the revision it is checked against.
    const { previews, revision } = await this.deps.runWrite(async () => ({
      previews: await service.preview(sections),
      revision: await service.revision(ids),
    }));

    const now = this.now();
    for (const [id, entry] of tickets) {
      if (entry.expiresAt <= now) tickets.delete(id);
    }
    while (tickets.size >= MAX_TICKETS_PER_SESSION) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
    const ticket = randomBytes(16).toString("hex");
    const { sections: accepted, refused } = withoutRefused(sections, previews);
    const labels = new Map(
      previews.flatMap((preview) =>
        preview.changes.map((change) => [`${preview.section}:${change.key}`, change.label] as const)
      )
    );
    tickets.set(ticket, {
      sections: accepted,
      ids,
      revision,
      expiresAt: now + (this.deps.ticketTtlMs ?? TICKET_TTL_MS),
      refused,
      labels,
    });
    return {
      ticket,
      platform: this.deps.platform ?? process.platform,
      sections: previews,
      unknownSections,
    };
  }

  private async apply(
    tickets: Map<string, Ticket>,
    ticket: string,
    source: string
  ): Promise<ConfigImportReport> {
    const entry = tickets.get(ticket);
    // One apply per preview: a retry previews again rather than writing twice.
    tickets.delete(ticket);
    if (!entry || entry.expiresAt <= this.now()) throw stale();
    const service = await this.deps.service();
    const report = await this.deps.runWrite(async () => {
      if ((await service.revision(entry.ids)) !== entry.revision) throw stale();
      const captured: CapturedSection[] = [];
      const applied = withRefused(
        await service.apply(entry.sections, { capture: captured }),
        entry.refused
      );
      // A copy that rolled back changed nothing, so the copy before it is
      // still the last one, and still undoable.
      if (applied.outcome === "applied") await this.record(entry, applied, captured, source);
      return applied;
    });
    if (report.outcome === "applied") {
      try {
        await this.deps.reconcile();
      } catch (error) {
        // The settings are written; a window that missed the refresh catches
        // up on its next reload, so the copy is still reported as it landed.
        console.error("[HostSettingsCopy] Refresh after copy failed:", error);
      }
    }
    return report;
  }

  private async record(
    entry: Ticket,
    report: ConfigImportReport,
    captured: CapturedSection[],
    source: string
  ): Promise<void> {
    const record: LastCopyRecord = {
      copy: {
        id: randomBytes(16).toString("hex"),
        source: source.slice(0, 256),
        at: this.now(),
        sections: report.sections
          .filter((section) => section.present)
          .map(({ section, applied, skipped }) => ({ section, applied, skipped })),
        undo: "available",
      },
      leaves: captured.flatMap(({ section, leaves }) =>
        leaves.map((leaf) => ({
          section,
          label: entry.labels.get(`${section}:${leaf.key}`) ?? leaf.key,
          ...leaf,
        }))
      ),
    };
    try {
      await this.deps.records.write(record);
    } catch (error) {
      // The settings landed; only the record of them didn't. The copy is
      // still reported as it landed, and the page offers no undo it can't do.
      console.error("[HostSettingsCopy] Couldn't record the copy:", error);
    }
  }

  private async status(request: SettingsCopyPreviewRequest): Promise<SettingsCopyStatusResult> {
    const { sections, unknownSections } = splitPayload(request);
    const service = await this.deps.service();
    const { previews, record } = await this.deps.runWrite(async () => ({
      previews: await service.preview(sections),
      record: await this.deps.records.read(),
    }));
    return {
      // The preview's counts already leave out what this host would refuse,
      // so a missing sound or an agent it lacks is never counted as a change.
      sections: previews.map(({ section, add, update }) => ({ section, add, update })),
      unknownSections,
      lastCopy: record ? publicCopy(record) : null,
    };
  }

  private async undo(copyId: string): Promise<SettingsCopyUndoLinkResult> {
    const service = await this.deps.service();
    const result = await this.deps.runWrite(async () => {
      const record = await this.deps.records.read();
      if (!record || record.copy.id !== copyId || record.copy.undo !== "available") {
        throw undoStale();
      }
      const leaves = record.leaves ?? [];
      const bySection = new Map<ConfigBundleSectionId, CapturedSection>();
      for (const { section, key, before, after } of leaves) {
        const group = bySection.get(section) ?? { section, leaves: [] };
        group.leaves.push({
          key,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
        });
        bySection.set(section, group);
      }
      const outcomes = await service.undo([...bySection.values()]);
      const label = new Map(leaves.map((leaf) => [`${leaf.section}:${leaf.key}`, leaf.label]));
      const undoneLeaves: SettingsCopyUndoLeaf[] = outcomes.flatMap(({ section, leaves: done }) =>
        done.map(({ key, status }) => ({
          section,
          key,
          label: label.get(`${section}:${key}`) ?? key,
          status,
        }))
      );
      const undone = { at: this.now(), leaves: undoneLeaves };
      // The earlier values go with the undo: a leaf left because it was
      // edited since can't come back later by matching again by chance.
      const lastCopy: SettingsCopyLastCopy = { ...record.copy, undo: "done", undone };
      try {
        await this.deps.records.write({ copy: lastCopy });
      } catch (error) {
        console.error("[HostSettingsCopy] Couldn't record the undo:", error);
      }
      return { undone, lastCopy };
    });
    if (result.undone.leaves.some((leaf) => leaf.status === "restored")) {
      try {
        await this.deps.reconcile();
      } catch (error) {
        console.error("[HostSettingsCopy] Refresh after undo failed:", error);
      }
    }
    return result;
  }
}
