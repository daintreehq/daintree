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
  formatIsoDate,
  isoAddDays,
  isoFromDate,
  isoToday,
  type DataTableColumn,
  type DataTableSort,
  type VirtualListProps,
  type VirtualListItemsProps,
  type VirtualListCountProps,
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
// With \`items\` a row is handed its item, never \`undefined\`.
export const itemsList = createElement(VirtualList<Issue>, {
  items: issues,
  "aria-label": "Issues",
  itemKey: (_index, issue) => issue.id,
  renderItem: (_index, issue) => issue.title,
});
// A \`count\` list reads its rows by index.
export const countList = createElement(VirtualList, {
  count: 3,
  "aria-label": "Rows",
  renderItem: (index) => index,
});
export const countProps: VirtualListCountProps = {
  count: 3,
  "aria-label": "Rows",
  renderItem: (_index, item) => {
    const none: undefined = item;
    return none;
  },
};
// A wrapper forwarding the general props still compiles.
export const forwarded = (props: VirtualListProps<Issue>) => createElement(VirtualList, props);
export const narrowed = (props: VirtualListItemsProps<Issue>) => createElement(VirtualList<Issue>, props);

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
const today: string = isoToday();
export const days: (string | null)[] = [isoAddDays(today, -29), isoFromDate(new Date()), isoFromDate(0)];
export const dayLabels: string[] = [formatIsoDate(today), formatIsoDate(today, "full")];
// @ts-expect-error a shifted day can be null for a bad input
export const unchecked: string = isoAddDays(today, 1);
// @ts-expect-error the styles are short, long and full
export const badStyle = formatIsoDate(today, "medium");

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
export const percentStat = createElement(ui.StatCard, { label: "MRR", value: "$25,901", delta: 12.5, formatDelta: (n) => n.toFixed(1) + "%" });
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
// Layout
export const card = createElement(ui.Card, { title: "Deploy", description: "Production", actions: createElement(ui.Button, {}, "Redeploy"), footer: "5m ago", variant: "inset", padding: "none", "data-testid": "card" }, "Body");
export const clickCard = createElement(ui.Card, { title: "Open", onClick: () => {}, disabled: false });
// @ts-expect-error a clickable card is one button, so it takes no actions
export const clickCardActions = createElement(ui.Card, { title: "Open", onClick: () => {}, actions: "x" });
// @ts-expect-error card variants are a closed set
export const badCardVariant = createElement(ui.Card, { variant: "elevated" });
export const divider = createElement(ui.Divider, { orientation: "vertical" });
export const labelledDivider = createElement(ui.Divider, { label: "Older" });
export const sectionLabel = createElement(ui.SectionLabel, { variant: "list", as: "div" }, "Recent");
// @ts-expect-error a section label is a heading or a div
export const badSectionTag = createElement(ui.SectionLabel, { as: "span" }, "x");
export const split = createElement(ui.ResizableSplit, { first: "a", second: "b", "aria-label": "Resize list", orientation: "vertical", sizedPane: "second", size: 240, onSizeChange: (size: number) => void size, minSize: 120, maxSize: 480, collapsible: true, collapsed: false, onCollapsedChange: (collapsed: boolean) => void collapsed });
// @ts-expect-error a split's divider needs an aria-label
export const unnamedSplit = createElement(ui.ResizableSplit, { first: "a", second: "b" });
const accordionItems: ui.AccordionItem[] = [{ value: "a", title: "General", content: "x", trailing: 3, disabled: false }];
export const accordion = createElement(ui.Accordion, { items: accordionItems, type: "multiple", value: ["a"], onValueChange: (value: string[]) => void value, headingLevel: 4 });
// @ts-expect-error accordion modes are a closed set
export const badAccordion = createElement(ui.Accordion, { items: accordionItems, type: "some" });
// @ts-expect-error heading levels run 2 to 6
export const badLevel = createElement(ui.Accordion, { items: accordionItems, headingLevel: 1 });
export const disclosure = createElement(ui.Disclosure, { title: "Details", open: true, onOpenChange: (open: boolean) => void open }, "Body");
// @ts-expect-error a disclosure needs a title
export const untitledDisclosure = createElement(ui.Disclosure, {}, "Body");
const rows: ui.DescriptionItem[] = [{ label: "Branch", value: "main", hint: "origin", copyText: "main" }];
export const details = createElement(ui.DescriptionList, { items: rows, layout: "stacked", copyable: true });
export const detailChildren = createElement(ui.DescriptionList, {}, createElement(ui.DescriptionListItem, { label: "Path", value: "/tmp" }));
// @ts-expect-error description layouts are a closed set
export const badDetails = createElement(ui.DescriptionList, { items: rows, layout: "grid" });

// Radio groups, numbers, sliders, pickers, tags, file drops and emoji.
const radioOptions: ui.RadioOption[] = [{ value: "merge", label: "Merge", description: "Keeps history" }];
export const radios = createElement(ui.RadioGroup, { options: radioOptions, value: null, onValueChange: (v: string) => void v, orientation: "horizontal", variant: "plain", "aria-label": "Method" });
// @ts-expect-error orientations are a closed set
export const badRadios = createElement(ui.RadioGroup, { options: radioOptions, orientation: "grid" });
export const number = createElement(ui.NumberInput, { value: null, onValueChange: (v: number | null) => void v, min: 0, max: 10, step: 0.5, precision: 1, unit: "s", stepper: false, "aria-label": "Delay" });
// @ts-expect-error a NumberInput's value is a number
export const textNumber = createElement(ui.NumberInput, { value: "3" });
export const slider = createElement(ui.Slider, { value: 40, onValueCommit: (v: number) => void v, formatValue: (v: number) => \`\${v}%\`, showValue: true, "aria-label": "Opacity" });
export const combo = createElement(ui.Combobox, { options: [{ value: "a", label: "A" }], value: null, onSearchChange: (q: string) => void q, filter: "none", loading: true, allowCustomValue: true, "aria-label": "Pick" });
// @ts-expect-error filters are a closed set
export const badCombo = createElement(ui.Combobox, { options: [], filter: "fuzzy" });
export const multi = createElement(ui.MultiSelect, { options: [], value: ["a"], onValueChange: (v: string[]) => void v, max: 3, maxChips: 2, "aria-label": "Labels" });
// @ts-expect-error a MultiSelect's value is a list
export const singleMulti = createElement(ui.MultiSelect, { options: [], value: "a" });
export const tags = createElement(ui.TagInput, { defaultValue: ["a"], validate: (tag: string) => tag.length > 1, "aria-label": "Tags" });
export const drop = createElement(ui.FileDropzone, { onFiles: (files: File[]) => void files, accept: ".md", multiple: true, icon: "upload" });
// @ts-expect-error a FileDropzone needs onFiles
export const deafDrop = createElement(ui.FileDropzone, { accept: ".md" });
export const emoji = createElement(ui.EmojiPicker, { trigger: createElement(ui.Button, {}, "Icon"), onSelect: (e: string) => void e, value: "🙂" });
// @ts-expect-error an EmojiPicker needs a trigger
export const noTrigger = createElement(ui.EmojiPicker, { onSelect: () => {} });

// Charts.
const chartRows = [{ day: "Mon", passed: 12, failed: 1 }, { day: "Tue", passed: 9, failed: 3 }];
const chartSeries: ui.ChartSeries[] = [{ key: "passed", label: "Passed" }, { key: "failed", label: "Failed", color: "orange" }];
export const bars = createElement(ui.BarChart, {
  data: chartRows,
  x: "day",
  series: chartSeries,
  "aria-label": "Builds per day",
  mode: "stacked",
  orientation: "horizontal",
  height: 160,
  formatValue: (value: number) => String(value) + " builds",
  formatX: (value: unknown) => String(value),
  xLabel: "Day",
  loading: false,
  empty: "Nothing yet",
  "data-testid": "bars",
});
// @ts-expect-error a chart needs an aria-label
export const unnamedBars = createElement(ui.BarChart, { data: chartRows, x: "day", series: chartSeries });
// @ts-expect-error bar modes are a closed set
export const badMode = createElement(ui.BarChart, { data: chartRows, x: "day", series: chartSeries, "aria-label": "B", mode: "overlap" });
// @ts-expect-error chart colours are a closed set
export const badColor = createElement(ui.BarChart, { data: chartRows, x: "day", series: [{ key: "a", label: "A", color: "red" }], "aria-label": "B" });
export const lines = createElement(ui.LineChart, {
  data: [{ at: new Date(), p50: 120, p95: 340 }],
  x: "at",
  series: [{ key: "p50", label: "p50" }, { key: "p95", label: "p95", color: "neutral" }],
  "aria-label": "Latency",
  xType: "time",
  area: true,
  curve: "monotone",
  formatX: (value: number) => new Date(value).toISOString(),
});
// @ts-expect-error curves are a closed set
export const badCurve = createElement(ui.LineChart, { data: [], x: "at", series: [], "aria-label": "L", curve: "step" });
export const donut = createElement(ui.DonutChart, {
  data: [{ lang: "TypeScript", files: 420 }],
  x: "lang",
  value: "files",
  "aria-label": "Files by language",
  centerLabel: "files",
  centerValue: "420",
  otherLabel: "Everything else",
});
// @ts-expect-error a donut needs its value key
export const noValueKey = createElement(ui.DonutChart, { data: [], x: "lang", "aria-label": "Files" });

// Drag and drop.
interface Todo { id: string; title: string; done: boolean }
const todos: Todo[] = [{ id: "a", title: "Ship", done: false }];
export const sortable = createElement(ui.SortableList<Todo>, { items: todos, getId: (todo: Todo) => todo.id, renderItem: (todo: Todo, state: ui.SortableItemState) => \`\${todo.title} \${state.index}\`, onReorder: (from: number, to: number) => void [from, to], onChange: (next: Todo[]) => void next, "aria-label": "Todos", orientation: "horizontal", handle: true, isItemDisabled: (todo: Todo) => todo.done, getItemLabel: (todo: Todo) => todo.title });
// @ts-expect-error a sortable list needs an aria-label
export const unnamedSortable = createElement(ui.SortableList<Todo>, { items: todos, renderItem: (todo: Todo) => todo.title });
// @ts-expect-error orientations are a closed set
export const diagonalSortable = createElement(ui.SortableList<Todo>, { items: todos, renderItem: () => null, "aria-label": "x", orientation: "diagonal" });
const kanbanColumns: ui.KanbanColumn[] = [{ id: "todo", title: "To do", limit: 3, empty: "Nothing yet" }];
export const kanban = createElement(ui.Kanban<Todo>, { columns: kanbanColumns, cards: { todo: todos }, getCardId: (todo: Todo) => todo.id, renderCard: (todo: Todo, state: ui.KanbanCardState) => \`\${todo.title} in \${state.columnId}\`, onMove: (move: ui.KanbanMove) => void move.toColumn, "aria-label": "Board", collapsible: true, defaultCollapsedColumns: ["todo"], onCollapsedColumnsChange: (ids: string[]) => void ids, columnActions: (column: ui.KanbanColumn) => column.title, columnWidth: 300 });
// @ts-expect-error a column id is a string
export const numericColumn = createElement(ui.Kanban<Todo>, { columns: [{ id: 1, title: "x" }], cards: {}, renderCard: () => null, "aria-label": "x" });
export const provider = createElement(ui.DragDropProvider, { onDragEnd: (event: ui.DragEvent) => void event.overId, renderOverlay: (id: ui.DragId) => String(id), getLabel: (id: ui.DragId) => String(id) });
export function DraggableRow() {
  const drag: ui.DraggableState = ui.useDraggable({ id: 1 });
  const drop: ui.DroppableState = ui.useDroppable({ id: "bin", disabled: false });
  // @ts-expect-error a drag id is a string or number
  ui.useDraggable({ id: {} });
  return createElement("div", { ref: drag.ref, style: drag.style }, createElement("span", drag.handleProps), String(drop.isOver));
}

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

// Layout core: stacks, grids, the pane shell, status strips, two-axis scrollers,
// the folding toolbar and the container hooks.
export const stack = createElement(ui.Stack, { gap: "lg", align: "stretch", justify: "between", as: "section", role: "group", "data-testid": "s" }, "a");
// @ts-expect-error gaps are the kit's scale, not px
export const pxStack = createElement(ui.Stack, { gap: 12 }, "a");
export const inline = createElement(ui.Inline, { gap: "xs", wrap: true, align: "baseline" }, "a");
export const cluster = createElement(ui.Cluster, { as: "ul", gap: "sm" }, "a");
// @ts-expect-error a layout renders as a closed set of elements
export const scriptStack = createElement(ui.Stack, { as: "script" }, "a");
export const grid = createElement(ui.Grid, { columns: 3, gap: "md" }, "a");
export const templateGrid = createElement(ui.Grid, { columns: "200px 1fr" }, "a");
export const autoGrid = createElement(ui.AutoGrid, { minColumnWidth: 180, maxColumns: 4, stretch: true }, "a");
export const pane = createElement(ui.PaneLayout, { header: "h", toolbar: "t", footer: "f", statusBar: "s", scroll: "none", padding: "md", bodyLabel: "Body", bodyRef: { current: null } }, "body");
// @ts-expect-error scroll modes are a closed set
export const badPane = createElement(ui.PaneLayout, { scroll: "auto" }, "body");
export const status = createElement(ui.StatusBar, { left: ["12 lines", "3 KB"], center: "x", right: "Saved", density: "comfortable", placement: "top", "aria-label": "File status" });
const overflowItems: ui.OverflowToolbarItem[] = [
  { id: "refresh", label: "Refresh", icon: "refresh", onSelect: () => {}, priority: 2, shortcut: "Cmd+R" },
  { type: "separator" },
  { id: "pin", label: "Pin", icon: "pin", pressed: true, showLabel: true, tooltip: false },
];
export const overflow = createElement(ui.OverflowToolbar, { items: overflowItems, "aria-label": "Actions", variant: "bar", leading: "x", trailing: "y", overflowLabel: "More" });
// @ts-expect-error two toolbars must be told apart
export const unnamedOverflow = createElement(ui.OverflowToolbar, { items: overflowItems });
export const scrollArea = createElement(ui.ScrollArea, { orientation: "both", compact: true, "aria-label": "Cards", tabIndex: 0 }, "x");
// @ts-expect-error orientations are a closed set
export const diagonal = createElement(ui.ScrollArea, { orientation: "diagonal" }, "x");
export function useLayoutHooks(el: HTMLElement | null) {
  const size: ui.ContainerSize = ui.useContainerSize({ current: el });
  const step: "sm" | "md" | "lg" | null = ui.useBreakpoint(el);
  const custom: "narrow" | "wide" | null = ui.useBreakpoint(el, { narrow: 0, wide: 640 });
  return [size.width, step, custom];
}
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
