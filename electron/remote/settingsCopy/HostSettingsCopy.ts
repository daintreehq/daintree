import { randomBytes } from "node:crypto";
import {
  isConfigBundleSectionId,
  type ConfigBundlePreviewSection,
  type ConfigBundleSectionId,
  type ConfigImportLeafResult,
  type ConfigImportReport,
} from "../../../shared/types/configBundle.js";
import { AppError } from "../../utils/errorTypes.js";
import type { ConfigBundleService } from "../../services/ConfigBundleService.js";
import type { LinkSession } from "../link/session.js";
import {
  SettingsCopyApplySchema,
  SettingsCopyLinkMethod,
  SettingsCopyPreviewSchema,
  type SettingsCopyPreviewRequest,
  type SettingsCopyPreviewResult,
} from "./linkMethods.js";

export interface HostSettingsCopyDeps {
  service(): Promise<Pick<ConfigBundleService, "preview" | "apply" | "revision">>;
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

  attach(session: LinkSession): void {
    if (this.disposed || this.sessions.has(session)) return;
    const tickets = new Map<string, Ticket>();
    this.sessions.set(session, tickets);
    const unregister = [
      session.registerCallHandler(SettingsCopyLinkMethod.PREVIEW, SettingsCopyPreviewSchema, (p) =>
        this.preview(tickets, p)
      ),
      session.registerCallHandler(SettingsCopyLinkMethod.APPLY, SettingsCopyApplySchema, (p) =>
        this.apply(tickets, p.ticket)
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
    const sections: Partial<Record<ConfigBundleSectionId, unknown>> = {};
    const unknownSections: string[] = [];
    for (const [id, payload] of Object.entries(request.sections)) {
      if (isConfigBundleSectionId(id)) sections[id] = payload;
      else unknownSections.push(id);
    }
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
    tickets.set(ticket, {
      sections: accepted,
      ids,
      revision,
      expiresAt: now + (this.deps.ticketTtlMs ?? TICKET_TTL_MS),
      refused,
    });
    return {
      ticket,
      platform: this.deps.platform ?? process.platform,
      sections: previews,
      unknownSections,
    };
  }

  private async apply(tickets: Map<string, Ticket>, ticket: string): Promise<ConfigImportReport> {
    const entry = tickets.get(ticket);
    // One apply per preview: a retry previews again rather than writing twice.
    tickets.delete(ticket);
    if (!entry || entry.expiresAt <= this.now()) throw stale();
    const service = await this.deps.service();
    const report = withRefused(
      await this.deps.runWrite(async () => {
        if ((await service.revision(entry.ids)) !== entry.revision) throw stale();
        return service.apply(entry.sections);
      }),
      entry.refused
    );
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
}
