import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticSpecifiers } from "../../../scripts/lib/static-import-graph.mjs";

// The bridge registers its two IPC listeners at mount, but the previews, the
// preset planner and the cron-word engine only matter once a dispatch needs a
// confirmation or a schedule view opens. A static value import of any of them
// from the files below puts it back in the App chunk. Type-only imports are
// erased, so they are fine; `import()` is the boundary.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

const GUARDED: ReadonlyArray<{ file: string; lazy: readonly string[] }> = [
  {
    file: "src/hooks/useMcpBridge.ts",
    lazy: [
      "@/components/Git/gitRemoteOperationPreview",
      "@/components/TerminalRecipe/recipeConfirmPreview",
      "@/components/Forge/forgeWritePreview",
      "@/components/Worktree/worktreeDeletePreview",
      "@/lib/mcpTerminalLaunchPreview",
      "@/lib/mcpStartHeldPreview",
      "@/lib/mcpAgentPresetPreview",
      "@/services/actions/definitions/agentPresetMutation",
      "@/services/actions/definitions/agentPresetSources",
    ],
  },
  {
    file: "src/services/layout/applyPluginLayout.ts",
    lazy: ["@/components/TerminalRecipe/recipeConfirmPreview"],
  },
];

describe("MCP bridge cold-boot boundary", () => {
  it.each(GUARDED)("$file loads its heavy modules on demand", ({ file, lazy }) => {
    const source = read(file);
    const eager = staticSpecifiers(source, file);
    expect(eager.length).toBeGreaterThan(0);
    for (const specifier of lazy) {
      expect(eager, `${specifier} must not be a static import`).not.toContain(specifier);
      expect(source, `${specifier} should be imported dynamically`).toContain(
        `import("${specifier}")`
      );
    }
  });

  it.each([
    "src/lib/mcpConfirmSubjects.ts",
    "src/services/actions/definitions/agentPresetMutationIds.ts",
  ])("%s stays free of runtime imports", (file) => {
    expect(staticSpecifiers(read(file), file)).toEqual([]);
  });

  it("keeps the cron-word engine out of the scheduled-run inbox entry", () => {
    for (const file of [
      "src/components/Schedules/scheduledRunInboxEntry.ts",
      "src/components/Schedules/runWords.ts",
      "src/components/Schedules/runTime.ts",
    ]) {
      const eager = staticSpecifiers(read(file), file);
      expect(
        eager.filter((specifier) => /scheduleWords|cronDescription/.test(specifier)),
        file
      ).toEqual([]);
    }
  });
});
