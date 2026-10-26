import { scanSources } from "./rendererStorageScan.js";

export interface StorageProblem {
  file: string;
  message: string;
}

/** Whether a declared key (exact, or ending `*` for a prefix) covers a key the code uses. */
export function covers(declared: string, key: string, partial = false): boolean {
  if (declared.endsWith("*")) return key.startsWith(declared.slice(0, -1));
  return !partial && declared === key;
}

export function checkRendererStorage(
  sources: ReadonlyMap<string, string>,
  declared: readonly string[]
): StorageProblem[] {
  const problems: StorageProblem[] = [];
  const used = new Set<string>();
  for (const use of scanSources(sources)) {
    const where = `${use.file}:${use.line}`;
    if (use.keys.length === 0) {
      problems.push({
        file: use.file,
        message: `${where}: cannot read this storage key (${use.reason}). Pass a named string constant, or put \`// storage-key: <key>\` above the statement.`,
      });
      continue;
    }
    for (const key of use.keys) {
      const match = declared.filter((d) => covers(d, key, use.partial));
      for (const d of match) used.add(d);
      if (match.length === 0) {
        problems.push({
          file: use.file,
          message: `${where}: storage key "${key}"${use.partial ? " (built at runtime)" : ""} has no declared owner and scope.${use.partial ? " Declare it as a `*` prefix." : ""}`,
        });
      }
    }
  }
  for (const d of declared) {
    if (!used.has(d)) {
      problems.push({
        file: "shared/config/settingOwnership.ts",
        message: `Declared storage key "${d}" is not used under src/; remove its entry.`,
      });
    }
  }
  return problems;
}
