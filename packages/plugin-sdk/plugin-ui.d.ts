// Types for `@daintreehq/plugin-ui`, the UI components Daintree serves to
// plugin views through its import map. There is no package behind the
// specifier — the implementation only exists inside the running app, and
// `@daintreehq/plugin-vite` keeps it external — so this ambient declaration is
// how TypeScript learns its shape. Opt in with
// `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` in tsconfig, or
// `/// <reference types="@daintreehq/plugin-sdk/plugin-ui" />` in one file.
//
// Stability: the kit is versioned by `PLUGIN_UI_VERSION` (semver). A minor
// version adds new components, new optional props, new icon names and new
// theme token keys; the only other change it may make is renaming an extended
// theme token (below). Within a major version no export, prop, accepted value
// or core token key is removed or narrowed. Every component validates its props at runtime, so a
// value outside these types is ignored rather than thrown on.
//
// Theme tokens come in two tiers. The core tokens — `surface-*`, `text-*`,
// `border-*`, `accent-*`, `focus-ring` and `status-*` — are stable for the
// whole major version. The extended groups — `terminal-*` (including the ANSI
// colours), `syntax-*`, `activity-*` and `category-*` — are provided best
// effort and may be renamed in a minor version, with the change noted in the
// release notes. Read an extended token with a fallback.
//
// Error banners are `Callout` with `severity="error"` and a Retry `action`;
// a pane that failed as a whole is `PaneState` with `kind="error"`. There is
// no separate banner component.
//
// Status vocabulary, shared by `Badge` `tone`, `Callout` `severity` and `SeverityIcon`:
// `error` ≡ `danger` in colour (the `status-error` class is an alias of the
// `status-danger` theme token), plus `warning`, `success`, `info` and `neutral`. A Badge renders `error` and
// `danger` identically; a Callout keeps a separate caution glyph for `danger`.
//
// Components render Daintree's own controls and are themed with the app.
// They load with the kit on first use, so a component can paint a frame late
// the first time a view renders it. Parts that open in a host overlay (tooltip
// bodies, menus, select lists, dialogs) take no `className`: they render
// outside the view's style root, where the view's classes do not apply.
declare module "@daintreehq/plugin-ui" {
  import type { ComponentType, ReactNode } from "react";
  import type {
    PluginAccordionItem,
    PluginAccordionProps,
    PluginAvatarGroupItem,
    PluginAvatarGroupProps,
    PluginAvatarProps,
    PluginBadgeProps,
    PluginBarChartProps,
    PluginBreadcrumbItem,
    PluginBreadcrumbsProps,
    PluginButtonProps,
    PluginCalendarBaseProps,
    PluginCalendarProps,
    PluginCalendarRangeProps,
    PluginCalendarSingleProps,
    PluginCalloutProps,
    PluginCardProps,
    PluginChartBaseProps,
    PluginChartColor,
    PluginChartSeries,
    PluginCheckboxProps,
    PluginComboboxProps,
    PluginCommandPaletteItem,
    PluginCommandPaletteProps,
    PluginConfirmDialogProps,
    PluginContextMenuProps,
    PluginCopyButtonProps,
    PluginDaintreeTheme,
    PluginDataTableColumn,
    PluginDataTableProps,
    PluginDataTableRowKey,
    PluginDataTableSort,
    PluginDateFieldBaseProps,
    PluginDatePickerProps,
    PluginDateRange,
    PluginDateRangePickerProps,
    PluginDateRangePreset,
    PluginDescriptionItem,
    PluginDescriptionListItemProps,
    PluginDescriptionListProps,
    PluginDialogAction,
    PluginDialogLayer,
    PluginDialogProps,
    PluginDiffStatProps,
    PluginDisclosureProps,
    PluginDismissButtonProps,
    PluginDividerProps,
    PluginDonutChartProps,
    PluginDropdownMenuEntry,
    PluginDropdownMenuProps,
    PluginDropdownMenuRadioItem,
    PluginEmojiPickerProps,
    PluginEmptyStateProps,
    PluginFileDropzoneProps,
    PluginFileTreeEntry,
    PluginFileTreeItem,
    PluginFileTreeNode,
    PluginFileTreeProps,
    PluginFilterChipProps,
    PluginFormFieldControlProps,
    PluginFormFieldGroupProps,
    PluginFormFieldProps,
    PluginHighlightedTextProps,
    PluginIconButtonProps,
    PluginIconName,
    PluginIconProps,
    PluginIconSource,
    PluginInputProps,
    PluginIsoDate,
    PluginKbdChordProps,
    PluginKbdProps,
    PluginLineChartProps,
    PluginListNavigationContainerProps,
    PluginListNavigationRowProps,
    PluginListRowProps,
    PluginLogEntry,
    PluginLogViewProps,
    PluginMarkdownProps,
    PluginMeterProps,
    PluginMeterThresholds,
    PluginMultiSelectProps,
    PluginNavListItem,
    PluginNavListProps,
    PluginNavListSection,
    PluginNumberInputProps,
    PluginPaneHeaderProps,
    PluginPaneStateProps,
    PluginPickerBaseProps,
    PluginPopoverProps,
    PluginPopoverSearchFieldProps,
    PluginProgressBarProps,
    PluginRadioGroupProps,
    PluginRadioOption,
    PluginResizableSplitProps,
    PluginScrollShadowProps,
    PluginSearchFieldProps,
    PluginSectionLabelProps,
    PluginSegmentedControlProps,
    PluginSegmentedOption,
    PluginSelectOption,
    PluginSelectOptionGroup,
    PluginSelectProps,
    PluginSettingsActionsProps,
    PluginSettingsGroupProps,
    PluginSettingsRowControlIds,
    PluginSettingsRowProps,
    PluginSettingsSectionProps,
    PluginSeverity,
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
    PluginStatCardProps,
    PluginStepState,
    PluginStepperProps,
    PluginStepperStep,
    PluginSwitchProps,
    PluginTabItem,
    PluginTabsProps,
    PluginTagInputProps,
    PluginTextareaProps,
    PluginThemeTokenKey,
    PluginThemeTokens,
    PluginTimeAgoProps,
    PluginTimelineActor,
    PluginTimelineItem,
    PluginTimelineProps,
    PluginToolbarButtonProps,
    PluginToolbarProps,
    PluginTooltipProps,
    PluginTruncatedTooltipProps,
    PluginVirtualListComponent,
    PluginVirtualListCountProps,
    PluginVirtualListItemsProps,
    PluginVirtualListProps,
    UseListNavigationOptions as PluginUseListNavigationOptions,
    UseListNavigationResult as PluginUseListNavigationResult,
    PluginConfirmPopoverProps,
    PluginDebouncedCallback,
    PluginHotkey,
    PluginSelectionGesture,
    PluginSelectionItemProps,
    PluginSelectionKey,
    PluginToastHandle,
    PluginToastTone,
    PluginUndoRedoPushOptions,
    PluginUndoToastOptions,
    PluginViewToastOptions,
    UseDebouncedCallbackOptions as PluginUseDebouncedCallbackOptions,
    UseDisclosureOptions as PluginUseDisclosureOptions,
    UseDisclosureResult as PluginUseDisclosureResult,
    UseHotkeysOptions as PluginUseHotkeysOptions,
    UseSelectionOptions as PluginUseSelectionOptions,
    UseSelectionResult as PluginUseSelectionResult,
    UseToastResult as PluginUseToastResult,
    UseUndoRedoOptions as PluginUseUndoRedoOptions,
    UseUndoRedoResult as PluginUseUndoRedoResult,
  } from "@daintreehq/plugin-sdk/react";

  export type MarkdownProps = PluginMarkdownProps;
  export type ButtonProps = PluginButtonProps;
  export type IconButtonProps = PluginIconButtonProps;
  export type TooltipProps = PluginTooltipProps;
  export type TruncatedTooltipProps = PluginTruncatedTooltipProps;
  export type SpinnerProps = PluginSpinnerProps;
  export type SpinningIconProps = PluginSpinningIconProps;
  export type BadgeProps = PluginBadgeProps;
  export type CheckboxProps = PluginCheckboxProps;
  export type InputProps = PluginInputProps;
  export type TextareaProps = PluginTextareaProps;
  export type SelectProps = PluginSelectProps;
  export type SelectOption = PluginSelectOption;
  export type SelectOptionGroup = PluginSelectOptionGroup;
  export type SegmentedControlProps = PluginSegmentedControlProps;
  export type SegmentedOption = PluginSegmentedOption;
  export type KbdProps = PluginKbdProps;
  export type KbdChordProps = PluginKbdChordProps;
  export type CopyButtonProps = PluginCopyButtonProps;
  export type DismissButtonProps = PluginDismissButtonProps;
  export type CalloutProps = PluginCalloutProps;
  export type EmptyStateProps = PluginEmptyStateProps;
  export type SkeletonProps = PluginSkeletonProps;
  export type SkeletonBoneProps = PluginSkeletonBoneProps;
  export type SkeletonTextProps = PluginSkeletonTextProps;
  export type ScrollShadowProps = PluginScrollShadowProps;
  export type SearchFieldProps = PluginSearchFieldProps;
  export type DropdownMenuProps = PluginDropdownMenuProps;
  export type DropdownMenuEntry = PluginDropdownMenuEntry;
  export type DialogProps = PluginDialogProps;
  export type DialogAction = PluginDialogAction;
  export type ConfirmDialogProps = PluginConfirmDialogProps;
  export type IconProps = PluginIconProps;
  export type IconName = PluginIconName;
  export type DaintreeTheme = PluginDaintreeTheme;
  export type ThemeTokenKey = PluginThemeTokenKey;
  export type ThemeTokens = PluginThemeTokens;
  export type VirtualListProps<T = unknown> = PluginVirtualListProps<T>;
  export type VirtualListItemsProps<T = unknown> = PluginVirtualListItemsProps<T>;
  export type VirtualListCountProps = PluginVirtualListCountProps;
  export type DataTableProps<T = unknown> = PluginDataTableProps<T>;
  export type DataTableColumn<T = unknown> = PluginDataTableColumn<T>;
  export type DataTableRowKey<T = unknown> = PluginDataTableRowKey<T>;
  export type DataTableSort = PluginDataTableSort;
  export type LogViewProps = PluginLogViewProps;
  export type LogEntry = PluginLogEntry;
  export type PaneHeaderProps = PluginPaneHeaderProps;
  export type ToolbarProps = PluginToolbarProps;
  export type ToolbarButtonProps = PluginToolbarButtonProps;
  export type PaneStateProps = PluginPaneStateProps;
  export type FormFieldProps = PluginFormFieldProps;
  export type FormFieldControlProps = PluginFormFieldControlProps;
  export type SwitchProps = PluginSwitchProps;
  export type TabsProps = PluginTabsProps;
  export type TabItem = PluginTabItem;
  export type ProgressBarProps = PluginProgressBarProps;
  export type SettingsSectionProps = PluginSettingsSectionProps;
  export type SettingsGroupProps = PluginSettingsGroupProps;
  export type SettingsRowProps = PluginSettingsRowProps;
  export type SettingsRowControlIds = PluginSettingsRowControlIds;
  export type SettingsActionsProps = PluginSettingsActionsProps;
  export type ListRowProps = PluginListRowProps;
  export type UseListNavigationOptions = PluginUseListNavigationOptions;
  export type UseListNavigationResult = PluginUseListNavigationResult;
  export type ListNavigationContainerProps = PluginListNavigationContainerProps;
  export type ListNavigationRowProps = PluginListNavigationRowProps;
  export type Severity = PluginSeverity;
  export type SeverityIconProps = PluginSeverityIconProps;
  export type AvatarProps = PluginAvatarProps;
  export type PopoverProps = PluginPopoverProps;
  export type PopoverSearchFieldProps = PluginPopoverSearchFieldProps;
  export type SkeletonHintProps = PluginSkeletonHintProps;
  export type DropdownMenuRadioItem = PluginDropdownMenuRadioItem;
  export type DialogLayer = PluginDialogLayer;
  export type IconSource = PluginIconSource;
  export type FileTreeProps = PluginFileTreeProps;
  export type FileTreeEntry = PluginFileTreeEntry;
  export type FileTreeNode = PluginFileTreeNode;
  export type FileTreeItem = PluginFileTreeItem;
  export type StatCardProps = PluginStatCardProps;
  export type SparklineProps = PluginSparklineProps;
  export type FormFieldGroupProps = PluginFormFieldGroupProps;
  export type FilterChipProps = PluginFilterChipProps;
  export type HighlightedTextProps = PluginHighlightedTextProps;
  export type DiffStatProps = PluginDiffStatProps;
  export type AvatarGroupProps = PluginAvatarGroupProps;
  export type AvatarGroupItem = PluginAvatarGroupItem;
  export type MeterProps = PluginMeterProps;
  export type MeterThresholds = PluginMeterThresholds;
  export type TimelineProps<T extends TimelineItem = TimelineItem> = PluginTimelineProps<T>;
  export type TimelineItem = PluginTimelineItem;
  export type TimelineActor = PluginTimelineActor;
  export type IsoDate = PluginIsoDate;
  export type DateRange = PluginDateRange;
  export type CalendarProps = PluginCalendarProps;
  export type CalendarBaseProps = PluginCalendarBaseProps;
  export type CalendarSingleProps = PluginCalendarSingleProps;
  export type CalendarRangeProps = PluginCalendarRangeProps;
  export type DateFieldBaseProps = PluginDateFieldBaseProps;
  export type DatePickerProps = PluginDatePickerProps;
  export type DateRangePickerProps = PluginDateRangePickerProps;
  export type DateRangePreset = PluginDateRangePreset;
  export type TimeAgoProps = PluginTimeAgoProps;
  export type ContextMenuProps = PluginContextMenuProps;
  export type SheetProps = PluginSheetProps;
  export type CommandPaletteProps = PluginCommandPaletteProps;
  export type CommandPaletteItem = PluginCommandPaletteItem;
  export type BreadcrumbsProps = PluginBreadcrumbsProps;
  export type BreadcrumbItem = PluginBreadcrumbItem;
  export type NavListProps = PluginNavListProps;
  export type NavListItem = PluginNavListItem;
  export type NavListSection = PluginNavListSection;
  export type StepperProps = PluginStepperProps;
  export type StepperStep = PluginStepperStep;
  export type StepState = PluginStepState;
  export type CardProps = PluginCardProps;
  export type DividerProps = PluginDividerProps;
  export type SectionLabelProps = PluginSectionLabelProps;
  export type ResizableSplitProps = PluginResizableSplitProps;
  export type AccordionProps = PluginAccordionProps;
  export type AccordionItem = PluginAccordionItem;
  export type DisclosureProps = PluginDisclosureProps;
  export type DescriptionListProps = PluginDescriptionListProps;
  export type DescriptionListItemProps = PluginDescriptionListItemProps;
  export type DescriptionItem = PluginDescriptionItem;
  export type RadioGroupProps = PluginRadioGroupProps;
  export type RadioOption = PluginRadioOption;
  export type NumberInputProps = PluginNumberInputProps;
  export type SliderProps = PluginSliderProps;
  export type PickerBaseProps = PluginPickerBaseProps;
  export type ComboboxProps = PluginComboboxProps;
  export type MultiSelectProps = PluginMultiSelectProps;
  export type TagInputProps = PluginTagInputProps;
  export type FileDropzoneProps = PluginFileDropzoneProps;
  export type EmojiPickerProps = PluginEmojiPickerProps;
  export type ChartColor = PluginChartColor;
  export type ChartSeries = PluginChartSeries;
  export type ChartBaseProps = PluginChartBaseProps;
  export type BarChartProps = PluginBarChartProps;
  export type LineChartProps = PluginLineChartProps;
  export type DonutChartProps = PluginDonutChartProps;
  export type SelectionKey = PluginSelectionKey;
  export type SelectionGesture = PluginSelectionGesture;
  export type SelectionItemProps = PluginSelectionItemProps;
  export type UseSelectionOptions<K extends SelectionKey = string> = PluginUseSelectionOptions<K>;
  export type UseSelectionResult<K extends SelectionKey = string> = PluginUseSelectionResult<K>;
  export type Hotkey = PluginHotkey;
  export type UseHotkeysOptions = PluginUseHotkeysOptions;
  export type UseUndoRedoOptions = PluginUseUndoRedoOptions;
  export type UseUndoRedoResult<T> = PluginUseUndoRedoResult<T>;
  export type UndoRedoPushOptions = PluginUndoRedoPushOptions;
  export type UseDisclosureOptions = PluginUseDisclosureOptions;
  export type UseDisclosureResult = PluginUseDisclosureResult;
  export type UseDebouncedCallbackOptions = PluginUseDebouncedCallbackOptions;
  export type DebouncedCallback<A extends unknown[]> = PluginDebouncedCallback<A>;
  export type ToastTone = PluginToastTone;
  export type ToastOptions = PluginViewToastOptions;
  export type UndoToastOptions = PluginUndoToastOptions;
  export type ToastHandle = PluginToastHandle;
  export type UseToastResult = PluginUseToastResult;
  export type ConfirmPopoverProps = PluginConfirmPopoverProps;

  /** The kit's contract version (semver): `"1.0.0"` for this release. */
  export const PLUGIN_UI_VERSION: string;

  /**
   * Resolves once the kit has loaded and every component renders on its first
   * frame, with no placeholder. Await it before measuring kit output, in tests
   * and in code that must not paint a frame late. Rejects when the kit fails to
   * load; calling it again retries.
   */
  export function whenPluginUiReady(): Promise<void>;
  /**
   * Starts loading the kit without waiting for it: call it when a view is
   * about to open. Every call shares one request.
   */
  export function preloadPluginUi(): void;

  /**
   * Daintree's own Markdown renderer: GFM, highlighted code fences, the app's
   * document typography, and raw HTML dropped rather than rendered. Loads on
   * first render, so it can paint one frame late.
   */
  export const Markdown: ComponentType<MarkdownProps>;

  /** The app's button. `icon` is a leading glyph; `loading` keeps focus and width. */
  export const Button: ComponentType<ButtonProps>;
  /** An icon-only button whose accessible name doubles as its tooltip. */
  export const IconButton: ComponentType<IconButtonProps>;
  /** A hover card on one child element. The child shows while the kit loads. */
  export const Tooltip: ComponentType<TooltipProps>;
  /** A tooltip that only opens while the child's text is truncated. */
  export const TruncatedTooltip: ComponentType<TruncatedTooltipProps>;
  /** A decorative loading spinner. */
  export const Spinner: ComponentType<SpinnerProps>;
  /** An icon that spins while `active` and finishes its turn before stopping. */
  export const SpinningIcon: ComponentType<SpinningIconProps>;
  /** A status pill. `tone` uses the shared status vocabulary above, plus `outline`. */
  export const Badge: ComponentType<BadgeProps>;
  export const Checkbox: ComponentType<CheckboxProps>;
  export const Input: ComponentType<InputProps>;
  export const Textarea: ComponentType<TextareaProps>;
  /** A single choice from a list, given as `options` (optionally grouped). */
  export const Select: ComponentType<SelectProps>;
  /** A segmented single-choice control with radio-group keyboard behaviour. */
  export const SegmentedControl: ComponentType<SegmentedControlProps>;
  /** One literal key cap. */
  export const Kbd: ComponentType<KbdProps>;
  /** A shortcut like `"Cmd+Shift+P"`, drawn with the platform's glyphs. */
  export const KbdChord: ComponentType<KbdChordProps>;
  /** Copies text, confirming with a check and a spoken announcement. */
  export const CopyButton: ComponentType<CopyButtonProps>;
  /** The X that dismisses a card, banner or hint. */
  export const DismissButton: ComponentType<DismissButtonProps>;
  /** An inline message box whose glyph and tint follow `severity`. */
  export const Callout: ComponentType<CalloutProps>;
  /** What a pane or list shows when it has nothing to show. */
  export const EmptyState: ComponentType<EmptyStateProps>;
  /** The accessible loading region; put `SkeletonBone`/`SkeletonText` inside. */
  export const Skeleton: ComponentType<SkeletonProps>;
  export const SkeletonBone: ComponentType<SkeletonBoneProps>;
  export const SkeletonText: ComponentType<SkeletonTextProps>;
  /** A vertical scroller with edge fades that show there is more. */
  export const ScrollShadow: ComponentType<ScrollShadowProps>;
  /** The app's search box. */
  export const SearchField: ComponentType<SearchFieldProps>;
  /** A menu opened from `trigger`, built from an `items` array. */
  export const DropdownMenu: ComponentType<DropdownMenuProps>;
  /** A modal dialog with a title bar, scrolling body and footer actions. */
  export const Dialog: ComponentType<DialogProps>;
  /** The confirm-or-cancel dialog, including the destructive typed-name gate. */
  export const ConfirmDialog: ComponentType<ConfirmDialogProps>;
  /**
   * One of Daintree's icons by name. An unknown name renders nothing (and
   * warns in development) rather than throwing.
   */
  export const Icon: ComponentType<IconProps>;

  /**
   * A windowed list: only the rows in view are in the DOM, so it stays fast at
   * tens of thousands of rows. It fills its container's height. For a keyboard
   * list, spread `useListNavigation().containerProps` onto it, pass its
   * `activeIndex`, and render each row as a `ListRow` with `getRowProps(index)`.
   */
  export const VirtualList: PluginVirtualListComponent;
  /**
   * A table with a sticky header and an always-virtualised body. Sorting is
   * controlled: the table reports `onSortChange` and you sort `rows`. With
   * `onRowClick` it is a keyboard grid (one tab stop, arrows, Enter).
   */
  export const DataTable: <T>(props: DataTableProps<T>) => ReactNode;
  /**
   * A bounded, virtualised log that follows the newest line while the reader
   * is at the bottom. Keeps the newest `maxLines` (5000 by default) on screen.
   */
  export const LogView: ComponentType<LogViewProps>;
  /** A pane's compact title bar: icon, title, a quiet subtitle and trailing actions. */
  export const PaneHeader: ComponentType<PaneHeaderProps>;
  /** A row of controls that is one tab stop, Left/Right between them. */
  export const Toolbar: ComponentType<ToolbarProps>;
  /** The in-pane toolbar button: icon-only with a tooltip, or icon and a word. */
  export const ToolbarButton: ComponentType<ToolbarButtonProps>;
  /** A whole pane's loading, empty or error state, in Daintree's pane frame. */
  export const PaneState: ComponentType<PaneStateProps>;
  /** Label, description and error wired to the control inside. */
  export const FormField: ComponentType<FormFieldProps>;
  /** An instant on/off switch. Neutral, never accent, when on. */
  export const Switch: ComponentType<SwitchProps>;
  /** A tab strip and the active tab's panel. */
  export const Tabs: ComponentType<TabsProps>;
  /** A neutral progress bar; indeterminate without a `value`. */
  export const ProgressBar: ComponentType<ProgressBarProps>;
  /** A titled block of a settings view. Holds `SettingsGroup`s. */
  export const SettingsSection: ComponentType<SettingsSectionProps>;
  /** One surface of related `SettingsRow`s. */
  export const SettingsGroup: ComponentType<SettingsGroupProps>;
  /** One setting: label and description on the left, its control on the rail. */
  export const SettingsRow: ComponentType<SettingsRowProps>;
  /** The explicit-save row at the end of a group. */
  export const SettingsActions: ComponentType<SettingsActionsProps>;
  /** A list row with Daintree's highlight: icon, title, subtitle and trailing meta. */
  export const ListRow: ComponentType<ListRowProps>;
  /** The one glyph for each severity. */
  export const SeverityIcon: ComponentType<SeverityIconProps>;

  //

  /** A person's or bot's picture, with their initials when there is none. */
  export const Avatar: ComponentType<AvatarProps>;
  /** A floating panel opened from `trigger`. The trigger shows while the kit loads. */
  export const Popover: ComponentType<PopoverProps>;
  /** The full-width search strip at the top of a filtering `Popover`. */
  export const PopoverSearchField: ComponentType<PopoverSearchFieldProps>;
  /** The "Still working…" line beside a `Skeleton` once a load runs long. */
  export const SkeletonHint: ComponentType<SkeletonHintProps>;

  /**
   * Daintree's file tree, virtualised: the host browser's chevron gutter,
   * file-type icons and keyboard model. Takes a flat `entries` list (the shape
   * `host.fs.walk` returns) or nested `nodes`, and sorts folders first in
   * natural, numeric-aware order unless `sort="none"`. It fills its
   * container's height.
   */
  export const FileTree: ComponentType<FileTreeProps>;
  /** One figure with a sentence-case label, an optional delta and a quiet hint. */
  export const StatCard: ComponentType<StatCardProps>;
  /** A small trend line with no axes, in a theme colour, filling its container's width. */
  export const Sparkline: ComponentType<SparklineProps>;
  /** One label, at a field label's size, over a set of controls such as checkboxes. */
  export const FormFieldGroup: ComponentType<FormFieldGroupProps>;
  /**
   * An inline month grid choosing one day or, with `mode="range"`, a run of
   * days, with the grid keyboard model, locale month and weekday names and a
   * today mark. Days are ISO `"YYYY-MM-DD"` strings, which name the same day
   * in every timezone.
   */
  export const Calendar: ComponentType<CalendarProps>;
  /** A date field that takes typed dates leniently or opens a `Calendar`; the value is ISO or `null`. */
  export const DatePicker: ComponentType<DatePickerProps>;
  /** `DatePicker` for a `{ start, end }` range, with two months where there is room and optional presets. */
  export const DateRangePicker: ComponentType<DateRangePickerProps>;
  /** A `<time>` reading "5m ago" that keeps itself current on one shared timer, with the full date on hover. */
  export const TimeAgo: ComponentType<TimeAgoProps>;

  /** One value in a filter bar: a pressed toggle, or with `onRemove` an applied filter with a ×. */
  export const FilterChip: ComponentType<FilterChipProps>;
  /** Text with its search matches on a neutral band, from a `query` or your own `ranges`. */
  export const HighlightedText: ComponentType<HighlightedTextProps>;
  /** Line churn in Daintree's one spelling: "+12 -3". */
  export const DiffStat: ComponentType<DiffStatProps>;
  /** Overlapping avatars with a "+N" whose tooltip lists the rest. */
  export const AvatarGroup: ComponentType<AvatarGroupProps>;
  /** How much of a limit is used: neutral below its thresholds, then warning or danger. */
  export const Meter: ComponentType<MeterProps>;
  /**
   * An activity feed or audit log on a connecting rail, virtualised with
   * measured rows. As tall as its entries up to its container, then it scrolls.
   */
  export const Timeline: <T extends TimelineItem>(props: TimelineProps<T>) => ReactNode;

  /** The right-click menu of `children`, from `DropdownMenu`'s rows; Shift+F10 and the Menu key open it too. */
  export const ContextMenu: ComponentType<ContextMenuProps>;
  /** A full-height panel against the window's edge, with a `Dialog`'s title bar, body and footer. */
  export const Sheet: ComponentType<SheetProps>;
  /** A searchable, virtualised palette for a quick switcher or "jump to…"; selecting an item closes it. */
  export const CommandPalette: ComponentType<CommandPaletteProps>;
  /** The path to the current page, with the middle crumbs folded into a menu when it runs long. */
  export const Breadcrumbs: ComponentType<BreadcrumbsProps>;
  /** An app's left-rail navigation: sections of destinations, one selected, one tab stop. */
  export const NavList: ComponentType<NavListProps>;
  /** A wizard's progress: one marker per step, complete, current, upcoming or in error. */
  export const Stepper: ComponentType<StepperProps>;

  /**
   * The app's card surface: a hairline frame with an optional header, body and
   * footer. With `onClick` the whole card is one button.
   */
  export const Card: ComponentType<CardProps>;
  /** A hairline between groups, horizontal or vertical, with an optional centred label. */
  export const Divider: ComponentType<DividerProps>;
  /** The small quiet uppercase heading above a group of content. */
  export const SectionLabel: ComponentType<SectionLabelProps>;
  /**
   * Two panes with a draggable, keyboard-resizable divider; one pane holds a
   * size in px, optionally collapsible. It fills its container.
   */
  export const ResizableSplit: ComponentType<ResizableSplitProps>;
  /** Stacked sections that show or hide their content, one or many open at a time. */
  export const Accordion: ComponentType<AccordionProps>;
  /** One heading button that shows or hides the content under it. */
  export const Disclosure: ComponentType<DisclosureProps>;
  /** The label and value rows of a record's detail page, inline or stacked. */
  export const DescriptionList: ComponentType<DescriptionListProps>;
  /** One row of a `DescriptionList`, for building the rows as children. */
  export const DescriptionListItem: ComponentType<DescriptionListItemProps>;

  /** Exactly one of a few options, as bordered cards or plain radios, with native radio keys. */
  export const RadioGroup: ComponentType<RadioGroupProps>;
  /** A number field with a unit, steppers, arrow-key steps, clamping and rounding; commits on blur or Enter. */
  export const NumberInput: ComponentType<NumberInputProps>;
  /** One value on a neutral track, with `aria-valuetext` from `formatValue`. */
  export const Slider: ComponentType<SliderProps>;
  /** A searchable single choice: a `Select`-style trigger over a virtualised, filterable list. */
  export const Combobox: ComponentType<ComboboxProps>;
  /** Any number of choices from a searchable, virtualised list, shown as chips on the trigger. */
  export const MultiSelect: ComponentType<MultiSelectProps>;
  /** Free-text tags: Enter or a comma adds, Backspace removes the last, duplicates are skipped. */
  export const TagInput: ComponentType<TagInputProps>;
  /** A drop target and a button for the system file dialog, handing you `File` objects. */
  export const FileDropzone: ComponentType<FileDropzoneProps>;
  /** Daintree's emoji picker in a popover opened from `trigger`. The trigger shows while the kit loads. */
  export const EmojiPicker: ComponentType<EmojiPickerProps>;
  /** Categories as columns or bars, grouped or stacked, with a point tooltip and a hidden data table. */
  export const BarChart: ComponentType<BarChartProps>;
  /** Series over a numeric or time axis, optionally filled or smoothed, with a crosshair tooltip. */
  export const LineChart: ComponentType<LineChartProps>;
  /** Parts of a whole around a centre figure, with a legend of every value and share. */
  export const DonutChart: ComponentType<DonutChartProps>;

  /**
   * The keyboard model of a list: one tab stop, Up/Down/Home/End move the
   * cursor, Enter or Space selects, typing jumps when `getLabel` is given.
   * Rows `isDisabled` reports are skipped and never selected.
   */
  export function useListNavigation(options: UseListNavigationOptions): UseListNavigationResult;

  /** "just now", "5m ago", "11d ago", then the date past 30 days. */
  export function formatTimeAgo(value: number | string | Date, now?: number): string;
  /** "5 minutes ago", "in 3 hours", then the date past 30 days. */
  export function formatRelativeTime(value: number | string | Date, now?: number): string;
  /** A byte size in 1024 steps: "0 B", "1.5 KB", "3 MB". */
  export function formatBytes(bytes: number): string;
  /** A badge count: exact below 1,000, then "1.2k", "23k", "1.2M". Truncates, never rounds up. */
  export function formatCount(count: number): string;
  /** An elapsed time in ms: "45s", "12m", "3h 5m", "2d 4h". */
  export function formatDuration(ms: number): string;

  /** The user's wall-clock day as "YYYY-MM-DD", the kit's date value. `now` fixes the clock. */
  export function isoToday(now?: number): string;
  /** The local "YYYY-MM-DD" day an instant falls on; null for an invalid date. */
  export function isoFromDate(date: Date | number): string | null;
  /**
   * The "YYYY-MM-DD" day `days` away (negative for earlier), free of
   * daylight-saving shifts; null when `day` is not a real date.
   */
  export function isoAddDays(day: string, days: number): string | null;
  /**
   * A "YYYY-MM-DD" day as the kit's date fields show it: "Sep 30, 2026"
   * (`short`, the default), "September 30, 2026" (`long`) or "Wednesday,
   * September 30, 2026" (`full`). "Unknown" when it is not a real date.
   */
  export function formatIsoDate(day: string, style?: "short" | "long" | "full"): string;

  /**
   * The active theme: `colorMode`, `themeId`, and resolved sRGB `tokens` for
   * canvas and WebGL code. Re-renders the component when the theme changes.
   * For styling DOM, prefer the theme's CSS classes and variables; they
   * follow the theme without a re-render.
   *
   * Token keys (the `--theme-*` CSS variable names without the prefix). The
   * surface, text, border, accent and status groups are core and stable within
   * the major version; activity, terminal, syntax and category are extended
   * and may be renamed in a minor version (see the stability note at the top):
   * surfaces `surface-{grid,sidebar,canvas,panel,panel-elevated,input,inset,hover,active}`;
   * text `text-{primary,secondary,muted,placeholder,inverse,link}`;
   * borders `border-{default,subtle,strong,divider,interactive}`;
   * accent `accent-{primary,foreground,hover,soft,muted}`, `focus-ring`;
   * status `status-{success,warning,danger,info}`;
   * agent activity `activity-{active,idle,working,waiting}`;
   * terminal `terminal-{background,foreground,muted,cursor,selection}` and the
   * 16 ANSI colours `terminal-{black,red,green,yellow,blue,magenta,cyan,white}`
   * with their `terminal-bright-*` pairs; syntax
   * `syntax-{comment,punctuation,number,string,operator,keyword,function,link,quote}`;
   * a chart ramp `category-{blue,purple,cyan,green,amber,orange,teal,indigo,rose,pink,violet,slate}`.
   */
  export function useDaintreeTheme(): DaintreeTheme;
  /**
   * The active theme, for code outside React. Cheap to call often: tokens are
   * resolved once per theme change and the same frozen object is returned
   * until the next one.
   */
  export function getDaintreeTheme(): DaintreeTheme;
  /** Calls `listener` after every theme change. Returns a function that stops it. */
  export function onDidChangeDaintreeTheme(listener: (theme: DaintreeTheme) => void): () => void;

  /**
   * Single, multi and range selection for a list or table, keyed by row id:
   * plain click replaces, Cmd/Ctrl-click toggles, Shift-click selects from the
   * anchor. Pair with `useListNavigation` through `handleSelect` (its
   * `onSelect`) and `handleNavigate` (its `onActiveIndexChange`).
   */
  export function useSelection<K extends SelectionKey = string>(
    options: UseSelectionOptions<K>
  ): UseSelectionResult<K>;
  /**
   * Shortcuts for your view, or for one element of it, in the app's chord
   * notation (`"Cmd+Shift+Z"`). A key Daintree is bound to stays Daintree's.
   * Keys typed into a text field are left alone unless `allowInInput`.
   */
  export function useHotkeys(hotkeys: readonly Hotkey[], options?: UseHotkeysOptions): void;
  /** A value with an undo history: `push`, `undo`, `redo`, optional coalescing and a step limit. */
  export function useUndoRedo<T>(
    initial: T | (() => T),
    options?: UseUndoRedoOptions
  ): UseUndoRedoResult<T>;
  /** Open/closed state, controlled or not, shaped to spread onto a kit overlay. */
  export function useDisclosure(options?: UseDisclosureOptions): UseDisclosureResult;
  /** `value` once it has stopped changing for `delayMs` (300 by default). */
  export function useDebouncedValue<T>(value: T, delayMs?: number): T;
  /** `callback`, run once calls stop for `delayMs`, with `cancel`, `flush` and `isPending`. */
  export function useDebouncedCallback<A extends unknown[]>(
    callback: (...args: A) => void,
    delayMs?: number,
    options?: UseDebouncedCallbackOptions
  ): DebouncedCallback<A>;
  /**
   * `useState` the view remembers across unmounts, reloads and restarts,
   * stored on the panel through the host. Values must be JSON.
   */
  export function usePersistentViewState<T>(
    key: string,
    initial: T | (() => T)
  ): [T, (next: T | ((current: T) => T)) => void];
  /** Toasts in the app's toaster, named for your plugin, with an optional action or Undo. */
  export function useToast(): UseToastResult;
  /** A small confirm anchored to `trigger`, for actions that are cheap to undo. The trigger shows while the kit loads. */
  export const ConfirmPopover: ComponentType<ConfirmPopoverProps>;
}
