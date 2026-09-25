import type { Artifact } from "@shared/types";

/**
 * Artifact sets for the overlay's visual-review harness. Content is realistic on
 * purpose: a two-line fixture hides every question the overlay has to answer
 * about length, truncation and what a patch will actually touch.
 */

const CODE_TS = [
  'import { formatDistanceToNowStrict } from "date-fns";',
  "",
  "export interface RelativeTimeOptions {",
  "  now?: number;",
  "  addSuffix?: boolean;",
  "}",
  "",
  "/** Human-readable age of a timestamp, clamped so clock skew never reads as the future. */",
  "export function formatRelativeTime(timestamp: number, options: RelativeTimeOptions = {}): string {",
  "  const now = options.now ?? Date.now();",
  "  const clamped = Math.min(timestamp, now);",
  '  if (now - clamped < 45_000) return "just now";',
  "  return formatDistanceToNowStrict(clamped, { addSuffix: options.addSuffix ?? true });",
  "}",
].join("\n");

const PATCH_SMALL = [
  "diff --git a/src/lib/format.ts b/src/lib/format.ts",
  "--- a/src/lib/format.ts",
  "+++ b/src/lib/format.ts",
  "@@ -12,7 +12,8 @@ export function formatBytes(bytes: number): string {",
  "   if (bytes < 1024) return `${bytes} B`;",
  '   const units = ["KB", "MB", "GB", "TB"];',
  "-  let value = bytes / 1024;",
  "+  let value = Math.max(0, bytes) / 1024;",
  '+  if (!Number.isFinite(value)) return "—";',
  "   let unit = 0;",
  "   while (value >= 1024 && unit < units.length - 1) {",
  "     value /= 1024;",
].join("\n");

const PATCH_MEDIUM = [
  "diff --git a/src/services/SessionCache.ts b/src/services/SessionCache.ts",
  "--- a/src/services/SessionCache.ts",
  "+++ b/src/services/SessionCache.ts",
  "@@ -1,6 +1,7 @@",
  ' import { LRUCache } from "lru-cache";',
  ' import type { Session } from "@shared/types";',
  '+import { logDebug } from "@/utils/logger";',
  " ",
  " const MAX_SESSIONS = 200;",
  " ",
  "@@ -24,11 +25,14 @@ export class SessionCache {",
  "   get(id: string): Session | undefined {",
  "-    return this.cache.get(id);",
  "+    const hit = this.cache.get(id);",
  '+    if (!hit) logDebug("session cache miss", { id });',
  "+    return hit;",
  "   }",
  " ",
  "   set(session: Session): void {",
  "-    this.cache.set(session.id, session);",
  "-    this.dirty = true;",
  "+    this.cache.set(session.id, { ...session, cachedAt: Date.now() });",
  "+    this.markDirty();",
  "   }",
  " ",
  "@@ -61,4 +65,9 @@ export class SessionCache {",
  "   clear(): void {",
  "     this.cache.clear();",
  "   }",
  "+",
  "+  private markDirty(): void {",
  "+    this.dirty = true;",
  "+    this.flushSoon();",
  "+  }",
  " }",
].join("\n");

function longPatch(): string {
  const lines = [
    "diff --git a/src/components/Settings/KeyboardShortcutsTab.tsx b/src/components/Settings/KeyboardShortcutsTab.tsx",
    "--- a/src/components/Settings/KeyboardShortcutsTab.tsx",
    "+++ b/src/components/Settings/KeyboardShortcutsTab.tsx",
  ];
  for (let h = 0; h < 18; h++) {
    const start = 20 + h * 40;
    lines.push(`@@ -${start},12 +${start},14 @@ function ShortcutGroup${h}() {`);
    lines.push(`   const group = useShortcutGroup("group-${h}");`);
    lines.push(`   if (!group) return null;`);
    lines.push(
      `-  const rows = group.bindings.map((binding) => <ShortcutRow key={binding.id} binding={binding} />);`
    );
    lines.push(`+  const rows = group.bindings`);
    lines.push(`+    .filter((binding) => !binding.hidden)`);
    lines.push(
      `+    .map((binding) => <ShortcutRow key={binding.id} binding={binding} dense={isDense} />);`
    );
    lines.push(`   return (`);
    lines.push(`     <section aria-labelledby="group-${h}-title">`);
    lines.push(`-      <h3 id="group-${h}-title">{group.title}</h3>`);
    lines.push(
      `+      <h3 id="group-${h}-title" className="text-sm font-medium">{group.title}</h3>`
    );
    lines.push(`       {rows}`);
    lines.push(`     </section>`);
    lines.push(`   );`);
  }
  return lines.join("\n");
}

const SUMMARY = [
  "## Summary",
  "",
  "- Clamped negative byte counts in `formatBytes` and guarded non-finite input.",
  "- Added a debug log on session cache misses so the flake in #4412 can be traced.",
  "- Extracted `markDirty()` so every write path schedules a flush.",
  "",
  "Tests: `npm test -- src/lib/format src/services/SessionCache` (41 passed).",
].join("\n");

const JSON_FILE = [
  "{",
  '  "name": "daintree-preview",',
  '  "version": "0.4.0",',
  '  "scripts": { "dev": "vite", "test": "vitest" }',
  "}",
].join("\n");

const T0 = 1_760_000_000_000;

function art(id: string, partial: Omit<Artifact, "id" | "extractedAt">, i: number): Artifact {
  return { id, extractedAt: T0 + i * 1000, ...partial };
}

export const POPULATED: Artifact[] = [
  art(
    "code-1",
    { type: "code", language: "typescript", filename: "src/lib/relativeTime.ts", content: CODE_TS },
    0
  ),
  art(
    "patch-1",
    { type: "patch", language: "diff", filename: "src/lib/format.ts", content: PATCH_SMALL },
    1
  ),
  art(
    "patch-2",
    {
      type: "patch",
      language: "diff",
      filename: "src/services/SessionCache.ts",
      content: PATCH_MEDIUM,
    },
    2
  ),
  art("summary-1", { type: "summary", content: SUMMARY }, 3),
  art(
    "file-1",
    { type: "file", language: "json", filename: "package.json", content: JSON_FILE },
    4
  ),
];

export const SINGLE_CODE: Artifact[] = [POPULATED[0]!];

export const SINGLE_PATCH: Artifact[] = [POPULATED[2]!];

export const LONG_PATCH: Artifact[] = [
  art(
    "patch-long",
    {
      type: "patch",
      language: "diff",
      filename: "src/components/Settings/KeyboardShortcutsTab.tsx",
      content: longPatch(),
    },
    0
  ),
  POPULATED[1]!,
];

export const MANY: Artifact[] = Array.from({ length: 16 }, (_, i) => {
  const base = POPULATED[i % POPULATED.length]!;
  const deep =
    i === 3
      ? "src/components/Worktree/WorktreeCard/__tests__/fixtures/veryLongFixtureNameForTruncation.ts"
      : base.filename;
  return { ...base, id: `${base.id}-${i}`, filename: deep, extractedAt: T0 + i * 1000 };
});

export const FIXTURES: Record<string, Artifact[]> = {
  populated: POPULATED,
  "single-code": SINGLE_CODE,
  "single-patch": SINGLE_PATCH,
  "long-patch": LONG_PATCH,
  many: MANY,
};

export const APPLY_ERROR_MESSAGE =
  "error: patch failed: src/services/SessionCache.ts:24\nerror: src/services/SessionCache.ts: patch does not apply";
