import type { AutocompleteItem } from "../AutocompleteMenu";

/**
 * Fixtures for the composer autocomplete harness.
 *
 * Shaped like what the three providers actually produce: slash commands with a
 * mix of plain commands (no badge) and the notable kinds that do carry one,
 * `@file` results as basename + dimmed directory, and the static `@diff` family.
 * Descriptions are deliberately long in places — truncation is one of the
 * things the review has to judge.
 */

const COMMANDS: AutocompleteItem[] = [
  {
    key: "/clear",
    label: "/clear",
    insertText: "/clear",
    description: "Clear conversation history and free up context",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/compact",
    label: "/compact",
    insertText: "/compact",
    description:
      "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/code-review",
    label: "/code-review",
    insertText: "/code-review",
    description: "Review the current diff for correctness bugs at the given effort level",
    category: "skill",
    enterAction: "insert",
  },
  {
    key: "/codex:review",
    label: "/codex:review",
    insertText: "/codex:review",
    description: "Collaborative review with Codex (chat-aware, one optional focus arg)",
    category: "plugin",
    enterAction: "insert",
  },
  {
    key: "/config",
    label: "/config",
    insertText: "/config",
    description: "Open config panel",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/context",
    label: "/context",
    insertText: "/context",
    description: "Visualize current context usage as a coloured grid",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/cost",
    label: "/cost",
    insertText: "/cost",
    description: "Show the total cost and duration of the current session",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/github:create-issue:decompose",
    label: "/github:create-issue:decompose",
    insertText: "/github:create-issue:decompose",
    description: "Decompose task into scoped issues",
    category: "plugin",
    enterAction: "insert",
  },
  {
    key: "/doctor",
    label: "/doctor",
    insertText: "/doctor",
    description: "Diagnose and verify your installation and settings",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/export",
    label: "/export",
    insertText: "/export",
    description: "Export the current conversation to a file or clipboard",
    category: "command",
    enterAction: "execute",
  },
  {
    key: "/frontend-design",
    label: "/frontend-design",
    insertText: "/frontend-design",
    description: "Create distinctive, production-grade frontend interfaces",
    category: "skill",
    enterAction: "insert",
  },
  {
    key: "/help",
    label: "/help",
    insertText: "/help",
    description: "Show help and available commands",
    category: "command",
    enterAction: "execute",
  },
];

const CAPABILITIES: AutocompleteItem[] = [
  {
    key: "$plugin-creator",
    label: "$plugin-creator",
    insertText: "$plugin-creator",
    description: "Scaffold a new Codex plugin with a manifest, skills and a README",
    category: "skill",
    enterAction: "insert",
  },
  {
    key: "$figma",
    label: "$figma",
    insertText: "$figma",
    description: "Read frames and components from a connected Figma file",
    category: "app",
    enterAction: "insert",
  },
  {
    key: "$linear",
    label: "$linear",
    insertText: "$linear",
    description: "Search, create and update Linear issues",
    category: "app",
    enterAction: "insert",
  },
  {
    key: "$pdf",
    label: "$pdf",
    insertText: "$pdf",
    description: "Extract text and tables from PDF files",
    category: "skill",
    enterAction: "insert",
  },
];

function fileItem(path: string): AutocompleteItem {
  const sep = path.lastIndexOf("/");
  const base = sep >= 0 ? path.slice(sep + 1) : path;
  const dir = sep >= 0 ? path.slice(0, sep) : "";
  return {
    key: path,
    label: base,
    insertText: `@${path}`,
    description: dir || undefined,
    descriptionKind: "path",
    enterAction: "insert",
    insert: "literal",
  };
}

const FILES: AutocompleteItem[] = [
  "src/components/Terminal/AutocompleteMenu.tsx",
  "src/components/Terminal/__tests__/AutocompleteMenu.test.tsx",
  "src/components/Terminal/hooks/useAutocompleteItems.ts",
  "src/components/Terminal/hooks/useAutocompleteApply.ts",
  "src/components/Settings/AgentSettings/AgentCompletionSourcesSection.tsx",
  "README.md",
  "src/components/Terminal/HybridInputBar.tsx",
  "electron/services/completion-sources/CompletionSourceEngine.ts",
].map(fileItem);

const DIFFS: AutocompleteItem[] = [
  {
    key: "diff",
    label: "@diff",
    description: "Working tree diff",
    insertText: "@diff",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:staged",
    label: "@diff:staged",
    description: "Staged diff",
    insertText: "@diff:staged",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:head",
    label: "@diff:head",
    description: "HEAD diff",
    insertText: "@diff:head",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
];

/** The composer's title, aria label and empty copy per trigger — as `HybridInputBar` passes them. */
export type MenuTrigger = "commands" | "capabilities" | "files" | "diffs";

export const TRIGGER_COPY: Record<
  MenuTrigger,
  { title: string; ariaLabel: string; emptyMessage: string; draft: string }
> = {
  commands: {
    title: "Commands",
    ariaLabel: "Command autocomplete",
    emptyMessage: "No commands match",
    draft: "/c",
  },
  capabilities: {
    title: "Capabilities",
    ariaLabel: "Capability autocomplete",
    emptyMessage: "No capabilities match",
    draft: "$",
  },
  files: {
    title: "Files",
    ariaLabel: "File autocomplete",
    emptyMessage: "No files match",
    draft: "@auto",
  },
  diffs: {
    title: "Diffs",
    ariaLabel: "Diff autocomplete",
    emptyMessage: "No matches",
    draft: "@diff",
  },
};

export interface MenuCase {
  trigger: MenuTrigger;
  items: AutocompleteItem[];
  selectedIndex: number;
  isLoading?: boolean;
  /** Mark every row stale, as a debounced `@file` search does mid-flight. */
  stale?: boolean;
  /** Hover this row index before capture, to show what pointer rest does. */
  hoverIndex?: number;
  /** Override the draft shown in the composer. */
  draft?: string;
}

/**
 * Every state that carries design weight. The names are the capture file names,
 * so keep them stable — the before/after comparison pairs files by name.
 */
export const MENU_CASES: Record<string, MenuCase> = {
  // Enter runs a plain command: the hint has two things to say.
  "commands-run": { trigger: "commands", items: COMMANDS, selectedIndex: 0 },
  // Enter inserts a skill: the hint has one.
  "commands-insert": { trigger: "commands", items: COMMANDS, selectedIndex: 2 },
  // Selection deep in a list that overflows the cap, so the scroll shadow shows.
  "commands-scrolled": { trigger: "commands", items: COMMANDS, selectedIndex: 10 },
  "commands-hover": { trigger: "commands", items: COMMANDS, selectedIndex: 0, hoverIndex: 1 },
  capabilities: { trigger: "capabilities", items: CAPABILITIES, selectedIndex: 1 },
  files: { trigger: "files", items: FILES, selectedIndex: 0 },
  "files-stale": { trigger: "files", items: FILES, selectedIndex: 0, stale: true },
  diffs: { trigger: "diffs", items: DIFFS, selectedIndex: 0 },
  loading: { trigger: "files", items: [], selectedIndex: 0, isLoading: true },
  empty: { trigger: "commands", items: [], selectedIndex: 0, draft: "/zzz" },
};

export function requireMenuCase(name: string): MenuCase {
  const found = MENU_CASES[name];
  if (!found) throw new Error(`unknown autocomplete case "${name}"`);
  return found;
}
