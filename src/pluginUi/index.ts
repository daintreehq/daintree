// The runtime of `@daintreehq/plugin-ui`, served to plugin views through the
// host import map. Every export here is public contract: vite.config.ts pins
// the names in HOST_FACADE_REQUIRED_EXPORTS and the SDK declares their types in
// packages/plugin-sdk/plugin-ui.d.ts. Nothing here may import app code
// statically; the host components load through `fromKit`.
import { isValidElement, type ComponentType, type ReactNode } from "react";
import type {
  PluginAvatarGroupProps,
  PluginAccordionProps,
  PluginAvatarProps,
  PluginBreadcrumbsProps,
  PluginCommandPaletteProps,
  PluginContextMenuProps,
  PluginNavListProps,
  PluginSheetProps,
  PluginStepperProps,
  PluginBadgeProps,
  PluginButtonProps,
  PluginCalendarProps,
  PluginCalloutProps,
  PluginCardProps,
  PluginCheckboxProps,
  PluginConfirmDialogProps,
  PluginCopyButtonProps,
  PluginDataTableProps,
  PluginDatePickerProps,
  PluginDateRangePickerProps,
  PluginDialogProps,
  PluginDiffStatProps,
  PluginDescriptionListItemProps,
  PluginDescriptionListProps,
  PluginDisclosureProps,
  PluginDismissButtonProps,
  PluginDividerProps,
  PluginDropdownMenuProps,
  PluginEmptyStateProps,
  PluginFileTreeProps,
  PluginFilterChipProps,
  PluginFormFieldGroupProps,
  PluginFormFieldProps,
  PluginHighlightedTextProps,
  PluginIconButtonProps,
  PluginIconProps,
  PluginInputProps,
  PluginKbdChordProps,
  PluginKbdProps,
  PluginListRowProps,
  PluginLogViewProps,
  PluginMeterProps,
  PluginPaneHeaderProps,
  PluginPaneStateProps,
  PluginPopoverProps,
  PluginPopoverSearchFieldProps,
  PluginProgressBarProps,
  PluginResizableSplitProps,
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
  PluginSkeletonBoneProps,
  PluginSkeletonHintProps,
  PluginSkeletonProps,
  PluginSkeletonTextProps,
  PluginSparklineProps,
  PluginSpinnerProps,
  PluginStatCardProps,
  PluginSpinningIconProps,
  PluginSwitchProps,
  PluginTabsProps,
  PluginTextareaProps,
  PluginTimelineItem,
  PluginTimelineProps,
  PluginTimeAgoProps,
  PluginToolbarButtonProps,
  PluginToolbarProps,
  PluginTooltipProps,
  PluginTruncatedTooltipProps,
  PluginVirtualListProps,
} from "@shared/types/plugin-sdk-react";
import { fromKit } from "./kit";

export { preloadPluginUi, whenPluginUiReady } from "./kit";

export { Markdown } from "./Markdown";
export { getDaintreeTheme, onDidChangeDaintreeTheme, useDaintreeTheme } from "./theme";
export { useListNavigation } from "./listNavigation";
export {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatTimeAgo,
} from "./format";

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
export const VirtualList: <T>(props: PluginVirtualListProps<T>) => ReactNode = fromKit(
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
} from "@shared/types/plugin-sdk-react";
