// The runtime of `@daintreehq/plugin-ui`, served to plugin views through the
// host import map. Every export here is public contract: vite.config.ts pins
// the names in HOST_FACADE_REQUIRED_EXPORTS and the SDK declares their types in
// packages/plugin-sdk/plugin-ui.d.ts. Nothing here may import app code
// statically; the host components load through `fromKit`.
import { isValidElement, type ComponentType } from "react";
import type {
  PluginBadgeProps,
  PluginButtonProps,
  PluginCalloutProps,
  PluginCheckboxProps,
  PluginConfirmDialogProps,
  PluginCopyButtonProps,
  PluginDialogProps,
  PluginDismissButtonProps,
  PluginDropdownMenuProps,
  PluginEmptyStateProps,
  PluginIconButtonProps,
  PluginIconProps,
  PluginInputProps,
  PluginKbdChordProps,
  PluginKbdProps,
  PluginScrollShadowProps,
  PluginSearchFieldProps,
  PluginSegmentedControlProps,
  PluginSelectProps,
  PluginSkeletonBoneProps,
  PluginSkeletonProps,
  PluginSkeletonTextProps,
  PluginSpinnerProps,
  PluginSpinningIconProps,
  PluginTextareaProps,
  PluginTooltipProps,
  PluginTruncatedTooltipProps,
} from "@shared/types/plugin-sdk-react";
import { fromKit } from "./kit";

export { Markdown } from "./Markdown";
export { getDaintreeTheme, onDidChangeDaintreeTheme, useDaintreeTheme } from "./theme";

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
} from "@shared/types/plugin-sdk-react";
