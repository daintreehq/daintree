import { isValidElement, type ChangeEvent } from "react";
import type {
  PluginAvatarProps,
  PluginPopoverProps,
  PluginPopoverSearchFieldProps,
  PluginSkeletonHintProps,
} from "@shared/types/plugin-sdk-react";
import { Avatar } from "@/components/ui/Avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import {
  ALIGNS,
  SIDES,
  fn,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  PluginStyleScope,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

const AVATAR_SIZE = {
  xs: "h-4 w-4",
  sm: "h-5 w-5",
  md: "h-6 w-6",
  lg: "h-8 w-8",
} as const;

/** "Ada Lovelace" → "AL", "octocat" → "O", "@dependabot[bot]" → "D". */
export function avatarInitials(name: string, max: 1 | 2 = 2): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0]!.charAt(0);
  const last = max === 2 && words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}

function KitAvatar({ src, name, size, shape, tooltip, decorative, className }: PluginAvatarProps) {
  const label = str(name) ?? "";
  const px = oneOf(size, ["xs", "sm", "md", "lg"] as const) ?? "sm";
  // Two letters only where they fit at a legible size; a 16–20px disc takes one.
  const initials = avatarInitials(label, px === "xs" || px === "sm" ? 1 : 2);
  return (
    <Avatar
      src={str(src) ?? ""}
      alt={decorative === true ? "" : label}
      title={nonEmpty(tooltip)}
      shape={oneOf(shape, ["circle", "square"] as const)}
      className={cn(AVATAR_SIZE[px], str(className))}
      fallback={
        initials ? (
          <span
            aria-hidden="true"
            className={cn("font-medium leading-none", px === "lg" ? "text-2xs" : "text-3xs")}
          >
            {initials}
          </span>
        ) : undefined
      }
    />
  );
}

const POPOVER_WIDTH = {
  sm: "w-56",
  md: "w-72",
  lg: "w-96",
  trigger: "w-[var(--radix-popover-trigger-width)]",
  auto: "w-auto",
} as const;

function KitPopover({
  trigger,
  children,
  side,
  align,
  open,
  defaultOpen,
  onOpenChange,
  width,
  padding,
  "aria-label": ariaLabel,
  onCloseAutoFocus,
}: PluginPopoverProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  if (!isValidElement(trigger)) return null;
  const closeAutoFocus = fn(onCloseAutoFocus);
  const widthKey = oneOf(width, ["sm", "md", "lg", "trigger", "auto"] as const) ?? "md";
  const panel = {
    ...owner,
    side: oneOf(side, SIDES),
    align: oneOf(align, ALIGNS),
    "aria-label": str(ariaLabel),
    onCloseAutoFocus: closeAutoFocus ? (event: Event) => closeAutoFocus(event) : undefined,
    className: cn(
      POPOVER_WIDTH[widthKey],
      // A narrow window must not push the panel off screen; a tall body scrolls.
      "max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto",
      padding === "none" ? "p-0" : "p-3",
      overlayZ
    ),
    children: <PluginStyleScope block>{node(children)}</PluginStyleScope>,
  };
  return (
    <Popover
      open={typeof open === "boolean" ? open : undefined}
      defaultOpen={typeof defaultOpen === "boolean" ? defaultOpen : undefined}
      onOpenChange={fn(onOpenChange)}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {widthKey === "trigger" ? (
        // As wide as its trigger, it unrolls from it rather than zooming out of a corner.
        <PopoverContent {...panel} motion="drop" />
      ) : (
        <PopoverContent {...panel} />
      )}
    </Popover>
  );
}

function KitPopoverSearchField({
  value,
  onValueChange,
  onClear,
  placeholder,
  "aria-label": ariaLabel,
  clearLabel,
  autoFocus,
  disabled,
  onChange,
  ...rest
}: PluginPopoverSearchFieldProps) {
  const handleChange = fn(onChange);
  const handleValue = fn(onValueChange);
  return (
    <PopoverSearchField
      {...pickDomProps(rest)}
      value={str(value) ?? ""}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        handleChange?.(event);
        handleValue?.(event.target.value);
      }}
      onClear={fn(onClear)}
      placeholder={str(placeholder)}
      aria-label={str(ariaLabel)}
      clearLabel={nonEmpty(clearLabel)}
      autoFocus={autoFocus === true}
      disabled={disabled === true}
    />
  );
}

function threshold(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function KitSkeletonHint({
  message,
  onCancel,
  onRetry,
  firstThreshold,
  secondThreshold,
  actionThreshold,
  className,
}: PluginSkeletonHintProps) {
  return (
    <SkeletonHint
      message={nonEmpty(message)}
      onCancel={fn(onCancel)}
      onRetry={fn(onRetry)}
      firstThreshold={threshold(firstThreshold)}
      secondThreshold={threshold(secondThreshold)}
      actionThreshold={threshold(actionThreshold)}
      className={str(className)}
    />
  );
}

export const pluginKitOverlays = {
  Avatar: KitAvatar,
  Popover: KitPopover,
  PopoverSearchField: KitPopoverSearchField,
  SkeletonHint: KitSkeletonHint,
};
