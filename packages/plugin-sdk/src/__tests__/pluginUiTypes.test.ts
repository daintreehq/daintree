import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDir = path.resolve(here, "../..");

/**
 * A plugin author's view, typed the way the docs tell them to: the SDK
 * installed, `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` in tsconfig, and
 * nothing else. The `@ts-expect-error` lines keep it honest — if the module
 * collapsed to `any`, they would be unused and fail the compile.
 */
const CONSUMER = `
import { createElement } from "react";
import {
  Markdown,
  Button,
  Icon,
  Select,
  DropdownMenu,
  CopyButton,
  EmptyState,
  PLUGIN_UI_VERSION,
  useDaintreeTheme,
  getDaintreeTheme,
  onDidChangeDaintreeTheme,
  type MarkdownProps,
  type IconName,
  type DropdownMenuEntry,
  type DaintreeTheme,
  VirtualList,
  DataTable,
  LogView,
  PaneHeader,
  Toolbar,
  ToolbarButton,
  PaneState,
  FormField,
  Input,
  Switch,
  Tabs,
  ProgressBar,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsActions,
  ListRow,
  SeverityIcon,
  useListNavigation,
  formatTimeAgo,
  formatRelativeTime,
  formatBytes,
  formatCount,
  formatDuration,
  type DataTableColumn,
  type DataTableSort,
  type LogEntry,
  type Severity,
} from "@daintreehq/plugin-ui";

const props: MarkdownProps = { source: "# Notes", basePath: "/repo/notes/", fontSize: "lg" };
export const view = createElement(Markdown, props);

// @ts-expect-error fontSize is a rung of the type scale
export const badSize = createElement(Markdown, { source: "x", fontSize: "huge" });

// @ts-expect-error source is required
export const noSource = createElement(Markdown, {});

export const version: string = PLUGIN_UI_VERSION;

const branch: IconName = "git-branch";
export const icon = createElement(Icon, { name: branch, size: 14 });
// @ts-expect-error icon names are a closed set
export const badIcon = createElement(Icon, { name: "not-an-icon" });

export const button = createElement(Button, { variant: "ghost", icon: "play", "data-testid": "go" });
// @ts-expect-error icon strings are names, not text
export const badButtonIcon = createElement(Button, { icon: "not-an-icon" });
// @ts-expect-error variants are a closed set
export const badButton = createElement(Button, { variant: "rainbow" });

export const select = createElement(Select, {
  options: [{ value: "a", label: "A" }, { label: "Group", options: [{ value: "b", label: "B" }] }],
  onValueChange: (value: string) => void value,
});

const items: DropdownMenuEntry[] = [
  { label: "Rename", onSelect: () => {}, icon: "pencil" },
  { type: "separator" },
  { type: "checkbox", label: "Wrap", checked: true, onCheckedChange: (next: boolean) => void next },
];
export const menu = createElement(DropdownMenu, { trigger: button, items });

// @ts-expect-error an icon-only CopyButton needs an aria-label
export const unnamedCopy = createElement(CopyButton, { text: "x" });
export const labelledCopy = createElement(CopyButton, { text: "x", label: "Copy path" });

// @ts-expect-error title is required
export const untitled = createElement(EmptyState, {});

export function useAccent(): string {
  const theme: DaintreeTheme = useDaintreeTheme();
  const mode: "dark" | "light" = theme.colorMode;
  void mode;
  return theme.tokens["accent-primary"];
}
// @ts-expect-error token keys are a closed set
export const badToken = getDaintreeTheme().tokens["accent-nope"];
export const stop: () => void = onDidChangeDaintreeTheme((theme) => void theme.themeId);

interface Issue { id: number; title: string; }
const issues: Issue[] = [{ id: 1, title: "Crash" }];

export const list = createElement(VirtualList<Issue>, {
  items: issues,
  "aria-label": "Issues",
  itemKey: (_index, issue) => issue?.id ?? 0,
  renderItem: (_index, issue) => issue?.title,
});
// @ts-expect-error a list needs an accessible name
export const unnamedList = createElement(VirtualList, { count: 3, renderItem: () => null });
// @ts-expect-error rows are typed through the generic
export const badRow = createElement(VirtualList<Issue>, { items: issues, "aria-label": "x", renderItem: (_i, issue) => issue?.missing });

const columns: DataTableColumn<Issue>[] = [
  { id: "title", header: "Title", sortable: true, render: (issue) => issue.title },
  { id: "id", header: "#", width: 64, align: "end" },
];
export const table = createElement(DataTable<Issue>, {
  "aria-label": "Issues",
  rows: issues,
  rowKey: (issue) => issue.id,
  columns,
  sort: { columnId: "title", direction: "asc" },
  onSortChange: (next: DataTableSort) => void next.direction,
  onRowClick: (issue) => void issue.title,
});
export const keyedTable = createElement(DataTable<Issue>, { "aria-label": "x", rows: issues, rowKey: "id", columns });
// @ts-expect-error sort directions are a closed set
export const badSort: DataTableSort = { columnId: "title", direction: "up" };

const entry: LogEntry = { text: "failed", severity: "error" };
export const log = createElement(LogView, { lines: ["one", entry], maxLines: 2000, "aria-label": "Output" });
// @ts-expect-error severities are a closed set
export const badEntry: LogEntry = { text: "x", severity: "fatal" };

export const header = createElement(PaneHeader, {
  title: "Issues",
  icon: "list",
  actions: createElement(Toolbar, { "aria-label": "Actions" }, createElement(ToolbarButton, { icon: "refresh", "aria-label": "Refresh" })),
});
export const loading = createElement(PaneState, { kind: "loading", title: "Loading issues" });
export const failed = createElement(PaneState, { kind: "error", title: "Failed", onRetry: () => {} });
// @ts-expect-error pane state kinds are a closed set
export const badState = createElement(PaneState, { kind: "sad", title: "x" });

export const form = createElement(FormField, { label: "Title", error: "Required", children: createElement(Input, {}) });
export const toggle = createElement(Switch, { checked: true, onCheckedChange: (next: boolean) => void next, "aria-label": "On" });
export const tabs = createElement(Tabs, {
  "aria-label": "Views",
  items: [{ value: "a", label: "A", badge: 3 }],
  value: "a",
  onValueChange: (next: string) => void next,
  children: (value: string) => value,
});
export const progress = createElement(ProgressBar, { value: 0.5, label: "Indexing" });
// @ts-expect-error a progress bar needs a label
export const unnamedProgress = createElement(ProgressBar, { value: 0.5 });

export const settings = createElement(
  SettingsSection,
  { title: "Sync" },
  createElement(
    SettingsGroup,
    null,
    createElement(SettingsRow, {
      label: "Auto refresh",
      control: (ids) => createElement(Switch, { "aria-labelledby": ids.labelId, disabled: ids.disabled }),
    }),
    createElement(SettingsActions, { status: "Saved" })
  )
);

export function Picker() {
  const nav = useListNavigation({ count: issues.length, onSelect: (index: number) => void index });
  const index: number = nav.activeIndex;
  return createElement(ListRow, { ...nav.getRowProps(index), title: "Crash", meta: formatTimeAgo(Date.now()) });
}

const severity: Severity = "danger";
export const glyph = createElement(SeverityIcon, { severity, size: 12 });
export const labels: string[] = [
  formatTimeAgo("2026-01-01T00:00:00Z"),
  formatRelativeTime(new Date()),
  formatBytes(1024),
  formatCount(12_345),
  formatDuration(90_000),
];

// Avatars, popovers and hints.
import * as ui from "@daintreehq/plugin-ui";

export const ready: Promise<void> = ui.whenPluginUiReady();
ui.preloadPluginUi();
export const avatar = createElement(ui.Avatar, { name: "Ada Lovelace", src: "", size: "md" });
// @ts-expect-error an avatar needs a name
export const namelessAvatar = createElement(ui.Avatar, { src: "x" });
export const popover = createElement(ui.Popover, {
  trigger: createElement(ui.Button, {}, "Filter"),
  width: "trigger",
  padding: "none",
  children: createElement(ui.PopoverSearchField, { value: "", "aria-label": "Search" }),
});
// @ts-expect-error popover widths are a closed set
export const badPopover = createElement(ui.Popover, { trigger: createElement("button"), width: "huge" });
export const hint = createElement(ui.SkeletonHint, { message: "Fetching", onCancel: () => {} });
export const pill = createElement(ui.Button, { variant: "pill" });
export const date = createElement(ui.Input, { type: "date", value: "2026-09-30" });
export const compactKey = createElement(ui.Kbd, { density: "compact", children: "K" });
export const cleared = createElement(ui.Select, { options: [], value: null, placeholder: "Pick" });
export const iconOption: ui.SelectOption = { value: "a", label: "A", icon: "git-branch" };
export const strip = createElement(ui.Callout, {
  severity: "error",
  variant: "strip",
  title: "Couldn't load",
  role: "alert",
  "data-testid": "banner",
  onDismiss: () => {},
  actionPlacement: "below",
});
export const shadowed = createElement(ui.ScrollShadow, { role: "listbox", id: "rows", children: "x" });
export const shadowList = createElement(ui.VirtualList, { count: 1, "aria-label": "x", shadows: true, renderItem: () => null });
const sortMenu: ui.DropdownMenuEntry = {
  type: "radio-group",
  value: "a",
  onValueChange: (next: string) => void next,
  items: [{ value: "a", label: "A" }],
};
export const menu12 = createElement(ui.DropdownMenu, {
  trigger: createElement("button"),
  items: [sortMenu],
  stopPropagation: true,
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
});
const layer: ui.DialogLayer = "nested";
export const dialog12 = createElement(ui.Dialog, {
  open: true,
  onClose: () => {},
  title: "Create",
  icon: createElement(ui.Spinner, {}),
  layer,
  footer: createElement(ui.Button, {}, "Done"),
  "data-testid": "bulk",
  primaryAction: { label: "Go", onClick: () => {}, icon: "check", disabled: true, disabledReason: "Nothing picked" },
});
// @ts-expect-error layers are a closed set
export const badLayer: ui.DialogLayer = "top";
export const confirm12 = createElement(ui.ConfirmDialog, {
  open: true,
  onClose: () => {},
  onConfirm: () => {},
  title: "Reset?",
  confirmLabel: "Reset",
  hint: "Now",
  layer: "nested",
});
export const copy12 = createElement(ui.CopyButton, { text: "x", "aria-label": "Copy", announcement: "Path copied" });
export const truncated = createElement(ui.TruncatedTooltip, { content: "x", isTruncated: true, children: createElement("span") });
export const bone = createElement(ui.SkeletonBone, { immediate: true });
const newIcon: ui.IconName = "user-plus";
export const newIcons = createElement(ui.Icon, { name: newIcon });

// File trees, stat cards, sparklines and field groups.
const walked: ui.FileTreeEntry[] = [{ path: "src/a.ts", type: "file" }, { path: "src", type: "dir" }];
export const tree = createElement(ui.FileTree, {
  entries: walked,
  "aria-label": "Files",
  selectedPath: "src/a.ts",
  onSelect: (path: string, item: ui.FileTreeItem) => void [path, item.type, item.depth],
  expandedPaths: ["src"],
  onExpandedPathsChange: (paths: string[]) => void paths,
  onActivate: (path: string) => void path,
  sort: "natural",
});
const nested: ui.FileTreeNode[] = [{ name: "src", children: [{ name: "a.ts" }] }];
export const nestedTree = createElement(ui.FileTree, { nodes: nested, "aria-label": "Files" });
// @ts-expect-error a tree needs an aria-label
export const unnamedTree = createElement(ui.FileTree, { entries: walked });
// @ts-expect-error sort orders are a closed set
export const badSort = createElement(ui.FileTree, { entries: walked, "aria-label": "Files", sort: "size" });
export const stat = createElement(ui.StatCard, { label: "Changed files", value: 43, delta: -2, tone: "warning", hint: "2 worktrees" });
// @ts-expect-error a stat needs a value
export const noValue = createElement(ui.StatCard, { label: "Changed files" });
export const spark = createElement(ui.Sparkline, { values: [1, 2, 3], "aria-label": "Events", height: 32, tone: "info", min: 0 });
// @ts-expect-error a sparkline needs an aria-label
export const unnamedSpark = createElement(ui.Sparkline, { values: [1, 2] });
export const group = createElement(ui.FormFieldGroup, { label: "Labels", layout: "inline", required: true }, createElement(ui.Checkbox, {}));
export const startMarkdown = createElement(ui.Markdown, { source: "x", align: "start" });
// @ts-expect-error alignments are a closed set
export const badAlign = createElement(ui.Markdown, { source: "x", align: "right" });
const growColumn: ui.DataTableColumn<{ id: string }> = { id: "id", header: "Id", grow: true };
void growColumn;

// Filter chips, highlighted matches, diff stats, avatar groups, meters and timelines.
export const chip = createElement(ui.FilterChip, { selected: true, onSelectedChange: (next: boolean) => void next, count: 3 }, "Open");
export const appliedChip = createElement(ui.FilterChip, { onRemove: () => {}, removeLabel: "Remove status filter", "data-testid": "status" }, "Status: Open");
// @ts-expect-error a chip's pressed state is \`selected\`, never raw aria-pressed
export const rawPressedChip = createElement(ui.FilterChip, { "aria-pressed": true });
export const highlighted = createElement(ui.HighlightedText, { text: "README.md", query: "read" });
export const ranged = createElement(ui.HighlightedText, { text: "README.md", ranges: [[0, 2]] });
// @ts-expect-error highlighted text needs its text
export const noText = createElement(ui.HighlightedText, { query: "read" });
export const churn = createElement(ui.DiffStat, { additions: 12, deletions: 3, "data-testid": "churn" });
const reviewers: ui.AvatarGroupItem[] = [{ name: "Ada Lovelace", src: "https://example.com/a.png" }, { name: "dependabot", shape: "square" }];
export const avatars = createElement(ui.AvatarGroup, { avatars: reviewers, max: 3, size: "md", "aria-label": "Reviewers" });
// @ts-expect-error avatar sizes are a closed set
export const badAvatars = createElement(ui.AvatarGroup, { avatars: reviewers, size: "xl" });
const limits: ui.MeterThresholds = { warning: 0.8, danger: 0.95 };
export const meter = createElement(ui.Meter, { value: 812, max: 1000, label: "API requests", valueText: "812 of 1,000", thresholds: limits, showLabel: false });
// @ts-expect-error a meter needs a label
export const unnamedMeter = createElement(ui.Meter, { value: 0.4 });
// @ts-expect-error a meter needs a value
export const emptyMeter = createElement(ui.Meter, { label: "Disk" });
interface Comment extends ui.TimelineItem { body: string }
const comments: Comment[] = [{ id: 1, title: "commented", actor: { name: "Ada" }, timestamp: Date.now(), body: "LGTM", tone: "info" }];
export const timeline = createElement(ui.Timeline<Comment>, {
  items: comments,
  "aria-label": "Activity",
  renderContent: (item: Comment) => createElement(ui.Markdown, { source: item.body }),
  groupByDay: true,
  timeFormat: "verbose",
  onEndReached: (lastIndex: number) => void lastIndex,
});
// @ts-expect-error a timeline needs an aria-label
export const unnamedTimeline = createElement(ui.Timeline, { items: comments });
// @ts-expect-error time formats are a closed set
export const badTimeFormat = createElement(ui.Timeline, { items: comments, "aria-label": "Activity", timeFormat: "long" });
// Calendars, date fields and live ages.
export const calendar = createElement(ui.Calendar, {
  value: "2026-09-30",
  onValueChange: (day: string) => void day,
  min: "2026-01-01",
  isDateDisabled: (day: ui.IsoDate) => day.endsWith("-01"),
  numberOfMonths: 2,
  weekStartsOn: 1,
});
const pickedRange: ui.DateRange = { start: "2026-09-01", end: "2026-09-30" };
export const rangeCalendar = createElement(ui.Calendar, {
  mode: "range",
  value: pickedRange,
  onValueChange: (range: ui.DateRange) => void range.end,
  month: "2026-09",
  onMonthChange: (month: string) => void month,
});
// @ts-expect-error a range calendar's value is a range
export const rangeWithDay = createElement(ui.Calendar, { mode: "range", value: "2026-09-30" });
// @ts-expect-error a single calendar's value is a day
export const dayWithRange = createElement(ui.Calendar, { value: pickedRange });
// @ts-expect-error weeks start on a weekday 0-6
export const badWeekStart = createElement(ui.Calendar, { weekStartsOn: 7 });
export const picker = createElement(ui.DatePicker, {
  value: null,
  onValueChange: (day: string | null) => void day,
  "aria-label": "Due date",
  clearable: false,
  density: "compact",
  name: "due",
});
const lastWeek: ui.DateRangePreset = { label: "Last 7 days", range: pickedRange };
export const rangePicker = createElement(ui.DateRangePicker, {
  value: pickedRange,
  onValueChange: (range: ui.DateRange | null) => void range,
  presets: [lastWeek],
  "aria-labelledby": "when",
});
// @ts-expect-error densities are a closed set
export const badPickerDensity = createElement(ui.DatePicker, { density: "large" });
export const ago = createElement(ui.TimeAgo, { value: Date.now(), verbose: true, prefix: "Updated ", tooltip: false, "data-testid": "age" });
export const agoFromDate = createElement(ui.TimeAgo, { value: new Date() });
// @ts-expect-error a TimeAgo needs a value
export const agoNoValue = createElement(ui.TimeAgo, {});
// Context menus, sheets, command palettes, breadcrumbs, nav lists and steppers.
export const contextMenu = createElement(ui.ContextMenu, {
  items: [{ label: "Rename", onSelect: () => {}, shortcut: "F2" }, { type: "separator" }],
  onOpenChange: (open: boolean) => void open,
  stopPropagation: true,
  children: createElement("div"),
});
// @ts-expect-error a context menu needs the surface it belongs to
export const surfaceless = createElement(ui.ContextMenu, { items: [] });
export const sheet = createElement(ui.Sheet, {
  open: true,
  onOpenChange: (open: boolean) => void open,
  title: "Issue #12",
  side: "left",
  size: "xl",
  primaryAction: { label: "Save", onClick: () => {} },
  layer: "nested",
});
// @ts-expect-error a sheet opens against the left or right edge
export const topSheet = createElement(ui.Sheet, { open: true, onOpenChange: () => {}, title: "x", side: "top" });
const commands: ui.CommandPaletteItem[] = [
  { id: "a", label: "Alpha", description: "First", icon: "file", keywords: ["one"], shortcut: "Cmd+1", group: "Files", disabled: false },
];
export const palette = createElement(ui.CommandPalette, {
  open: true,
  onOpenChange: () => {},
  items: commands,
  onSelect: (item: ui.CommandPaletteItem) => void item.id,
  title: "Go to file",
  onQueryChange: (query: string) => void query,
  filter: false,
  loading: true,
  emptyText: "No files yet",
  actionLabel: "Open file",
});
// @ts-expect-error a palette needs a title
export const untitledPalette = createElement(ui.CommandPalette, { open: true, onOpenChange: () => {}, items: commands, onSelect: () => {} });
const trail: ui.BreadcrumbItem[] = [{ label: "Projects", onSelect: () => {}, icon: "folder" }, { label: "Daintree" }];
export const crumbs = createElement(ui.Breadcrumbs, { items: trail, maxItems: 3, "data-testid": "trail" });
const sections: ui.NavListSection[] = [
  { label: "Views", items: [{ id: "inbox", label: "Inbox", icon: "inbox", count: 3, children: [{ id: "starred", label: "Starred" }] }] },
];
export const nav = createElement(ui.NavList, { sections, value: "inbox", onValueChange: (id: string) => void id, "aria-label": "Sections" });
const flatNav: ui.NavListItem[] = [{ id: "a", label: "A", badge: "New", disabled: true }];
export const flatNavList = createElement(ui.NavList, { items: flatNav, defaultValue: "a", "aria-label": "Sections" });
// @ts-expect-error a nav list needs an aria-label
export const unnamedNav = createElement(ui.NavList, { items: flatNav });
const steps: ui.StepperStep[] = [{ id: "a", label: "Details", description: "Name it" }, { id: "b", label: "Review", state: "error" }];
export const stepper = createElement(ui.Stepper, { steps, current: "b", orientation: "vertical", onStepSelect: (id: string) => void id });
// @ts-expect-error step states are a closed set
export const badStep: ui.StepState = "skipped";
// @ts-expect-error a stepper needs its current step
export const noCurrent = createElement(ui.Stepper, { steps });

// Root attributes: \`id\` and \`data-*\` everywhere, \`aria-*\` where the root is the control.
export const selectId = createElement(ui.Select, { options: [], "aria-label": "Pick", "data-testid": "pick" });
export const segmentedId = createElement(ui.SegmentedControl, { options: [], value: "", onValueChange: () => {}, "aria-label": "Mode", "data-testid": "mode", "aria-describedby": "hint" });
export const emptyId = createElement(ui.EmptyState, { title: "None", id: "empty", "data-testid": "empty" });
export const logId = createElement(ui.LogView, { lines: [], "aria-label": "Log", "data-testid": "log" });
export const progressId = createElement(ui.ProgressBar, { label: "Build", "data-testid": "build", "aria-describedby": "hint" });
export const copyId = createElement(ui.CopyButton, { text: "x", "aria-label": "Copy", "data-testid": "copy" });
export const labelledCopyId = createElement(ui.CopyButton, { text: "x", label: "Copy path", "data-testid": "copy-path" });
// @ts-expect-error an EmptyState's root is not the control; it takes no aria-*
export const emptyAria = createElement(ui.EmptyState, { title: "None", "aria-describedby": "hint" });
`;

let consumerDir: string;

beforeAll(async () => {
  consumerDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-ui-")));
  await fs.mkdir(path.join(consumerDir, "node_modules", "@daintreehq"), { recursive: true });
  // Installed the way npm would: the package directory itself, with its real
  // package.json exports deciding what `@daintreehq/plugin-sdk/plugin-ui` means.
  await fs.symlink(sdkDir, path.join(consumerDir, "node_modules", "@daintreehq", "plugin-sdk"));
  await fs.mkdir(path.join(consumerDir, "node_modules", "@types"), { recursive: true });
  const reactTypes = path.dirname(
    createRequire(import.meta.url).resolve("@types/react/package.json")
  );
  await fs.symlink(reactTypes, path.join(consumerDir, "node_modules", "@types", "react"));
  await fs.writeFile(path.join(consumerDir, "view.ts"), CONSUMER);
});

afterAll(async () => {
  await fs.rm(consumerDir, { recursive: true, force: true });
});

/**
 * Compile the consumer as if `tsc` ran in its directory. The `types` option
 * resolves from the current directory, which would otherwise be this repo and
 * its own install of the SDK.
 */
function compileConsumer(options: ts.CompilerOptions): string[] {
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => consumerDir;
  const file = path.join(consumerDir, "view.ts");
  const program = ts.createProgram([file], options, host);
  const view = program.getSourceFile(file);
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(view),
    ...program.getSemanticDiagnostics(view),
  ].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("@daintreehq/plugin-sdk/plugin-ui", () => {
  it("is exported from the package and shipped in its files", () => {
    const manifest = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(manifest.exports["./plugin-ui"]).toEqual({ types: "./plugin-ui.d.ts" });
    expect(manifest.files).toContain("plugin-ui.d.ts");
  });

  it("types a view importing @daintreehq/plugin-ui through compilerOptions.types", () => {
    const diagnostics = compileConsumer({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["@daintreehq/plugin-sdk/plugin-ui"],
      // `dist/` only exists after a build, so the declaration's own import of
      // the SDK's props type is pointed at source; everything else resolves as
      // it would for an author.
      paths: { "@daintreehq/plugin-sdk/react": [path.join(sdkDir, "src/react.ts")] },
    });
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("is what makes the import resolve", () => {
    const messages = compileConsumer({
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    expect(messages.some((m) => m.includes("'@daintreehq/plugin-ui'"))).toBe(true);
  }, 60_000);
});
