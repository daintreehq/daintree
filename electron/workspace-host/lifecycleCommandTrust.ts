import { createHash } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { isAbsolute, join as pathJoin, resolve as pathResolve } from "path";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import type {
  LifecycleCommandReviewGroup,
  LifecycleCommandReviewSource,
} from "../../shared/types/worktree.js";

/**
 * Repository-supplied lifecycle commands only run once the user has approved
 * them (#12408). The config lookup lets any branch — including a fork PR head —
 * supply its own `.daintree/config.json`, so trusting a repository cannot mean
 * trusting whatever its branches say to run.
 *
 * Approval is keyed by the project and the exact command templates, not by the
 * file's path: every new worktree carries its own copy of the config, so a
 * path-keyed approval would ask again on every create and train the reflex it
 * exists to prevent. Identical templates are identical commands — substituted
 * values are shell-escaped separately (`substituteVariables`). What an approval
 * does not cover is the content of scripts those commands call; that is the same
 * boundary direnv and mise draw, and the review dialog says so.
 */

const APPROVALS_VERSION = 1;
const FINGERPRINT_VERSION = "daintree-lifecycle-commands/v1";
const PLUGIN_STEP_FINGERPRINT_VERSION = "daintree-plugin-worktree-setup/v1";
const MAX_APPROVED_FINGERPRINTS = 200;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export type LifecycleCommandOrigin = "user" | "repository";

/** The commands one file contributes, and who owns that file. */
export interface LifecycleCommandSource extends LifecycleCommandReviewSource {
  origin: LifecycleCommandOrigin;
  fingerprint: string;
}

export interface LifecycleCommandApprovalStore {
  /** Never throws: an approval that cannot be read is an approval not given. */
  isApproved(projectRootPath: string, fingerprint: string): Promise<boolean>;
  approve(projectRootPath: string, fingerprints: readonly string[]): Promise<void>;
}

/**
 * The fields of a resource block that decide what runs. `provider` is not a
 * command, but it reaches every command as `DAINTREE_RESOURCE_PROVIDER`, so a
 * template that runs `$DAINTREE_RESOURCE_PROVIDER` would otherwise run whatever
 * a branch put there. Timeouts and poll intervals change nothing that runs.
 */
interface ResourceCommands {
  provision?: string[];
  teardown?: string[];
  resume?: string[];
  pause?: string[];
  status?: string;
  connect?: string;
  provider?: string;
}

const RESOURCE_COMMAND_FIELDS = [
  "provision",
  "teardown",
  "resume",
  "pause",
  "status",
  "connect",
  "provider",
] as const;

function nonEmpty(commands: readonly string[] | string | undefined): string[] {
  if (commands === undefined) return [];
  const list = typeof commands === "string" ? [commands] : [...commands];
  // Mirrors what actually runs: an empty `status`/`connect` string is skipped by
  // every caller, so it is not a command anyone needs to approve.
  return list.filter((command) => command.length > 0);
}

function pushResourceGroups(
  groups: LifecycleCommandReviewGroup[],
  labelPrefix: string,
  resource: ResourceCommands | undefined
): void {
  if (!resource) return;
  for (const field of RESOURCE_COMMAND_FIELDS) {
    const commands = nonEmpty(resource[field]);
    if (commands.length > 0) groups.push({ label: `${labelPrefix} ${field}`, commands });
  }
}

/** What a project attachment runs. Everything in it is a command. */
interface AttachmentCommands {
  attach: string[];
  detach: string[];
  status?: string;
}

const ATTACHMENT_COMMAND_FIELDS = ["attach", "detach", "status"] as const;

export function lifecycleConfigCommandGroups(config: {
  setup?: string[];
  teardown?: string[];
  resource?: ResourceCommands;
  resources?: Record<string, ResourceCommands>;
  attachments?: Record<string, AttachmentCommands>;
}): LifecycleCommandReviewGroup[] {
  const groups: LifecycleCommandReviewGroup[] = [];
  const setup = nonEmpty(config.setup);
  if (setup.length > 0) groups.push({ label: "Setup", commands: setup });
  const teardown = nonEmpty(config.teardown);
  if (teardown.length > 0) groups.push({ label: "Teardown", commands: teardown });
  pushResourceGroups(groups, "Resource", config.resource);
  // Object order is kept: the "first environment" fallback makes it meaningful.
  for (const [name, resource] of Object.entries(config.resources ?? {})) {
    pushResourceGroups(groups, `Resource "${name}"`, resource);
  }
  // Appended after every existing group, so a config that declares no
  // attachments keeps the fingerprint it was approved under.
  for (const [name, attachment] of Object.entries(config.attachments ?? {})) {
    for (const field of ATTACHMENT_COMMAND_FIELDS) {
      const commands = nonEmpty(attachment[field]);
      if (commands.length > 0) groups.push({ label: `Attachment "${name}" ${field}`, commands });
    }
  }
  return groups;
}

export function resourceEnvironmentCommandGroups(
  environments: Record<string, ResourceCommands>
): LifecycleCommandReviewGroup[] {
  const groups: LifecycleCommandReviewGroup[] = [];
  for (const [name, resource] of Object.entries(environments)) {
    pushResourceGroups(groups, `Environment "${name}"`, resource);
  }
  return groups;
}

/**
 * Hash of what would run. Labels carry the field and environment name, so
 * moving a command between phases or environments changes it as surely as
 * editing the command does. Formatting and non-command fields do not.
 */
export function fingerprintCommandGroups(
  kind: "config" | "settings",
  groups: readonly LifecycleCommandReviewGroup[]
): string {
  const payload = JSON.stringify([
    FINGERPRINT_VERSION,
    kind,
    groups.map((group) => [group.label, group.commands]),
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Hash of what allowing a plugin's worktree setup step covers (#13807): which
 * plugin, at which version, runs which step, as shown and for how long. A new
 * version asks again — the code that runs is the plugin's, and an upgrade is
 * new code under the same name. Its own domain, so these never collide with,
 * or disturb, a command fingerprint in the same approvals file.
 */
export function fingerprintPluginSetupStep(step: {
  pluginId: string;
  pluginVersion: string;
  stepId: string;
  label: string;
  timeoutMs: number;
}): string {
  const payload = JSON.stringify([
    PLUGIN_STEP_FINGERPRINT_VERSION,
    step.pluginId,
    step.pluginVersion,
    step.stepId,
    step.label,
    step.timeoutMs,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The fingerprint a review is approved against. Plugin steps are appended
 * after the command sources, so a review with none keeps the fingerprint it
 * has always had.
 */
export function fingerprintReview(
  sources: readonly LifecycleCommandSource[],
  pluginStepFingerprints: readonly string[] = []
): string {
  return createHash("sha256")
    .update([...sources.map((source) => source.fingerprint), ...pluginStepFingerprints].join("\n"))
    .digest("hex");
}

/**
 * Approvals live in the app's own userData, one file per project. One
 * workspace-host process serves each project, so the in-process write chain is
 * the only serialization a file needs; the atomic write covers crashes.
 */
export class FileLifecycleCommandApprovalStore implements LifecycleCommandApprovalStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async isApproved(projectRootPath: string, fingerprint: string): Promise<boolean> {
    const file = this.fileFor(projectRootPath);
    if (!file) return false;
    return (await this.read(file)).includes(fingerprint);
  }

  approve(projectRootPath: string, fingerprints: readonly string[]): Promise<void> {
    const dir = this.dir;
    const file = this.fileFor(projectRootPath);
    if (!dir || !file) {
      return Promise.reject(
        new Error("Command approvals can't be saved without an app data folder")
      );
    }
    const run = this.writeChain.then(async () => {
      const incoming = fingerprints.filter((fingerprint) => FINGERPRINT_RE.test(fingerprint));
      const kept = (await this.read(file)).filter((fingerprint) => !incoming.includes(fingerprint));
      const merged = [...kept, ...incoming].slice(-MAX_APPROVED_FINGERPRINTS);
      await mkdir(dir, { recursive: true });
      await resilientAtomicWriteFile(
        file,
        JSON.stringify(
          {
            version: APPROVALS_VERSION,
            projectRootPath: pathResolve(projectRootPath),
            fingerprints: merged,
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

  private async read(file: string): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
      if (!parsed || typeof parsed !== "object") return [];
      const record = parsed as { version?: unknown; fingerprints?: unknown };
      if (record.version !== APPROVALS_VERSION || !Array.isArray(record.fingerprints)) return [];
      return record.fingerprints.filter(
        (value): value is string => typeof value === "string" && FINGERPRINT_RE.test(value)
      );
    } catch {
      return [];
    }
  }
}

/**
 * The workspace-host is forked with `DAINTREE_USER_DATA`. Without an absolute
 * one there is no location main agrees on, so nothing is approved — failing
 * closed rather than guessing at a folder the app never granted anything in.
 */
export function resolveLifecycleCommandApprovalsDir(
  userDataDir: string | undefined
): string | null {
  if (!userDataDir || !isAbsolute(userDataDir)) return null;
  return pathJoin(userDataDir, "lifecycle-command-approvals");
}
