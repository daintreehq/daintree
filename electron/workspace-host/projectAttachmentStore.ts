import { createHash } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { isAbsolute, join as pathJoin, resolve as pathResolve } from "path";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import type { ProjectAttachmentObservation } from "../../shared/types/worktree.js";

const STORE_VERSION = 1;

/** Who holds one attachment, and what Daintree last saw its commands do. */
export interface ProjectAttachmentRecord {
  holderWorktreeId: string | null;
  lastResult?: ProjectAttachmentObservation;
  status?: ProjectAttachmentObservation;
}

export type ProjectAttachmentRecords = Record<string, ProjectAttachmentRecord>;

export interface ProjectAttachmentStore {
  /** Never throws: state that cannot be read is no state. */
  load(projectRootPath: string): Promise<ProjectAttachmentRecords>;
  save(projectRootPath: string, records: ProjectAttachmentRecords): Promise<void>;
}

const OBSERVATION_ACTIONS = new Set(["attach", "detach", "status", "removed"]);
const OBSERVATION_STATES = new Set(["success", "failed", "timed-out", "needs-approval"]);

function readObservation(value: unknown): ProjectAttachmentObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    !OBSERVATION_ACTIONS.has(v.action as string) ||
    !OBSERVATION_STATES.has(v.state as string) ||
    typeof v.worktreeId !== "string" ||
    typeof v.at !== "number"
  ) {
    return undefined;
  }
  return {
    action: v.action as ProjectAttachmentObservation["action"],
    worktreeId: v.worktreeId,
    state: v.state as ProjectAttachmentObservation["state"],
    output: typeof v.output === "string" ? v.output : undefined,
    error: typeof v.error === "string" ? v.error : undefined,
    at: v.at,
  };
}

/**
 * Holders live in the app's own userData, one file per project, beside the
 * command approvals — never in the repository, which every branch can rewrite.
 * One workspace-host process serves each project, so the in-process write
 * chain is the only serialization a file needs; the atomic write covers crashes.
 */
export class FileProjectAttachmentStore implements ProjectAttachmentStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async load(projectRootPath: string): Promise<ProjectAttachmentRecords> {
    const file = this.fileFor(projectRootPath);
    if (!file) return {};
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
      if (!parsed || typeof parsed !== "object") return {};
      const record = parsed as { version?: unknown; attachments?: unknown };
      if (record.version !== STORE_VERSION) return {};
      if (!record.attachments || typeof record.attachments !== "object") return {};
      // Null prototype: names come from the file, and `__proto__` is a name.
      const records: ProjectAttachmentRecords = Object.create(null);
      for (const [name, raw] of Object.entries(record.attachments as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        records[name] = {
          holderWorktreeId: typeof r.holderWorktreeId === "string" ? r.holderWorktreeId : null,
          lastResult: readObservation(r.lastResult),
          status: readObservation(r.status),
        };
      }
      return records;
    } catch {
      return {};
    }
  }

  save(projectRootPath: string, records: ProjectAttachmentRecords): Promise<void> {
    const dir = this.dir;
    const file = this.fileFor(projectRootPath);
    if (!dir || !file) return Promise.resolve();
    const payload = JSON.stringify(
      {
        version: STORE_VERSION,
        projectRootPath: pathResolve(projectRootPath),
        attachments: records,
      },
      null,
      2
    );
    const run = this.writeChain.then(async () => {
      await mkdir(dir, { recursive: true });
      await resilientAtomicWriteFile(file, payload, "utf-8", { mode: 0o600 });
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private fileFor(projectRootPath: string): string | null {
    if (!this.dir) return null;
    const key = createHash("sha256").update(pathResolve(projectRootPath)).digest("hex");
    return pathJoin(this.dir, `${key.slice(0, 32)}.json`);
  }
}

/** Without an absolute userData there is nowhere main agrees on, so nothing persists. */
export function resolveProjectAttachmentsDir(userDataDir: string | undefined): string | null {
  if (!userDataDir || !isAbsolute(userDataDir)) return null;
  return pathJoin(userDataDir, "project-attachments");
}
