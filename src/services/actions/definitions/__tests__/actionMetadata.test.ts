import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks } from "../../actionTypes";
import type { ActionDefinition } from "@shared/types/actions";

// Intentionally no vi.mock calls. Action factories are pure object literals —
// they only access clients/stores/services inside `run()`, which this test never
// calls. Broad mocks would risk hiding real import-time failures. See
// actionDefinitions.bootstrap.test.ts for precedent.

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 120;
// Keep in sync with CLAUDE.md > Actions > Categories.
const CANONICAL_CATEGORIES = new Set<string>([
  "agent",
  "app",
  "artifacts",
  "browser",
  "copyTree",
  "devServer",
  "diagnostics",
  "errors",
  "files",
  "git",
  "github",
  "help",
  "introspection",
  "logs",
  "navigation",
  "panel",
  "portal",
  "preferences",
  "project",
  "recipes",
  "settings",
  "system",
  "terminal",
  "ui",
  "voice",
  "worktree",
]);
// Lowercase segment start; camelCase allowed within each dot-separated segment.
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

interface MetadataFailure {
  id: string;
  title: string;
  category: string;
  failures: string[];
}

function createStubCallbacks(): ActionCallbacks {
  return {
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
    onAddTerminal: async () => {},
  };
}

function validateDefinition(def: ActionDefinition): string[] {
  const failures: string[] = [];
  const id = def.id ?? "";
  const title = def.title ?? "";
  const description = def.description ?? "";
  const category = def.category ?? "";

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    failures.push(`id "${id}" does not match namespace.action convention`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    failures.push("title is empty");
  } else if (title.length > TITLE_MAX) {
    failures.push(`title is ${title.length} chars (max ${TITLE_MAX})`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    failures.push("description is empty");
  } else if (description.length > DESCRIPTION_MAX) {
    failures.push(`description is ${description.length} chars (max ${DESCRIPTION_MAX})`);
  }
  if (typeof category !== "string" || !CANONICAL_CATEGORIES.has(category)) {
    failures.push(`category "${category}" is not in canonical allowlist`);
  }
  return failures;
}

function pad(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width - 3) + "...";
  return value + " ".repeat(width - value.length);
}

function formatFailureTable(failures: MetadataFailure[], total: number): string {
  const MAX_ROWS = 50;
  const header =
    `\n${failures.length}/${total} actions failed metadata validation.\n\n` +
    `${pad("ID", 42)}${pad("Title", 30)}${pad("Category", 16)}Violations\n` +
    `${"-".repeat(42 + 30 + 16 + 10)}\n`;
  const rows = failures
    .slice(0, MAX_ROWS)
    .map(
      (f) => `${pad(f.id, 42)}${pad(f.title, 30)}${pad(f.category, 16)}${f.failures.join("; ")}`
    );
  const truncationNote =
    failures.length > MAX_ROWS ? `\n... and ${failures.length - MAX_ROWS} more.` : "";
  return header + rows.join("\n") + truncationNote;
}

describe("action metadata quality gate", () => {
  let registry: Map<string, () => ActionDefinition>;

  beforeAll(async () => {
    // Match actionDefinitions.bootstrap.test.ts — avoid noisy terminal bootstrap
    // side effects and keep node-like suites quiet.
    vi.resetModules();
    Reflect.deleteProperty(globalThis as Record<string, unknown>, "window");
    Object.defineProperty(globalThis, "self", {
      value: globalThis,
      configurable: true,
      writable: true,
    });
    const { createActionDefinitions } = await import("../../actionDefinitions");
    registry = createActionDefinitions(createStubCallbacks()) as Map<
      string,
      () => ActionDefinition
    >;
  });

  it("every registered action passes all metadata rules", () => {
    const failures: MetadataFailure[] = [];
    for (const [id, factory] of registry.entries()) {
      let def: ActionDefinition;
      try {
        def = factory();
      } catch (error) {
        failures.push({
          id: String(id),
          title: "",
          category: "",
          failures: [`factory threw: ${(error as Error).message}`],
        });
        continue;
      }
      const rule = validateDefinition(def);
      if (rule.length > 0) {
        failures.push({
          id: String(id),
          title: def.title ?? "",
          category: def.category ?? "",
          failures: rule,
        });
      }
    }
    const message =
      failures.length === 0
        ? "All actions pass metadata validation"
        : formatFailureTable(failures, registry.size);
    expect(failures.length, message).toBe(0);
  });
});
