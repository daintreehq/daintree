import fs from "fs/promises";
import path from "path";

// Toolbar.tsx composes its overflow menu, item placement, overflow status and
// eviction, customization and project-pill modules (#14347), and the pill's
// markup lives in its own component. The source guards read them as one
// surface, so an invariant holds wherever its code sits.
const TOOLBAR_SOURCE_FILES = [
  "Toolbar.tsx",
  "useToolbarItemPlacement.ts",
  "useToolbarOverflowStatus.ts",
  "useToolbarOverflowEviction.ts",
  "useToolbarCustomization.ts",
  "useToolbarProjectPill.tsx",
  "ToolbarOverflowMenu.tsx",
  "toolbarItemClasses.ts",
  "ToolbarProjectPill.tsx",
  "ForgeStatsPlaceholder.tsx",
];

export async function readToolbarSource(): Promise<string> {
  const sources = await Promise.all(
    TOOLBAR_SOURCE_FILES.map((file) => fs.readFile(path.resolve(__dirname, "..", file), "utf-8"))
  );
  return sources.join("\n");
}
