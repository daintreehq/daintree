import { createHash } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { isAbsolute, join as pathJoin, resolve as pathResolve } from "path";
import type { IdlePausePolicy, IdlePauseUnavailableReason } from "../../shared/types/idlePause.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import type {
  ResolvedResourceSelection,
  WorktreeLifecycleService,
} from "./WorktreeLifecycleService.js";

/**
 * Idle pause (#17925) runs an environment's pause with nobody there, so like
 * a scheduled run it is never something a repository can turn on: a consent
 * lives in this device's userData, given for one environment's exact pause
 * commands from the person's own file, and a `git pull` that adds or shadows
 * an environment never inherits one.
 */

const CONSENTS_VERSION = 1;
const FINGERPRINT_VERSION = "daintree-idle-pause/v1";
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export interface IdlePauseConsent {
  fingerprint: string;
  /** Seen with other commands since it was given: off until confirmed again. */
  revoked?: true;
}

export interface IdlePauseConsentStore {
  /** Never throws: a consent that can't be read is one not given. */
  get(projectRootPath: string, selector: string): Promise<IdlePauseConsent | null>;
  set(projectRootPath: string, selector: string, fingerprint: string): Promise<void>;
  /** Marks it revoked, only while it still holds `fingerprint`. */
  revoke(projectRootPath: string, selector: string, fingerprint: string): Promise<void>;
  clear(projectRootPath: string, selector: string): Promise<void>;
}

/** The pause commands as written, with the block and file they came from. */
export function fingerprintIdlePause(
  selector: string,
  sourcePath: string,
  pause: readonly string[]
): string {
  return createHash("sha256")
    .update(JSON.stringify([FINGERPRINT_VERSION, selector, sourcePath, [...pause]]))
    .digest("hex");
}

/** Mirrors what runs: an empty command is skipped, so it isn't one to confirm. */
function pauseCommandsOf(selection: ResolvedResourceSelection): string[] {
  return (selection.resource.pause ?? []).filter((command) => command.length > 0);
}

/**
 * One file per project in the app's own userData. One workspace host serves
 * each project and is the only writer, so the in-process chain is the only
 * serialization a file needs; the atomic write covers crashes.
 */
export class FileIdlePauseConsentStore implements IdlePauseConsentStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async get(projectRootPath: string, selector: string): Promise<IdlePauseConsent | null> {
    const file = this.fileFor(projectRootPath);
    if (!file) return null;
    return (await this.read(file)).get(selector) ?? null;
  }

  set(projectRootPath: string, selector: string, fingerprint: string): Promise<void> {
    if (!FINGERPRINT_RE.test(fingerprint)) {
      return Promise.reject(new Error("Invalid idle pause fingerprint"));
    }
    return this.update(projectRootPath, (consents) => {
      consents.set(selector, { fingerprint });
    });
  }

  revoke(projectRootPath: string, selector: string, fingerprint: string): Promise<void> {
    return this.update(projectRootPath, (consents) => {
      const current = consents.get(selector);
      if (current?.fingerprint === fingerprint)
        consents.set(selector, { fingerprint, revoked: true });
    });
  }

  clear(projectRootPath: string, selector: string): Promise<void> {
    return this.update(projectRootPath, (consents) => {
      consents.delete(selector);
    });
  }

  private update(
    projectRootPath: string,
    change: (consents: Map<string, IdlePauseConsent>) => void
  ): Promise<void> {
    const dir = this.dir;
    const file = this.fileFor(projectRootPath);
    if (!dir || !file) {
      return Promise.reject(new Error("Idle pause can't be saved without an app data folder"));
    }
    const run = this.writeChain.then(async () => {
      const consents = await this.read(file);
      change(consents);
      await mkdir(dir, { recursive: true });
      await resilientAtomicWriteFile(
        file,
        JSON.stringify(
          {
            version: CONSENTS_VERSION,
            projectRootPath: pathResolve(projectRootPath),
            environments: Object.fromEntries(consents),
          },
          null,
          2
        ),
        "utf-8",
        { mode: 0o600 }
      );
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private fileFor(projectRootPath: string): string | null {
    if (!this.dir) return null;
    const key = createHash("sha256").update(pathResolve(projectRootPath)).digest("hex");
    return pathJoin(this.dir, `${key.slice(0, 32)}.json`);
  }

  private async read(file: string): Promise<Map<string, IdlePauseConsent>> {
    const consents = new Map<string, IdlePauseConsent>();
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
      if (!parsed || typeof parsed !== "object") return consents;
      const record = parsed as { version?: unknown; environments?: unknown };
      if (record.version !== CONSENTS_VERSION) return consents;
      if (!record.environments || typeof record.environments !== "object") return consents;
      for (const [selector, value] of Object.entries(record.environments)) {
        if (!value || typeof value !== "object") continue;
        const { fingerprint, revoked } = value as { fingerprint?: unknown; revoked?: unknown };
        if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) continue;
        consents.set(selector, revoked === true ? { fingerprint, revoked } : { fingerprint });
      }
    } catch {
      // Missing or unreadable: nothing was consented to.
    }
    return consents;
  }
}

/** Without an absolute userData there is no folder main agrees on, so nothing is on. */
export function resolveIdlePauseConsentsDir(userDataDir: string | undefined): string | null {
  if (!userDataDir || !isAbsolute(userDataDir)) return null;
  return pathJoin(userDataDir, "idle-pause-consents");
}

type Eligibility =
  | { ok: true; commands: string[]; fingerprint: string }
  | { ok: false; reason: IdlePauseUnavailableReason };

const UNAVAILABLE_MESSAGES: Record<IdlePauseUnavailableReason, string> = {
  "no-environment": "The worktree has no resource environment",
  repository: "The environment comes from the repository",
  "no-pause": "The environment has no pause commands",
};

/** Whether idle pause may be on for a worktree's environment, and what it would run. */
export class IdlePauseService {
  constructor(
    private readonly lifecycle: WorktreeLifecycleService,
    private readonly consents: IdlePauseConsentStore = new FileIdlePauseConsentStore(
      resolveIdlePauseConsentsDir(process.env.DAINTREE_USER_DATA)
    )
  ) {}

  /** The block a manual pause on this worktree would run. */
  async selectionFor(
    worktreePath: string,
    projectRootPath: string,
    worktreeMode: string | undefined
  ): Promise<ResolvedResourceSelection | null> {
    // A manual pause names no environment, so neither does this.
    return (
      await this.lifecycle.resolveResourceSelection(
        worktreePath,
        projectRootPath,
        undefined,
        worktreeMode
      )
    ).selection;
  }

  async policy(
    worktreePath: string,
    projectRootPath: string,
    worktreeMode: string | undefined
  ): Promise<IdlePausePolicy> {
    const selection = await this.selectionFor(worktreePath, projectRootPath, worktreeMode);
    const eligibility = this.eligibility(selection);
    if (!eligibility.ok) {
      return {
        status: "unavailable",
        reason: eligibility.reason,
        ...(selection ? { sourcePath: selection.path } : {}),
      };
    }
    const consent = await this.consents.get(projectRootPath, selection!.selector);
    const enabled = consent?.fingerprint === eligibility.fingerprint && consent.revoked !== true;
    if (consent && !consent.revoked && !enabled) {
      await this.consents
        .revoke(projectRootPath, selection!.selector, consent.fingerprint)
        .catch(() => undefined);
    }
    return {
      status: "available",
      environment: selection!.name,
      sourcePath: selection!.path,
      commands: eligibility.commands,
      fingerprint: eligibility.fingerprint,
      enabled,
      changed: consent !== null && !enabled,
    };
  }

  /**
   * Turns it on for the commands the person was shown, recomputed here and
   * refused when they no longer match, or off.
   */
  async setEnabled(
    worktreePath: string,
    projectRootPath: string,
    worktreeMode: string | undefined,
    enabled: boolean,
    fingerprint?: string
  ): Promise<void> {
    const selection = await this.selectionFor(worktreePath, projectRootPath, worktreeMode);
    if (!enabled) {
      if (selection) await this.consents.clear(projectRootPath, selection.selector);
      return;
    }
    const eligibility = this.eligibility(selection);
    if (!eligibility.ok) throw new Error(UNAVAILABLE_MESSAGES[eligibility.reason]);
    if (fingerprint !== eligibility.fingerprint) {
      throw new Error("These pause commands changed after you reviewed them. Review them again.");
    }
    await this.consents.set(projectRootPath, selection!.selector, eligibility.fingerprint);
  }

  /**
   * The fingerprint an idle pause of `selection` runs under, or why it may
   * not run. Seeing other commands than the ones confirmed turns it off.
   */
  async confirmed(
    selection: ResolvedResourceSelection | null,
    projectRootPath: string
  ): Promise<{ ok: true; fingerprint: string } | { ok: false; reason: string }> {
    const eligibility = this.eligibility(selection);
    if (!eligibility.ok) return { ok: false, reason: UNAVAILABLE_MESSAGES[eligibility.reason] };
    const consent = await this.consents.get(projectRootPath, selection!.selector);
    if (!consent) return { ok: false, reason: "Idle pause is off for this environment" };
    if (consent.revoked) {
      return { ok: false, reason: "The pause commands changed since idle pause was turned on" };
    }
    if (consent.fingerprint !== eligibility.fingerprint) {
      await this.consents
        .revoke(projectRootPath, selection!.selector, consent.fingerprint)
        .catch(() => undefined);
      return { ok: false, reason: "The pause commands changed since idle pause was turned on" };
    }
    return { ok: true, fingerprint: eligibility.fingerprint };
  }

  private eligibility(selection: ResolvedResourceSelection | null): Eligibility {
    if (!selection) return { ok: false, reason: "no-environment" };
    // The block that wins is the one that runs: the person's own definition
    // of an environment a repository file now shadows doesn't count.
    if (selection.origin !== "user") return { ok: false, reason: "repository" };
    const commands = pauseCommandsOf(selection);
    if (commands.length === 0) return { ok: false, reason: "no-pause" };
    return {
      ok: true,
      commands,
      fingerprint: fingerprintIdlePause(selection.selector, selection.path, commands),
    };
  }
}
