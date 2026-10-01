// The runtime of `@daintreehq/plugin-ui`, served to plugin views through the
// host import map. Every export here is public contract: vite.config.ts pins
// the names in HOST_FACADE_REQUIRED_EXPORTS and the SDK declares their types in
// packages/plugin-sdk/plugin-ui.d.ts. Nothing here may import app code
// statically; the host components load through `fromKit`.
import { isValidElement, type ComponentType, type ReactNode } from "react";
import type {
  PluginAccordionProps,
  PluginAutoGridProps,
  PluginAvatarGroupProps,
  PluginAvatarProps,
  PluginBadgeProps,
  PluginBarChartProps,
  PluginBreadcrumbsProps,
  PluginButtonProps,
  PluginCalendarProps,
  PluginCalloutProps,
  PluginCardProps,
  PluginCheckboxProps,
  PluginClusterProps,
  PluginComboboxProps,
  PluginCommandPaletteProps,
  PluginConfirmDialogProps,
  PluginConfirmPopoverProps,
  PluginContextMenuProps,
  PluginCopyButtonProps,
  PluginDataTableProps,
  PluginDatePickerProps,
  PluginDateRangePickerProps,
  PluginDescriptionListItemProps,
  PluginDescriptionListProps,
  PluginDialogProps,
  PluginDiffStatProps,
  PluginDisclosureProps,
  PluginDismissButtonProps,
  PluginDividerProps,
  PluginDonutChartProps,
  PluginDragDropProviderProps,
  PluginKanbanProps,
  PluginSortableListProps,
  PluginDropdownMenuProps,
  PluginEmojiPickerProps,
  PluginEmptyStateProps,
  PluginFileDropzoneProps,
  PluginFileTreeProps,
  PluginFilterChipProps,
  PluginFormFieldGroupProps,
  PluginFormFieldProps,
  PluginGridProps,
  PluginHighlightedTextProps,
  PluginIconButtonProps,
  PluginIconProps,
  PluginInlineProps,
  PluginInputProps,
  PluginKbdChordProps,
  PluginKbdProps,
  PluginLineChartProps,
  PluginListRowProps,
  PluginLogViewProps,
  PluginMeterProps,
  PluginMultiSelectProps,
  PluginNavListProps,
  PluginNumberInputProps,
  PluginOverflowToolbarProps,
  PluginPaneHeaderProps,
  PluginPaneLayoutProps,
  PluginPaneStateProps,
  PluginPopoverProps,
  PluginPopoverSearchFieldProps,
  PluginProgressBarProps,
  PluginRadioGroupProps,
  PluginResizableSplitProps,
  PluginScrollAreaProps,
  PluginScrollShadowProps,
  PluginSearchFieldProps,
  PluginSectionLabelProps,
  PluginSegmentedControlProps,
  PluginSelectProps,
  PluginSettingsActionsProps,
  PluginSettingsGroupProps,
  PluginSettingsRowProps,
  PluginSettingsSectionProps,
  PluginSeverityIconProps,
  PluginSheetProps,
  PluginSkeletonBoneProps,
  PluginSkeletonHintProps,
  PluginSkeletonProps,
  PluginSkeletonTextProps,
  PluginSliderProps,
  PluginSparklineProps,
  PluginSpinnerProps,
  PluginSpinningIconProps,
  PluginStackProps,
  PluginStatCardProps,
  PluginStatusBarProps,
  PluginStepperProps,
  PluginSwitchProps,
  PluginTabsProps,
  PluginTagInputProps,
  PluginTextareaProps,
  PluginTimeAgoProps,
  PluginTimelineItem,
  PluginTimelineProps,
  PluginToolbarButtonProps,
  PluginToolbarProps,
  PluginTooltipProps,
  PluginTruncatedTooltipProps,
  PluginVirtualListComponent,
} from "@shared/types/plugin-sdk-react";
import type {
  PluginBulkActionBarProps,
  PluginDrawerProps,
  PluginDrawerToggleProps,
  PluginGroupedVirtualListProps,
  PluginInspectorProps,
  PluginInspectorSectionProps,
  PluginLoadMoreFooterProps,
  PluginMasterDetailProps,
  PluginPropertyRowProps,
  PluginRefreshOverlayProps,
  PluginSplitGroupProps,
  PluginStaleIndicatorProps,
  PluginTaskListProps,
} from "@shared/types/plugin-sdk-react";
import type {
  PluginCodeBlockProps,
  PluginColoredLabelProps,
  PluginCountIndicatorProps,
  PluginHeadingProps,
  PluginInlineCodeProps,
  PluginLinkProps,
  PluginLiveRegionProps,
  PluginPathLabelProps,
  PluginPortalProps,
  PluginStateGlyphProps,
  PluginStatusDotProps,
  PluginTextProps,
  PluginUnreadDotProps,
  PluginVisuallyHiddenProps,
} from "@shared/types/plugin-sdk-react";
import type {
  PluginColorPickerProps,
  PluginColorSwatchProps,
  PluginDateTimePickerProps,
  PluginFormProps,
  PluginFormStatusProps,
  PluginRangeSliderProps,
  PluginSchemaFormProps,
  PluginSplitButtonProps,
  PluginTimePickerProps,
  PluginToggleGroupProps,
  PluginComposerProps,
  PluginInlineEditProps,
  PluginKeyValueEditorProps,
  PluginListEditorProps,
  PluginMentionTextareaProps,
  PluginSecretInputProps,
  PluginShortcutRecorderProps,
} from "@shared/types/plugin-sdk-react";
import { fromKit } from "./kit";

export { preloadPluginUi, whenPluginUiReady } from "./kit";

export { Markdown } from "./Markdown";
export { getDaintreeTheme, onDidChangeDaintreeTheme, useDaintreeTheme } from "./theme";
export { useListNavigation } from "./listNavigation";
export { useDraggable, useDroppable } from "./dnd";
export { useBreakpoint, useContainerSize } from "./containerSize";
export {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatTimeAgo,
} from "./format";
export { formatIsoDate, isoAddDays, isoFromDate, isoToday } from "./dates";

/** The kit's contract version: additive minors, no prop removed within a major. */
export const PLUGIN_UI_VERSION = "1.0.0";

// Tooltips fall back to their trigger, so the control is there from the first
// frame and only the hover card waits on the kit chunk.
const renderTrigger = ({ children }: { children: PluginTooltipProps["children"] }) =>
  isValidElement(children) ? children : null;

export const Button: ComponentType<PluginButtonProps> = fromKit("Button", (kit) => kit.Button);
export const IconButton: ComponentType<PluginIconButtonProps> = fromKit(
  "IconButton",
  (kit) => kit.IconButton
);
export const Tooltip: ComponentType<PluginTooltipProps> = fromKit(
  "Tooltip",
  (kit) => kit.Tooltip,
  renderTrigger
);
export const TruncatedTooltip: ComponentType<PluginTruncatedTooltipProps> = fromKit(
  "TruncatedTooltip",
  (kit) => kit.TruncatedTooltip,
  renderTrigger
);
export const Spinner: ComponentType<PluginSpinnerProps> = fromKit("Spinner", (kit) => kit.Spinner);
export const SpinningIcon: ComponentType<PluginSpinningIconProps> = fromKit(
  "SpinningIcon",
  (kit) => kit.SpinningIcon
);
export const Badge: ComponentType<PluginBadgeProps> = fromKit("Badge", (kit) => kit.Badge);
export const Checkbox: ComponentType<PluginCheckboxProps> = fromKit(
  "Checkbox",
  (kit) => kit.Checkbox
);
export const Input: ComponentType<PluginInputProps> = fromKit("Input", (kit) => kit.Input);
export const Textarea: ComponentType<PluginTextareaProps> = fromKit(
  "Textarea",
  (kit) => kit.Textarea
);
export const Select: ComponentType<PluginSelectProps> = fromKit("Select", (kit) => kit.Select);
export const SegmentedControl: ComponentType<PluginSegmentedControlProps> = fromKit(
  "SegmentedControl",
  (kit) => kit.SegmentedControl
);
export const Kbd: ComponentType<PluginKbdProps> = fromKit("Kbd", (kit) => kit.Kbd);
export const KbdChord: ComponentType<PluginKbdChordProps> = fromKit(
  "KbdChord",
  (kit) => kit.KbdChord
);
export const CopyButton: ComponentType<PluginCopyButtonProps> = fromKit(
  "CopyButton",
  (kit) => kit.CopyButton
);
export const DismissButton: ComponentType<PluginDismissButtonProps> = fromKit(
  "DismissButton",
  (kit) => kit.DismissButton
);
export const Callout: ComponentType<PluginCalloutProps> = fromKit("Callout", (kit) => kit.Callout);
export const EmptyState: ComponentType<PluginEmptyStateProps> = fromKit(
  "EmptyState",
  (kit) => kit.EmptyState
);
export const Skeleton: ComponentType<PluginSkeletonProps> = fromKit(
  "Skeleton",
  (kit) => kit.Skeleton
);
export const SkeletonBone: ComponentType<PluginSkeletonBoneProps> = fromKit(
  "SkeletonBone",
  (kit) => kit.SkeletonBone
);
export const SkeletonText: ComponentType<PluginSkeletonTextProps> = fromKit(
  "SkeletonText",
  (kit) => kit.SkeletonText
);
export const ScrollShadow: ComponentType<PluginScrollShadowProps> = fromKit(
  "ScrollShadow",
  (kit) => kit.ScrollShadow
);
export const SearchField: ComponentType<PluginSearchFieldProps> = fromKit(
  "SearchField",
  (kit) => kit.SearchField
);
export const DropdownMenu: ComponentType<PluginDropdownMenuProps> = fromKit(
  "DropdownMenu",
  (kit) => kit.DropdownMenu
);
export const Dialog: ComponentType<PluginDialogProps> = fromKit("Dialog", (kit) => kit.Dialog);
export const ConfirmDialog: ComponentType<PluginConfirmDialogProps> = fromKit(
  "ConfirmDialog",
  (kit) => kit.ConfirmDialog
);
export const Icon: ComponentType<PluginIconProps> = fromKit("Icon", (kit) => kit.Icon);

// Lists, pane chrome, forms, settings grammar and severity.

// The list components are generic over the row type in the public types; the
// runtime is the same adapter whatever the rows are.
export const VirtualList: PluginVirtualListComponent = fromKit(
  "VirtualList",
  (kit) => kit.VirtualList
);
export const DataTable: <T>(props: PluginDataTableProps<T>) => ReactNode = fromKit(
  "DataTable",
  (kit) => kit.DataTable
);
export const LogView: ComponentType<PluginLogViewProps> = fromKit("LogView", (kit) => kit.LogView);
export const PaneHeader: ComponentType<PluginPaneHeaderProps> = fromKit(
  "PaneHeader",
  (kit) => kit.PaneHeader
);
export const Toolbar: ComponentType<PluginToolbarProps> = fromKit("Toolbar", (kit) => kit.Toolbar);
export const ToolbarButton: ComponentType<PluginToolbarButtonProps> = fromKit(
  "ToolbarButton",
  (kit) => kit.ToolbarButton
);
export const PaneState: ComponentType<PluginPaneStateProps> = fromKit(
  "PaneState",
  (kit) => kit.PaneState
);
export const FormField: ComponentType<PluginFormFieldProps> = fromKit(
  "FormField",
  (kit) => kit.FormField
);
export const Switch: ComponentType<PluginSwitchProps> = fromKit("Switch", (kit) => kit.Switch);
export const Tabs: ComponentType<PluginTabsProps> = fromKit("Tabs", (kit) => kit.Tabs);
export const ProgressBar: ComponentType<PluginProgressBarProps> = fromKit(
  "ProgressBar",
  (kit) => kit.ProgressBar
);
export const SettingsSection: ComponentType<PluginSettingsSectionProps> = fromKit(
  "SettingsSection",
  (kit) => kit.SettingsSection
);
export const SettingsGroup: ComponentType<PluginSettingsGroupProps> = fromKit(
  "SettingsGroup",
  (kit) => kit.SettingsGroup
);
export const SettingsRow: ComponentType<PluginSettingsRowProps> = fromKit(
  "SettingsRow",
  (kit) => kit.SettingsRow
);
export const SettingsActions: ComponentType<PluginSettingsActionsProps> = fromKit(
  "SettingsActions",
  (kit) => kit.SettingsActions
);
export const ListRow: ComponentType<PluginListRowProps> = fromKit("ListRow", (kit) => kit.ListRow);
export const SeverityIcon: ComponentType<PluginSeverityIconProps> = fromKit(
  "SeverityIcon",
  (kit) => kit.SeverityIcon
);

// Avatars, popovers and the long-load hint.

export const Avatar: ComponentType<PluginAvatarProps> = fromKit("Avatar", (kit) => kit.Avatar);
export const Popover: ComponentType<PluginPopoverProps> = fromKit(
  "Popover",
  (kit) => kit.Popover,
  // Like a tooltip, the trigger is there from the first frame.
  ({ trigger }) => (isValidElement(trigger) ? trigger : null)
);
export const PopoverSearchField: ComponentType<PluginPopoverSearchFieldProps> = fromKit(
  "PopoverSearchField",
  (kit) => kit.PopoverSearchField
);
export const SkeletonHint: ComponentType<PluginSkeletonHintProps> = fromKit(
  "SkeletonHint",
  (kit) => kit.SkeletonHint
);

// File trees, stat cards, sparklines and field groups.

export const FileTree: ComponentType<PluginFileTreeProps> = fromKit(
  "FileTree",
  (kit) => kit.FileTree
);
export const StatCard: ComponentType<PluginStatCardProps> = fromKit(
  "StatCard",
  (kit) => kit.StatCard
);
export const Sparkline: ComponentType<PluginSparklineProps> = fromKit(
  "Sparkline",
  (kit) => kit.Sparkline
);
export const FormFieldGroup: ComponentType<PluginFormFieldGroupProps> = fromKit(
  "FormFieldGroup",
  (kit) => kit.FormFieldGroup
);

// Filter chips, highlighted matches, diff stats, avatar groups, meters and timelines.

export const FilterChip: ComponentType<PluginFilterChipProps> = fromKit(
  "FilterChip",
  (kit) => kit.FilterChip
);
export const HighlightedText: ComponentType<PluginHighlightedTextProps> = fromKit(
  "HighlightedText",
  (kit) => kit.HighlightedText
);
export const DiffStat: ComponentType<PluginDiffStatProps> = fromKit(
  "DiffStat",
  (kit) => kit.DiffStat
);
export const AvatarGroup: ComponentType<PluginAvatarGroupProps> = fromKit(
  "AvatarGroup",
  (kit) => kit.AvatarGroup
);
export const Meter: ComponentType<PluginMeterProps> = fromKit("Meter", (kit) => kit.Meter);
// Generic over the entry type in the public types, like the list components.
export const Timeline: <T extends PluginTimelineItem>(props: PluginTimelineProps<T>) => ReactNode =
  fromKit("Timeline", (kit) => kit.Timeline);
// Calendars, date fields and live ages.

export const Calendar: ComponentType<PluginCalendarProps> = fromKit(
  "Calendar",
  (kit) => kit.Calendar
);
export const DatePicker: ComponentType<PluginDatePickerProps> = fromKit(
  "DatePicker",
  (kit) => kit.DatePicker
);
export const DateRangePicker: ComponentType<PluginDateRangePickerProps> = fromKit(
  "DateRangePicker",
  (kit) => kit.DateRangePicker
);
export const TimeAgo: ComponentType<PluginTimeAgoProps> = fromKit("TimeAgo", (kit) => kit.TimeAgo);
// Context menus, sheets, command palettes, breadcrumbs, nav lists and steppers.

export const ContextMenu: ComponentType<PluginContextMenuProps> = fromKit(
  "ContextMenu",
  (kit) => kit.ContextMenu,
  // The surface is there from the first frame; only the menu waits on the kit.
  ({ children }) => (isValidElement(children) ? children : null)
);
export const Sheet: ComponentType<PluginSheetProps> = fromKit("Sheet", (kit) => kit.Sheet);
export const CommandPalette: ComponentType<PluginCommandPaletteProps> = fromKit(
  "CommandPalette",
  (kit) => kit.CommandPalette
);
export const Breadcrumbs: ComponentType<PluginBreadcrumbsProps> = fromKit(
  "Breadcrumbs",
  (kit) => kit.Breadcrumbs
);
export const NavList: ComponentType<PluginNavListProps> = fromKit("NavList", (kit) => kit.NavList);
export const Stepper: ComponentType<PluginStepperProps> = fromKit("Stepper", (kit) => kit.Stepper);
// Cards, dividers, section labels, splits, accordions and description lists.

export const Card: ComponentType<PluginCardProps> = fromKit("Card", (kit) => kit.Card);
export const Divider: ComponentType<PluginDividerProps> = fromKit("Divider", (kit) => kit.Divider);
export const SectionLabel: ComponentType<PluginSectionLabelProps> = fromKit(
  "SectionLabel",
  (kit) => kit.SectionLabel
);
export const ResizableSplit: ComponentType<PluginResizableSplitProps> = fromKit(
  "ResizableSplit",
  (kit) => kit.ResizableSplit
);
export const Accordion: ComponentType<PluginAccordionProps> = fromKit(
  "Accordion",
  (kit) => kit.Accordion
);
export const Disclosure: ComponentType<PluginDisclosureProps> = fromKit(
  "Disclosure",
  (kit) => kit.Disclosure
);
export const DescriptionList: ComponentType<PluginDescriptionListProps> = fromKit(
  "DescriptionList",
  (kit) => kit.DescriptionList
);
export const DescriptionListItem: ComponentType<PluginDescriptionListItemProps> = fromKit(
  "DescriptionListItem",
  (kit) => kit.DescriptionListItem
);

// Radio groups, numbers, sliders, pickers, tags, file drops and emoji.

export const RadioGroup: ComponentType<PluginRadioGroupProps> = fromKit(
  "RadioGroup",
  (kit) => kit.RadioGroup
);
export const NumberInput: ComponentType<PluginNumberInputProps> = fromKit(
  "NumberInput",
  (kit) => kit.NumberInput
);
export const Slider: ComponentType<PluginSliderProps> = fromKit("Slider", (kit) => kit.Slider);
export const Combobox: ComponentType<PluginComboboxProps> = fromKit(
  "Combobox",
  (kit) => kit.Combobox
);
export const MultiSelect: ComponentType<PluginMultiSelectProps> = fromKit(
  "MultiSelect",
  (kit) => kit.MultiSelect
);
export const TagInput: ComponentType<PluginTagInputProps> = fromKit(
  "TagInput",
  (kit) => kit.TagInput
);
export const FileDropzone: ComponentType<PluginFileDropzoneProps> = fromKit(
  "FileDropzone",
  (kit) => kit.FileDropzone
);
export const EmojiPicker: ComponentType<PluginEmojiPickerProps> = fromKit(
  "EmojiPicker",
  (kit) => kit.EmojiPicker,
  // Like a Popover, the trigger is there from the first frame.
  ({ trigger }) => (isValidElement(trigger) ? trigger : null)
);

// Charts.

export const BarChart: ComponentType<PluginBarChartProps> = fromKit(
  "BarChart",
  (kit) => kit.BarChart
);
export const LineChart: ComponentType<PluginLineChartProps> = fromKit(
  "LineChart",
  (kit) => kit.LineChart
);
export const DonutChart: ComponentType<PluginDonutChartProps> = fromKit(
  "DonutChart",
  (kit) => kit.DonutChart
);

// Drag and drop. The hooks live in the facade itself (see ./dnd).

export const DragDropProvider: ComponentType<PluginDragDropProviderProps> = fromKit(
  "DragDropProvider",
  (kit) => kit.DragDropProvider,
  // Until the kit is in, the content is there without drag.
  ({ children }) => children
);
// Generic over the item type in the public types, like the list components.
export const SortableList: <T>(props: PluginSortableListProps<T>) => ReactNode = fromKit(
  "SortableList",
  (kit) => kit.SortableList
);
export const Kanban: <T>(props: PluginKanbanProps<T>) => ReactNode = fromKit(
  "Kanban",
  (kit) => kit.Kanban
);

// Selection, hotkeys, history, disclosure, debouncing, remembered view state,
// toasts and inline confirms.

export { useSelection } from "./selection";
export { useHotkeys } from "./hotkeys";
export { useUndoRedo } from "./undoRedo";
export { useDisclosure } from "./disclosure";
export { useDebouncedCallback, useDebouncedValue } from "./debounce";
export { usePersistentViewState } from "./viewState";
export { useToast } from "./toast";
export const ConfirmPopover: ComponentType<PluginConfirmPopoverProps> = fromKit(
  "ConfirmPopover",
  (kit) => kit.ConfirmPopover,
  // Like a Popover, the trigger is there from the first frame.
  ({ trigger }) => (isValidElement(trigger) ? trigger : null)
);

// Type ramp, inline elements, accessibility helpers and status primitives.

// What the indicators' loading fallbacks may render of untyped children: the
// loaded adapters drop anything else, and so must the frame before them.
const renderableChild = (children: unknown): ReactNode =>
  typeof children === "string" || typeof children === "number" || isValidElement(children)
    ? children
    : null;

export const Text: ComponentType<PluginTextProps> = fromKit("Text", (kit) => kit.Text);
export const Heading: ComponentType<PluginHeadingProps> = fromKit("Heading", (kit) => kit.Heading);
export const Link: ComponentType<PluginLinkProps> = fromKit("Link", (kit) => kit.Link);
export const InlineCode: ComponentType<PluginInlineCodeProps> = fromKit(
  "InlineCode",
  (kit) => kit.InlineCode
);
export const CodeBlock: ComponentType<PluginCodeBlockProps> = fromKit(
  "CodeBlock",
  (kit) => kit.CodeBlock
);
export const PathLabel: ComponentType<PluginPathLabelProps> = fromKit(
  "PathLabel",
  (kit) => kit.PathLabel
);
export const VisuallyHidden: ComponentType<PluginVisuallyHiddenProps> = fromKit(
  "VisuallyHidden",
  (kit) => kit.VisuallyHidden
);
export const LiveRegion: ComponentType<PluginLiveRegionProps> = fromKit(
  "LiveRegion",
  (kit) => kit.LiveRegion
);
export const Portal: ComponentType<PluginPortalProps> = fromKit("Portal", (kit) => kit.Portal);
export const StatusDot: ComponentType<PluginStatusDotProps> = fromKit(
  "StatusDot",
  (kit) => kit.StatusDot
);
export const StateGlyph: ComponentType<PluginStateGlyphProps> = fromKit(
  "StateGlyph",
  (kit) => kit.StateGlyph
);
export const ColoredLabel: ComponentType<PluginColoredLabelProps> = fromKit(
  "ColoredLabel",
  (kit) => kit.ColoredLabel
);
export const UnreadDot: ComponentType<PluginUnreadDotProps> = fromKit(
  "UnreadDot",
  (kit) => kit.UnreadDot,
  // The wrapped element is there from the first frame; only the dot waits.
  ({ children }) => renderableChild(children)
);
export const CountIndicator: ComponentType<PluginCountIndicatorProps> = fromKit(
  "CountIndicator",
  (kit) => kit.CountIndicator,
  ({ children }) => renderableChild(children)
);
export { useAnnounce } from "./announce";

// Stacks, grids, the pane shell, status strips, two-axis scrollers and the
// folding toolbar.

export const Stack: ComponentType<PluginStackProps> = fromKit("Stack", (kit) => kit.Stack);
export const Inline: ComponentType<PluginInlineProps> = fromKit("Inline", (kit) => kit.Inline);
export const Cluster: ComponentType<PluginClusterProps> = fromKit("Cluster", (kit) => kit.Cluster);
export const Grid: ComponentType<PluginGridProps> = fromKit("Grid", (kit) => kit.Grid);
export const AutoGrid: ComponentType<PluginAutoGridProps> = fromKit(
  "AutoGrid",
  (kit) => kit.AutoGrid
);
export const PaneLayout: ComponentType<PluginPaneLayoutProps> = fromKit(
  "PaneLayout",
  (kit) => kit.PaneLayout
);
export const StatusBar: ComponentType<PluginStatusBarProps> = fromKit(
  "StatusBar",
  (kit) => kit.StatusBar
);
export const ScrollArea: ComponentType<PluginScrollAreaProps> = fromKit(
  "ScrollArea",
  (kit) => kit.ScrollArea
);
export const OverflowToolbar: ComponentType<PluginOverflowToolbarProps> = fromKit(
  "OverflowToolbar",
  (kit) => kit.OverflowToolbar
);

// Colour, time and range pickers, toggle groups, split buttons and forms.

export const ColorSwatch: ComponentType<PluginColorSwatchProps> = fromKit(
  "ColorSwatch",
  (kit) => kit.ColorSwatch
);
export const ColorPicker: ComponentType<PluginColorPickerProps> = fromKit(
  "ColorPicker",
  (kit) => kit.ColorPicker
);
export const TimePicker: ComponentType<PluginTimePickerProps> = fromKit(
  "TimePicker",
  (kit) => kit.TimePicker
);
export const DateTimePicker: ComponentType<PluginDateTimePickerProps> = fromKit(
  "DateTimePicker",
  (kit) => kit.DateTimePicker
);
export const RangeSlider: ComponentType<PluginRangeSliderProps> = fromKit(
  "RangeSlider",
  (kit) => kit.RangeSlider
);
export const ToggleGroup: ComponentType<PluginToggleGroupProps> = fromKit(
  "ToggleGroup",
  (kit) => kit.ToggleGroup
);
export const SplitButton: ComponentType<PluginSplitButtonProps> = fromKit(
  "SplitButton",
  (kit) => kit.SplitButton
);
// What Form's loading fallback may render of untyped children: what the
// loaded adapter keeps, so a plain object is dropped rather than crashing.
const renderableTree = (children: unknown): ReactNode =>
  Array.isArray(children) ? children.map(renderableTree) : renderableChild(children);

export const Form: ComponentType<PluginFormProps> = fromKit(
  "Form",
  (kit) => kit.Form,
  // The fields are there from the first frame; only the submit wiring waits.
  ({ children }) => renderableTree(children)
);
export const FormStatus: ComponentType<PluginFormStatusProps> = fromKit(
  "FormStatus",
  (kit) => kit.FormStatus
);
export const SchemaForm: ComponentType<PluginSchemaFormProps> = fromKit(
  "SchemaForm",
  (kit) => kit.SchemaForm
);
export { useForm } from "./form";
// Mention autocomplete, the agent composer, inline rename, key/value and list
// editors, secrets and shortcut recording.

export const MentionTextarea: ComponentType<PluginMentionTextareaProps> = fromKit(
  "MentionTextarea",
  (kit) => kit.MentionTextarea
);
export const Composer: ComponentType<PluginComposerProps> = fromKit(
  "Composer",
  (kit) => kit.Composer
);
export const InlineEdit: ComponentType<PluginInlineEditProps> = fromKit(
  "InlineEdit",
  (kit) => kit.InlineEdit
);
export const KeyValueEditor: ComponentType<PluginKeyValueEditorProps> = fromKit(
  "KeyValueEditor",
  (kit) => kit.KeyValueEditor
);
export const ListEditor: ComponentType<PluginListEditorProps> = fromKit(
  "ListEditor",
  (kit) => kit.ListEditor
);
export const SecretInput: ComponentType<PluginSecretInputProps> = fromKit(
  "SecretInput",
  (kit) => kit.SecretInput
);
export const ShortcutRecorder: ComponentType<PluginShortcutRecorderProps> = fromKit(
  "ShortcutRecorder",
  (kit) => kit.ShortcutRecorder
);

// List and detail, multi-pane splits, inspectors, in-pane drawers, grouped
// lists, selection bars, pagination footers, job queues and stale data.

export const MasterDetail: ComponentType<PluginMasterDetailProps> = fromKit(
  "MasterDetail",
  (kit) => kit.MasterDetail
);
export const SplitGroup: ComponentType<PluginSplitGroupProps> = fromKit(
  "SplitGroup",
  (kit) => kit.SplitGroup
);
export const Inspector: ComponentType<PluginInspectorProps> = fromKit(
  "Inspector",
  (kit) => kit.Inspector
);
export const InspectorSection: ComponentType<PluginInspectorSectionProps> = fromKit(
  "InspectorSection",
  (kit) => kit.InspectorSection
);
export const PropertyRow: ComponentType<PluginPropertyRowProps> = fromKit(
  "PropertyRow",
  (kit) => kit.PropertyRow
);
export const Drawer: ComponentType<PluginDrawerProps> = fromKit(
  "Drawer",
  (kit) => kit.Drawer,
  // The pane's own content is there from the first frame; only the drawer waits.
  ({ children }) => children
);
export const DrawerToggle: ComponentType<PluginDrawerToggleProps> = fromKit(
  "DrawerToggle",
  (kit) => kit.DrawerToggle
);
// Generic over the row type in the public types, like the list components.
export const GroupedVirtualList: <T>(props: PluginGroupedVirtualListProps<T>) => ReactNode =
  fromKit("GroupedVirtualList", (kit) => kit.GroupedVirtualList);
export const BulkActionBar: ComponentType<PluginBulkActionBarProps> = fromKit(
  "BulkActionBar",
  (kit) => kit.BulkActionBar
);
export const LoadMoreFooter: ComponentType<PluginLoadMoreFooterProps> = fromKit(
  "LoadMoreFooter",
  (kit) => kit.LoadMoreFooter
);
export const TaskList: ComponentType<PluginTaskListProps> = fromKit(
  "TaskList",
  (kit) => kit.TaskList
);
export const RefreshOverlay: ComponentType<PluginRefreshOverlayProps> = fromKit(
  "RefreshOverlay",
  (kit) => kit.RefreshOverlay,
  // The content is there from the first frame; only the updating marks wait.
  ({ children }) => children
);
export const StaleIndicator: ComponentType<PluginStaleIndicatorProps> = fromKit(
  "StaleIndicator",
  (kit) => kit.StaleIndicator
);

export type {
  PluginMarkdownProps as MarkdownProps,
  PluginButtonProps as ButtonProps,
  PluginIconButtonProps as IconButtonProps,
  PluginTooltipProps as TooltipProps,
  PluginTruncatedTooltipProps as TruncatedTooltipProps,
  PluginSpinnerProps as SpinnerProps,
  PluginSpinningIconProps as SpinningIconProps,
  PluginBadgeProps as BadgeProps,
  PluginCheckboxProps as CheckboxProps,
  PluginInputProps as InputProps,
  PluginTextareaProps as TextareaProps,
  PluginSelectProps as SelectProps,
  PluginSelectOption as SelectOption,
  PluginSelectOptionGroup as SelectOptionGroup,
  PluginSegmentedControlProps as SegmentedControlProps,
  PluginSegmentedOption as SegmentedOption,
  PluginKbdProps as KbdProps,
  PluginKbdChordProps as KbdChordProps,
  PluginCopyButtonProps as CopyButtonProps,
  PluginDismissButtonProps as DismissButtonProps,
  PluginCalloutProps as CalloutProps,
  PluginEmptyStateProps as EmptyStateProps,
  PluginSkeletonProps as SkeletonProps,
  PluginSkeletonBoneProps as SkeletonBoneProps,
  PluginSkeletonTextProps as SkeletonTextProps,
  PluginScrollShadowProps as ScrollShadowProps,
  PluginSearchFieldProps as SearchFieldProps,
  PluginDropdownMenuProps as DropdownMenuProps,
  PluginDropdownMenuEntry as DropdownMenuEntry,
  PluginDialogProps as DialogProps,
  PluginDialogAction as DialogAction,
  PluginConfirmDialogProps as ConfirmDialogProps,
  PluginIconProps as IconProps,
  PluginIconName as IconName,
  PluginDaintreeTheme as DaintreeTheme,
  PluginThemeTokenKey as ThemeTokenKey,
  PluginThemeTokens as ThemeTokens,
  PluginVirtualListProps as VirtualListProps,
  PluginVirtualListItemsProps as VirtualListItemsProps,
  PluginVirtualListCountProps as VirtualListCountProps,
  PluginDataTableProps as DataTableProps,
  PluginDataTableColumn as DataTableColumn,
  PluginDataTableSort as DataTableSort,
  PluginLogViewProps as LogViewProps,
  PluginLogEntry as LogEntry,
  PluginPaneHeaderProps as PaneHeaderProps,
  PluginToolbarProps as ToolbarProps,
  PluginToolbarButtonProps as ToolbarButtonProps,
  PluginPaneStateProps as PaneStateProps,
  PluginFormFieldProps as FormFieldProps,
  PluginFormFieldControlProps as FormFieldControlProps,
  PluginSwitchProps as SwitchProps,
  PluginTabsProps as TabsProps,
  PluginTabItem as TabItem,
  PluginProgressBarProps as ProgressBarProps,
  PluginSettingsSectionProps as SettingsSectionProps,
  PluginSettingsGroupProps as SettingsGroupProps,
  PluginSettingsRowProps as SettingsRowProps,
  PluginSettingsRowControlIds as SettingsRowControlIds,
  PluginSettingsActionsProps as SettingsActionsProps,
  PluginListRowProps as ListRowProps,
  UseListNavigationOptions,
  UseListNavigationResult,
  PluginListNavigationContainerProps as ListNavigationContainerProps,
  PluginListNavigationRowProps as ListNavigationRowProps,
  PluginSeverity as Severity,
  PluginSeverityIconProps as SeverityIconProps,
  PluginAvatarProps as AvatarProps,
  PluginPopoverProps as PopoverProps,
  PluginPopoverSearchFieldProps as PopoverSearchFieldProps,
  PluginSkeletonHintProps as SkeletonHintProps,
  PluginDropdownMenuRadioItem as DropdownMenuRadioItem,
  PluginDialogLayer as DialogLayer,
  PluginIconSource as IconSource,
  PluginFileTreeProps as FileTreeProps,
  PluginFileTreeEntry as FileTreeEntry,
  PluginFileTreeNode as FileTreeNode,
  PluginFileTreeItem as FileTreeItem,
  PluginStatCardProps as StatCardProps,
  PluginSparklineProps as SparklineProps,
  PluginFormFieldGroupProps as FormFieldGroupProps,
  PluginFilterChipProps as FilterChipProps,
  PluginHighlightedTextProps as HighlightedTextProps,
  PluginDiffStatProps as DiffStatProps,
  PluginAvatarGroupProps as AvatarGroupProps,
  PluginAvatarGroupItem as AvatarGroupItem,
  PluginMeterProps as MeterProps,
  PluginMeterThresholds as MeterThresholds,
  PluginTimelineProps as TimelineProps,
  PluginTimelineItem as TimelineItem,
  PluginTimelineActor as TimelineActor,
  PluginIsoDate as IsoDate,
  PluginDateRange as DateRange,
  PluginCalendarProps as CalendarProps,
  PluginCalendarBaseProps as CalendarBaseProps,
  PluginCalendarSingleProps as CalendarSingleProps,
  PluginCalendarRangeProps as CalendarRangeProps,
  PluginDateFieldBaseProps as DateFieldBaseProps,
  PluginDatePickerProps as DatePickerProps,
  PluginDateRangePickerProps as DateRangePickerProps,
  PluginDateRangePreset as DateRangePreset,
  PluginTimeAgoProps as TimeAgoProps,
  PluginContextMenuProps as ContextMenuProps,
  PluginSheetProps as SheetProps,
  PluginCommandPaletteProps as CommandPaletteProps,
  PluginCommandPaletteItem as CommandPaletteItem,
  PluginBreadcrumbsProps as BreadcrumbsProps,
  PluginBreadcrumbItem as BreadcrumbItem,
  PluginNavListProps as NavListProps,
  PluginNavListItem as NavListItem,
  PluginNavListSection as NavListSection,
  PluginStepperProps as StepperProps,
  PluginStepperStep as StepperStep,
  PluginStepState as StepState,
  PluginCardProps as CardProps,
  PluginDividerProps as DividerProps,
  PluginSectionLabelProps as SectionLabelProps,
  PluginResizableSplitProps as ResizableSplitProps,
  PluginAccordionProps as AccordionProps,
  PluginAccordionItem as AccordionItem,
  PluginDisclosureProps as DisclosureProps,
  PluginDescriptionListProps as DescriptionListProps,
  PluginDescriptionListItemProps as DescriptionListItemProps,
  PluginDescriptionItem as DescriptionItem,
  PluginRadioGroupProps as RadioGroupProps,
  PluginRadioOption as RadioOption,
  PluginNumberInputProps as NumberInputProps,
  PluginSliderProps as SliderProps,
  PluginPickerBaseProps as PickerBaseProps,
  PluginComboboxProps as ComboboxProps,
  PluginMultiSelectProps as MultiSelectProps,
  PluginTagInputProps as TagInputProps,
  PluginFileDropzoneProps as FileDropzoneProps,
  PluginEmojiPickerProps as EmojiPickerProps,
  PluginChartColor as ChartColor,
  PluginChartSeries as ChartSeries,
  PluginChartBaseProps as ChartBaseProps,
  PluginBarChartProps as BarChartProps,
  PluginLineChartProps as LineChartProps,
  PluginDonutChartProps as DonutChartProps,
  PluginDragId as DragId,
  PluginDragEvent as DragEvent,
  PluginDragDropProviderProps as DragDropProviderProps,
  PluginUseDraggableOptions as UseDraggableOptions,
  PluginDragHandleProps as DragHandleProps,
  PluginDraggableState as DraggableState,
  PluginUseDroppableOptions as UseDroppableOptions,
  PluginDroppableState as DroppableState,
  PluginSortableItemState as SortableItemState,
  PluginSortableListProps as SortableListProps,
  PluginKanbanColumn as KanbanColumn,
  PluginKanbanMove as KanbanMove,
  PluginKanbanCardState as KanbanCardState,
  PluginKanbanProps as KanbanProps,
  PluginSelectionKey as SelectionKey,
  PluginSelectionGesture as SelectionGesture,
  PluginSelectionItemProps as SelectionItemProps,
  UseSelectionOptions,
  UseSelectionResult,
  PluginHotkey as Hotkey,
  UseHotkeysOptions,
  UseUndoRedoOptions,
  UseUndoRedoResult,
  PluginUndoRedoPushOptions as UndoRedoPushOptions,
  UseDisclosureOptions,
  UseDisclosureResult,
  UseDebouncedCallbackOptions,
  PluginDebouncedCallback as DebouncedCallback,
  PluginToastTone as ToastTone,
  PluginViewToastOptions as ToastOptions,
  PluginUndoToastOptions as UndoToastOptions,
  PluginToastHandle as ToastHandle,
  UseToastResult,
  PluginConfirmPopoverProps as ConfirmPopoverProps,
  PluginLayoutGap as LayoutGap,
  PluginLayoutAlign as LayoutAlign,
  PluginLayoutJustify as LayoutJustify,
  PluginLayoutElement as LayoutElement,
  PluginLayoutBaseProps as LayoutBaseProps,
  PluginStackProps as StackProps,
  PluginInlineProps as InlineProps,
  PluginClusterProps as ClusterProps,
  PluginGridProps as GridProps,
  PluginAutoGridProps as AutoGridProps,
  PluginPaneLayoutProps as PaneLayoutProps,
  PluginStatusBarProps as StatusBarProps,
  PluginStatusBarSlot as StatusBarSlot,
  PluginScrollAreaProps as ScrollAreaProps,
  PluginOverflowToolbarProps as OverflowToolbarProps,
  PluginOverflowToolbarItem as OverflowToolbarItem,
  PluginOverflowToolbarAction as OverflowToolbarAction,
  PluginOverflowToolbarSeparator as OverflowToolbarSeparator,
  PluginContainerSize as ContainerSize,
  PluginContainerTarget as ContainerTarget,
} from "@shared/types/plugin-sdk-react";

export type {
  PluginTextSize as TextSize,
  PluginTextTone as TextTone,
  PluginTextProps as TextProps,
  PluginHeadingProps as HeadingProps,
  PluginLinkProps as LinkProps,
  PluginInlineCodeProps as InlineCodeProps,
  PluginCodeBlockProps as CodeBlockProps,
  PluginPathLabelProps as PathLabelProps,
  PluginVisuallyHiddenProps as VisuallyHiddenProps,
  PluginLiveRegionProps as LiveRegionProps,
  PluginAnnounceOptions as AnnounceOptions,
  PluginPortalProps as PortalProps,
  PluginStatusState as StatusState,
  PluginStatusDotProps as StatusDotProps,
  PluginStateGlyphProps as StateGlyphProps,
  PluginColoredLabelProps as ColoredLabelProps,
  PluginIndicatorPlacement as IndicatorPlacement,
  PluginUnreadDotProps as UnreadDotProps,
  PluginCountIndicatorProps as CountIndicatorProps,
} from "@shared/types/plugin-sdk-react";

export type {
  PluginColorSwatch as ColorSwatchEntry,
  PluginColorSwatchProps as ColorSwatchProps,
  PluginColorPickerProps as ColorPickerProps,
  PluginIsoTime as IsoTime,
  PluginTimePickerProps as TimePickerProps,
  PluginIsoDateTime as IsoDateTime,
  PluginDateTimePickerProps as DateTimePickerProps,
  PluginRangeSliderMark as RangeSliderMark,
  PluginRangeSliderProps as RangeSliderProps,
  PluginToggleGroupItem as ToggleGroupItem,
  PluginToggleGroupProps as ToggleGroupProps,
  PluginSplitButtonProps as SplitButtonProps,
  PluginFormError as FormError,
  PluginFieldValidator as FieldValidator,
  UseFormOptions,
  PluginFormFieldBinding as FormFieldBinding,
  PluginFormStatus as FormStatusValue,
  UseFormResult,
  PluginFormHandle as FormHandle,
  PluginFormProps as FormProps,
  PluginFormStatusProps as FormStatusProps,
  PluginSchemaFormProps as SchemaFormProps,
  PluginMentionSuggestion as MentionSuggestion,
  PluginMentionTrigger as MentionTrigger,
  PluginMentionTextareaProps as MentionTextareaProps,
  PluginComposerAttachment as ComposerAttachment,
  PluginComposerProps as ComposerProps,
  PluginInlineEditProps as InlineEditProps,
  PluginKeyValuePair as KeyValuePair,
  PluginKeyValueEditorProps as KeyValueEditorProps,
  PluginListEditorProps as ListEditorProps,
  PluginSecretInputProps as SecretInputProps,
  PluginShortcutRecorderProps as ShortcutRecorderProps,
  PluginMasterDetailProps as MasterDetailProps,
  PluginSplitPane as SplitPane,
  PluginSplitLayout as SplitLayout,
  PluginSplitGroupProps as SplitGroupProps,
  PluginInspectorProps as InspectorProps,
  PluginInspectorSectionProps as InspectorSectionProps,
  PluginPropertyRowProps as PropertyRowProps,
  PluginDrawerProps as DrawerProps,
  PluginDrawerToggleProps as DrawerToggleProps,
  PluginListGroup as ListGroup,
  PluginGroupedVirtualListProps as GroupedVirtualListProps,
  PluginBulkAction as BulkAction,
  PluginBulkActionBarProps as BulkActionBarProps,
  PluginLoadMoreFooterProps as LoadMoreFooterProps,
  PluginTaskStatus as TaskStatus,
  PluginTask as Task,
  PluginTaskListProps as TaskListProps,
  PluginRefreshOverlayProps as RefreshOverlayProps,
  PluginStaleIndicatorProps as StaleIndicatorProps,
} from "@shared/types/plugin-sdk-react";
