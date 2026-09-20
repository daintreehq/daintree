import {
  type ProjectFileReader,
  type ProjectReadOptions,
  directoriesUpTo,
  fileExists,
  joinPath,
  readJsonFile,
  toWorktreeRelative,
} from "./fs.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

/** Matches `ProjectModelResultSchema.packageManager`. */
export type DetectedPackageManager = PackageManagerName | "unknown";

const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManagerName }> = [
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
];

export interface PackageManagerDetection {
  name: DetectedPackageManager;
  /** What decided it, worktree-relative — shown to the user, never inferred from silence. */
  evidence: string[];
  /** Populated only when `name` is `unknown` because the evidence disagreed. */
  conflict: string[];
}

type ManagerField =
  | { kind: "absent" }
  | { kind: "recognised"; manager: PackageManagerName }
  | { kind: "unsupported"; declared: string };

/**
 * A `packageManager` naming something we do not drive — `deno@2.0.0` — is
 * evidence, not the absence of it. Falling through to a lockfile there would
 * answer a question the project has already answered differently.
 */
function parseManagerField(value: unknown): ManagerField {
  if (typeof value !== "string" || value.trim().length === 0) return { kind: "absent" };
  const declared = value.trim();
  const name = declared.split("@")[0]?.trim().toLowerCase();
  const manager = LOCKFILES.find((entry) => entry.manager === name)?.manager;
  return manager ? { kind: "recognised", manager } : { kind: "unsupported", declared };
}

/**
 * Which package manager this project already uses. Detection only — nothing
 * here proposes switching, writing a lockfile, or "fixing" a mixed tree.
 *
 * Three tiers, nearest directory first, app root outwards to the worktree root:
 *
 * 1. `packageManager` in `package.json`. A declaration, which Corepack honours
 *    nearest-first; it outranks a lockfile because it is what the developer
 *    said, and a stale lockfile from a previous manager is common.
 * 2. `pnpm-workspace.yaml`. The only workspace file that identifies a manager —
 *    a `workspaces` array is shared by npm, yarn and bun, so it proves nothing.
 * 3. Lockfiles in the nearest directory that has any.
 *
 * Tiers 2 and 3 are weighed together, so `pnpm-workspace.yaml` beside a
 * `pnpm-lock.yaml` is agreement rather than a conflict. Disagreement at that
 * level — two lockfiles, or a workspace file the lockfile contradicts — returns
 * `unknown`. That is the answer the setup card needs: a question for the user,
 * not a coin flip that installs with the wrong tool.
 */
export async function detectPackageManager(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string,
  options: ProjectReadOptions = {}
): Promise<PackageManagerDetection> {
  const dirs = directoriesUpTo(appRoot, worktreeRoot);

  for (const dir of dirs) {
    const manifest = await readJsonFile(reader, joinPath(dir, "package.json"), options);
    const declared = parseManagerField(manifest?.["packageManager"]);
    if (declared.kind === "absent") continue;
    const where = `${toWorktreeRelative(worktreeRoot, dir)}/package.json#packageManager`;
    return declared.kind === "recognised"
      ? { name: declared.manager, evidence: [where], conflict: [] }
      : { name: "unknown", evidence: [], conflict: [`${where} declares ${declared.declared}`] };
  }

  const evidence = new Map<PackageManagerName, string[]>();
  const record = (manager: PackageManagerName, where: string) => {
    const list = evidence.get(manager) ?? [];
    list.push(where);
    evidence.set(manager, list);
  };

  for (const dir of dirs) {
    if (await fileExists(reader, joinPath(dir, "pnpm-workspace.yaml"), options)) {
      record("pnpm", `${toWorktreeRelative(worktreeRoot, dir)}/pnpm-workspace.yaml`);
      break;
    }
  }

  for (const dir of dirs) {
    const present = await Promise.all(
      LOCKFILES.map(async (entry) => ({
        entry,
        exists: await fileExists(reader, joinPath(dir, entry.file), options),
      }))
    );
    const hits = present.filter((item) => item.exists);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      record(hit.entry.manager, `${toWorktreeRelative(worktreeRoot, dir)}/${hit.entry.file}`);
    }
    break;
  }

  const candidates = [...evidence.keys()];
  if (candidates.length === 1) {
    const only = candidates[0] as PackageManagerName;
    return { name: only, evidence: evidence.get(only) ?? [], conflict: [] };
  }
  return {
    name: "unknown",
    evidence: [],
    conflict: [...evidence.values()].flat().sort(),
  };
}
