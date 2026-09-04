import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { runValidate } from "./validate.js";
import { caretEngineAdvisory } from "../../../../electron/schemas/pluginManifestAdvisories.js";
import { sendCliRequest, DaintreeUnavailableError } from "../ipc/client.js";

/**
 * `doctor` is `validate` plus the checks that only make sense against a whole
 * project: the ones about git, and the ones about what the running host has
 * actually decided.
 *
 * The split is deliberate. `validate` answers "is this manifest well-formed",
 * which an author runs constantly and offline. `doctor` answers "would this
 * plugin load for someone who cloned the repository", which is the question the
 * machine that built it can never answer by inspection — a committed `dist/`
 * and an untracked one look identical from inside the working tree.
 */

/** Where a project keeps its committed plugins. */
const PROJECT_PLUGINS_SEGMENTS = [".daintree", "plugins"];

export interface DoctorOptions {
  /** Skip the query to a running Daintree. Used by tests and by CI. */
  offline?: boolean;
}

export interface DoctorPluginReport {
  /** Directory under `.daintree/plugins/`. */
  dirName: string;
  /** Manifest id, when the manifest parsed far enough to carry one. */
  pluginId: string | null;
  errors: string[];
  warnings: string[];
  /** What the running host reports for this directory, when one is reachable. */
  hostState: string | null;
}

export interface DoctorHostReport {
  reachable: boolean;
  /** Whether the host has this project on its list at all. */
  known: boolean;
  /** `enabled` / `disabled` / `session`, or null when nothing is on record. */
  trustDecision: string | null;
  /** Whether project plugins are currently permitted to run. */
  trustEnabled: boolean | null;
  note: string;
}

export interface DoctorResult {
  projectRoot: string;
  pluginsDir: string;
  plugins: DoctorPluginReport[];
  host: DoctorHostReport;
  ok: boolean;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `git` will answer questions about this directory at all. Every git
 * check below is skipped rather than failed when it won't: a plugin authored in
 * a directory that is not yet a repository is incomplete, not broken.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execa("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Rule 11 — the file is reachable by git at all. `--no-index` is what makes
 * this answer the question the author means: without it git reports a tracked
 * file as un-ignored even when the ignore rules would exclude it, which is
 * exactly the false pass that makes a stale `.gitignore` survive review.
 *
 * The verdict comes from the exit code of the PLAIN form, never from whether
 * `-v` printed something. `-v` prints the last matching pattern whether or not
 * it is a negation, so a correctly-rescued `dist/` matching `!dist/**` produces
 * output and exit 0 — reading that as "ignored" fails exactly the plugins that
 * got rule 11 right. `-v` is run only after the plain form has already said the
 * file is ignored, purely to name the rule responsible.
 */
async function checkNotIgnored(
  repoRoot: string,
  relativePath: string,
  label: string,
  errors: string[]
): Promise<void> {
  const verdict = await execa("git", ["-C", repoRoot, "check-ignore", "--no-index", relativePath], {
    reject: false,
  });
  // Exit 1 is the ordinary "not ignored" answer. Anything above 1 is a git
  // failure, not a plugin defect — the tracked check still covers the case that
  // actually breaks a clone.
  if (verdict.exitCode !== 0) return;

  const detail = await execa(
    "git",
    ["-C", repoRoot, "check-ignore", "-v", "--no-index", relativePath],
    { reject: false }
  );
  const rule = detail.stdout.trim().split("\n")[0]?.split("\t")[0] ?? "an ignore rule";
  errors.push(
    `${label} "${relativePath}" is git-ignored by ${rule} — add "!dist/" and "!dist/**" to the plugin's .gitignore, and relax any ancestor rule that excludes the plugin directory itself, since git never reaches a .gitignore inside an excluded directory`
  );
}

/** Rule 10 — the file is committed, not merely present on the machine that built it. */
async function checkTracked(
  repoRoot: string,
  relativePath: string,
  label: string,
  errors: string[]
): Promise<void> {
  const result = await execa("git", ["-C", repoRoot, "ls-files", "--error-unmatch", relativePath], {
    reject: false,
  });
  if (result.exitCode !== 0) {
    errors.push(
      `${label} "${relativePath}" is not tracked by git — it loads for you and for nobody who clones this repository. Commit it in the same commit as the source change.`
    );
  }
}

/**
 * The build output has to be ESM, because both consumers import it as ESM: Node
 * imports the worker entry in a utility process, and the renderer imports the
 * view as browser ESM. A CommonJS bundle passes a syntax check — `require` and
 * `module` are ordinary identifiers in ESM — and then throws at import time, so
 * shape is checked separately from syntax.
 */
async function checkEsmModule(
  absolutePath: string,
  label: string,
  errors: string[],
  warnings: string[]
): Promise<void> {
  let source: string;
  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch {
    errors.push(`${label} "${absolutePath}" doesn't exist — build the plugin or fix the path`);
    return;
  }

  const parse = await execa("node", ["--input-type=module", "--check"], {
    input: source,
    reject: false,
  });
  if (parse.exitCode !== 0) {
    const firstLine = (parse.stderr || "").split("\n").find((l) => l.includes("Error")) ?? "";
    errors.push(`${label} doesn't parse as ESM${firstLine ? `: ${firstLine.trim()}` : ""}`);
    return;
  }

  const hasEsmExport = /(^|[\s;}])export\s+(default|const|let|var|function|async|class|\{|\*)/.test(
    source
  );
  const hasCjsExport = /(^|[\s;}])(module\.exports|exports\.[A-Za-z_$])/.test(source);
  if (hasCjsExport && !hasEsmExport) {
    errors.push(
      `${label} is CommonJS — it assigns to module.exports and exports nothing. Both the worker and the renderer import it as ESM, so it will throw at import. Build it as ESM, and name the worker entry .mjs so it stays ESM in a CommonJS repository.`
    );
  } else if (!hasEsmExport) {
    warnings.push(
      `${label} exports nothing — the worker entry needs an exported activate(), and a view needs a default export.`
    );
  }
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Every relative build target the manifest names: `main` plus each view's component. */
function buildTargets(manifest: Record<string, unknown> | null): Array<[string, string]> {
  if (!manifest) return [];
  const targets: Array<[string, string]> = [];
  if (typeof manifest.main === "string" && manifest.main.length > 0) {
    targets.push(["main", manifest.main]);
  }
  const contributes = manifest.contributes as { views?: unknown } | undefined;
  const views = Array.isArray(contributes?.views) ? contributes.views : [];
  views.forEach((view, index) => {
    const componentPath = (view as { componentPath?: unknown } | null)?.componentPath;
    if (typeof componentPath === "string" && componentPath.length > 0) {
      targets.push([`views[${index}].componentPath`, componentPath]);
    }
  });
  return targets;
}

interface HostQuery {
  host: DoctorHostReport;
  /** Directory name → the state Daintree computed for it. Empty when unreachable. */
  states: Map<string, string>;
}

async function queryHost(projectRoot: string, offline: boolean): Promise<HostQuery> {
  const empty = new Map<string, string>();
  if (offline) {
    return {
      host: {
        reachable: false,
        known: false,
        trustDecision: null,
        trustEnabled: null,
        note: "Skipped — running offline.",
      },
      states: empty,
    };
  }
  try {
    const status = (await sendCliRequest("plugin.project.status", { projectRoot })) as {
      known?: boolean;
      trust?: { decision?: string | null; enabled?: boolean } | null;
      plugins?: Array<{ id?: string; dirName?: string; state?: string }>;
    };
    if (!status.known) {
      return {
        host: {
          reachable: true,
          known: false,
          trustDecision: null,
          trustEnabled: null,
          note: "Daintree is running but has never opened this project, so it has computed no trust or staging state for it yet.",
        },
        states: empty,
      };
    }
    const decision = status.trust?.decision ?? null;
    return {
      host: {
        reachable: true,
        known: true,
        trustDecision: decision,
        trustEnabled: status.trust?.enabled ?? null,
        note:
          decision === null
            ? "No trust decision on record — Daintree will ask the next time this project opens."
            : `Trust decision: ${decision}.`,
      },
      states: new Map(
        (status.plugins ?? [])
          .filter(
            (plugin): plugin is { dirName: string; state: string } =>
              typeof plugin.dirName === "string" && typeof plugin.state === "string"
          )
          .map((plugin) => [plugin.dirName, plugin.state])
      ),
    };
  } catch (err) {
    const note =
      err instanceof DaintreeUnavailableError
        ? "Daintree isn't running, so its trust and staging state can't be read. Everything else was checked."
        : `Couldn't read Daintree's state: ${(err as Error).message}`;
    return {
      host: { reachable: false, known: false, trustDecision: null, trustEnabled: null, note },
      states: empty,
    };
  }
}

/**
 * Check every plugin committed under a project's `.daintree/plugins/`, covering
 * the mechanically checkable rules from the agent brief: the schema (via
 * `validate`), the engine range that must not be a caret, and the two git facts
 * — reachable and tracked — that decide whether the plugin exists for anyone
 * but its author.
 */
export async function runDoctor(
  projectRoot: string,
  opts: DoctorOptions = {}
): Promise<DoctorResult> {
  const root = path.resolve(projectRoot);
  const pluginsDir = path.join(root, ...PROJECT_PLUGINS_SEGMENTS);

  const { host, states: hostStates } = await queryHost(root, opts.offline === true);

  if (!(await pathExists(pluginsDir))) {
    return { projectRoot: root, pluginsDir, plugins: [], host, ok: true };
  }

  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  const dirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const repoRoot = (await isGitRepo(root)) ? root : null;

  const plugins: DoctorPluginReport[] = [];
  for (const dirName of dirNames) {
    const dir = path.join(pluginsDir, dirName);
    // Origin is known, not inferred: everything here lives under
    // `.daintree/plugins/`, so it is checked against the rules the host will
    // actually apply — including the `scope: "project"` a manifest must declare.
    const { errors, warnings } = await runValidate({ dir, origin: "project" });
    const manifest = await readManifest(dir);
    const pluginId = typeof manifest?.name === "string" ? manifest.name : null;

    const engines = manifest?.engines as { daintree?: unknown } | undefined;
    const caret =
      typeof engines?.daintree === "string" ? caretEngineAdvisory(engines.daintree) : null;
    if (caret) errors.push(caret);

    const realDir = await fs.realpath(dir).catch(() => path.resolve(dir));
    for (const [label, target] of buildTargets(manifest)) {
      if (path.isAbsolute(target) || target.includes("\\")) {
        errors.push(`${label} "${target}" must be a relative path using forward slashes`);
        continue;
      }
      const absolute = path.join(dir, target);
      // The host resolves entry paths against the plugin directory and refuses
      // anything that climbs out of it, so a `../` target is dead on arrival
      // even though it exists and is committed. Checked after realpath, since a
      // symlink inside the directory escapes just as effectively as `../`.
      const realTarget = await fs.realpath(absolute).catch(() => path.resolve(absolute));
      const relative = path.relative(realDir, realTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        errors.push(
          `${label} "${target}" resolves outside the plugin directory — the host refuses an entry path that climbs out of it, so this cannot load however it is committed`
        );
        continue;
      }
      await checkEsmModule(absolute, label, errors, warnings);
      if (repoRoot) {
        // git speaks forward slashes on every platform; `path.relative` hands
        // back backslashes on Windows, which git reads as part of the filename.
        const relativeToRepo = path.relative(repoRoot, absolute).split(path.sep).join("/");
        await checkNotIgnored(repoRoot, relativeToRepo, label, errors);
        await checkTracked(repoRoot, relativeToRepo, label, errors);
      }
    }

    if (!repoRoot) {
      warnings.push(
        "Not a git repository, so the two checks that decide whether this plugin exists for anyone who clones it were skipped."
      );
    }

    plugins.push({
      dirName,
      pluginId,
      errors,
      warnings,
      hostState: hostStates.get(dirName) ?? null,
    });
  }

  return {
    projectRoot: root,
    pluginsDir,
    plugins,
    host,
    ok: plugins.every((plugin) => plugin.errors.length === 0),
  };
}
