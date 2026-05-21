import React, { useState, useEffect, useRef, type CSSProperties } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ButtonVariant = "primary" | "accent" | "dismiss" | "danger" | "dangerFilled";

export interface BannerAction {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  variant?: ButtonVariant;
  onClick: () => void;
  ariaLabel?: string;
  title?: string;
  iconOnly?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

export type InlineStatusBannerSeverity = "error" | "warning" | "info" | "success" | "neutral";

export interface InlineStatusBannerProps {
  icon: React.ComponentType<{ className?: string; style?: CSSProperties }>;
  title: React.ReactNode;
  description?: React.ReactNode;
  contextLine?: string;
  severity?: InlineStatusBannerSeverity;
  animated?: boolean;
  className?: string;
  actions: BannerAction[];
  role?: "alert" | "status";
  ariaLive?: "off" | "polite" | "assertive";
  onClose?: () => void;
  /** Accessible label for the dismiss button. Defaults to "Dismiss". */
  closeAriaLabel?: string;
  /**
   * Non-button control rendered alongside the actions (e.g. a Popover
   * trigger). Rendered first in the controls row, before the dismiss
   * button and the primary action buttons.
   */
  trailingSlot?: React.ReactNode;
  /**
   * Interactive content rendered as a sibling after the description
   * paragraph. Use this instead of nesting buttons/links inside
   * `description` (which would produce invalid `<p>` markup). Passing
   * this forces the multi-line layout even without a `description`.
   */
  descriptionExtras?: React.ReactNode;
  /**
   * Fire `onClose` automatically after this many milliseconds. The timer
   * clears on unmount and resets if the value or `onClose` changes. Pass
   * `undefined` to disable (callers gate their own conditions this way).
   */
  autoDismissAfter?: number;
}

const SEVERITY_VAR: Record<Exclude<InlineStatusBannerSeverity, "neutral">, string> = {
  error: "--color-status-error",
  warning: "--color-status-warning",
  info: "--color-status-info",
  success: "--color-status-success",
};

function getButtonClasses(variant: ButtonVariant): string {
  switch (variant) {
    case "primary":
      return "bg-daintree-border text-daintree-text hover:bg-daintree-border/80";
    case "accent":
      return "bg-status-info/10 text-status-info hover:bg-status-info/20";
    case "dismiss":
      return "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-border/50";
    case "danger":
    case "dangerFilled":
      return "rounded transition-colors";
  }
}

function getButtonStyle(variant: ButtonVariant, colorVar: string): React.CSSProperties | undefined {
  if (variant === "danger") {
    return {
      color: `color-mix(in oklab, var(${colorVar}) 70%, transparent)`,
      ["--hover-color" as string]: `var(${colorVar})`,
      ["--hover-bg" as string]: `color-mix(in oklab, var(${colorVar}) 10%, transparent)`,
    };
  }
  if (variant === "dangerFilled") {
    return {
      backgroundColor: `color-mix(in oklab, var(${colorVar}) 10%, transparent)`,
      color: `var(${colorVar})`,
      ["--hover-bg" as string]: `color-mix(in oklab, var(${colorVar}) 20%, transparent)`,
    };
  }
  return undefined;
}

export function InlineStatusBanner({
  icon: IconComponent,
  title,
  description,
  contextLine,
  severity = "error",
  animated = true,
  className,
  actions,
  role = "alert",
  ariaLive,
  onClose,
  closeAriaLabel = "Dismiss",
  trailingSlot,
  descriptionExtras,
  autoDismissAfter,
}: InlineStatusBannerProps) {
  const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimate = animated && !prefersReducedMotion;

  const [isVisible, setIsVisible] = useState(!shouldAnimate);
  const rafRef = useRef<number | null>(null);
  const isNeutral = severity === "neutral";
  const colorVar = isNeutral ? undefined : SEVERITY_VAR[severity];

  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!autoDismissAfter || !onCloseRef.current) return;
    const timer = setTimeout(() => onCloseRef.current?.(), autoDismissAfter);
    return () => clearTimeout(timer);
  }, [autoDismissAfter]);

  useEffect(() => {
    if (!shouldAnimate) return;

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setIsVisible(true);
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [shouldAnimate]);

  const hasDescription = description || contextLine || descriptionExtras;

  const closeButton = onClose ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      aria-label={closeAriaLabel}
      className="p-1 rounded text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-border/50 transition-colors outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent shrink-0"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  ) : null;

  const showControlsRow = !!trailingSlot || (!hasDescription && !!onClose) || actions.length > 0;

  return (
    <div
      className={cn(
        hasDescription
          ? "flex flex-col gap-2 px-3 py-2 shrink-0"
          : "flex items-center justify-between gap-3 px-3 py-2 shrink-0",
        shouldAnimate && "transition duration-250",
        shouldAnimate && (isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"),
        isNeutral && "bg-overlay-subtle",
        className
      )}
      style={
        isNeutral
          ? undefined
          : {
              backgroundColor: `color-mix(in oklab, var(${colorVar}) 10%, transparent)`,
              borderBottom: `1px solid color-mix(in oklab, var(${colorVar}) 20%, transparent)`,
            }
      }
      role={role}
      aria-live={ariaLive}
      aria-atomic={ariaLive && ariaLive !== "off" ? "true" : undefined}
    >
      <div className={cn("flex", hasDescription ? "items-start" : "items-center", "gap-2 min-w-0")}>
        <IconComponent
          className={cn(
            "w-4 h-4 shrink-0",
            hasDescription && "mt-0.5",
            isNeutral && "text-daintree-text/60"
          )}
          style={isNeutral ? undefined : { color: `var(${colorVar})` }}
          aria-hidden="true"
        />
        {hasDescription ? (
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-2">
              <span
                className={cn("text-sm font-medium", isNeutral && "text-daintree-text")}
                style={isNeutral ? undefined : { color: `var(${colorVar})` }}
              >
                {title}
              </span>
              {closeButton}
            </div>
            {description && (
              <p
                className={cn("text-xs mt-0.5 break-words", isNeutral && "text-daintree-text/70")}
                style={
                  isNeutral
                    ? undefined
                    : { color: `color-mix(in oklab, var(${colorVar}) 80%, transparent)` }
                }
              >
                {description}
              </p>
            )}
            {contextLine && (
              <p
                className={cn(
                  "text-xs font-mono mt-1 truncate",
                  isNeutral && "text-daintree-text/60"
                )}
                style={
                  isNeutral
                    ? undefined
                    : { color: `color-mix(in oklab, var(${colorVar}) 60%, transparent)` }
                }
                title={contextLine}
              >
                {contextLine}
              </p>
            )}
            {descriptionExtras}
          </div>
        ) : (
          <span
            className={cn("text-sm", isNeutral && "text-daintree-text")}
            style={isNeutral ? undefined : { color: `var(${colorVar})` }}
          >
            {title}
          </span>
        )}
      </div>

      {showControlsRow && (
        <div className={cn("flex items-center shrink-0", hasDescription ? "gap-2 ml-6" : "gap-1")}>
          {trailingSlot}
          {!hasDescription && closeButton}
          {actions.map((action) => {
            const variant = action.variant ?? "primary";
            const variantClasses = getButtonClasses(variant);
            const variantStyle = colorVar ? getButtonStyle(variant, colorVar) : undefined;
            const isDisabled = action.disabled || action.loading;
            const iconClasses = action.iconOnly ? "w-3.5 h-3.5" : "w-3 h-3";
            const spinnerSize = action.iconOnly ? "sm" : "xs";
            const buttonEl = (
              <button
                key={action.id}
                type="button"
                disabled={isDisabled}
                aria-busy={action.loading || undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isDisabled) return;
                  action.onClick();
                }}
                className={cn(
                  action.iconOnly
                    ? "p-1"
                    : "flex items-center gap-1.5 px-2 py-1 text-xs font-medium",
                  "transition-colors outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent",
                  variantClasses,
                  (variant === "danger" || variant === "dangerFilled") &&
                    "hover:[color:var(--hover-color)] hover:[background:var(--hover-bg)]",
                  isDisabled && "cursor-not-allowed opacity-60 hover:bg-transparent"
                )}
                style={variantStyle}
                aria-label={action.ariaLabel}
              >
                {action.loading ? (
                  <Spinner size={spinnerSize} />
                ) : (
                  action.icon && <action.icon className={iconClasses} aria-hidden="true" />
                )}
                {!action.iconOnly && action.label}
              </button>
            );

            return action.title ? (
              <Tooltip key={action.id}>
                <TooltipTrigger asChild>{buttonEl}</TooltipTrigger>
                <TooltipContent side="bottom">{action.title}</TooltipContent>
              </Tooltip>
            ) : (
              <React.Fragment key={action.id}>{buttonEl}</React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
