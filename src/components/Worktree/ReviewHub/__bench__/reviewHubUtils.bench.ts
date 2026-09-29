import { bench, describe } from "vitest";
import { matchesFilter, sortFiles } from "../reviewHubUtils";
import type { SortKey } from "../reviewHubUtils";
import type { StagingFileEntry } from "@shared/types";

const STATUSES = ["modified", "added", "deleted", "renamed", "untracked"] as const;
const DIRS = ["src/components", "src/store", "electron/services", "shared/config", "docs"];
const TAILS = [".ts", ".tsx", ".test.ts", ".min.js", ".generated.ts", ".snap", ".lock", ".css"];

function makeFiles(n: number): StagingFileEntry[] {
  const out: StagingFileEntry[] = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  for (let i = 0; i < n; i++) {
    const dir = DIRS[Math.floor(rnd() * DIRS.length)];
    const tail = TAILS[Math.floor(rnd() * TAILS.length)];
    out.push({
      path: `${dir}/module${Math.floor(rnd() * 500)}/file${i}${tail}`,
      status: STATUSES[Math.floor(rnd() * STATUSES.length)],
      insertions: Math.floor(rnd() * 50),
      deletions: Math.floor(rnd() * 50),
    } as StagingFileEntry);
  }
  return out;
}

const KEYS: SortKey[] = ["path", "churn", "status"];
for (const n of [2000, 5000, 20000]) {
  const files = makeFiles(n);
  describe(`sortFiles ${n}`, () => {
    for (const key of KEYS) {
      bench(`${key} asc`, () => {
        sortFiles(files, key, "asc");
      });
    }
    bench("path desc", () => {
      sortFiles(files, "path", "desc");
    });
  });
  describe(`matchesFilter ${n}`, () => {
    for (const q of ["module42", "src/**/*.test.ts", "**/file1?*.ts", "src/store/*"]) {
      bench(q, () => {
        let c = 0;
        for (const f of files) if (matchesFilter(f.path, q)) c++;
        return c as unknown as void;
      });
    }
  });
}
