import React, { useState, useEffect, useRef, type CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWindowControlsInset, useTitleBarSurface } from "@/components/ui/WindowControlsInset";
import { restoreFocusTo } from "@/lib/accessibility";
import { isLinux } from "@/lib/platform";
import { BANNER_TINT_ALPHA, type BannerSeverity } from "@shared/config/windowChrome";

type ButtonVariant = "primary" | "accent" | "dismiss" | "danger" | "dangerFilled";

const TINT_PERCENT = `${BANNER_TINT_ALPHA * 100}%`;

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

/**
 * Aliased to the shared scale so the main process can map the same severities
 * onto the native Windows caption strip (#11766).
 */
export type InlineStatusBannerSeverity = BannerSeverity;

type BannerIcon = React.ComponentType<{ className?: string; style?: CSSProperties }>;

interface BaseInlineStatusBannerProps {
  /**
   * The glyph is the severity's non-colour channel, so it defaults per
   * severity to the same vocabulary the notification inbox uses. Pass one only
   * when the glyph is the message itself — a spinner for "restarting", a file
   * for "files changed" — never to restate the severity.
   */
  icon?: BannerIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  contextLine?: string;
  animated?: boolean;
  className?: string;
  role?: "alert" | "status";
  ariaLive?: "off" | "polite" | "assertive";
  /** Accessible label for the dismiss button. Defaults to "Dismiss". */
  closeAriaLabel?: string;
  /**
   * Non-button control rendered alongside the actions (e.g. a Popover
   * trigger). Rendered first in the controls row, before the action buttons
   * and the dismiss button. This is the escape hatch for surfacing secondary
   * affordances on an error banner without breaking the single-action rule.
   * Render it with `Button` so it shares the row's geometry.
   */
  trailingSlot?: React.ReactNode;
  /**
   * Interactive content rendered as a sibling after the description
   * paragraph. Use this instead of nesting buttons/links inside
   * `description` (which would produce invalid `<p>` markup). Passing
   * this forces the multi-line layout even without a `description`.
   */
  descriptionExtras?: React.ReactNode;
}

/**
 * The dismissal surface, in the shape every severity but `success` gets:
 * both halves optional, because a persistent banner is a legitimate thing
 * for an error or a warning to be.
 */
interface OptionalDismissProps {
  onClose?: () => void;
  /**
   * Fire `onClose` automatically after this many milliseconds. The timer
   * clears on unmount and restarts when this value changes; a new `onClose`
   * is picked up through a ref without restarting it. Pass `undefined` to
   * disable (callers gate their own conditions this way).
   */
  autoDismissAfter?: number;
}

/**
 * `severity="success"` is pinned to transient confirmation by construction
 * (#12002): green is only allowed to say "this just happened", never "things
 * are fine", so a success banner has to state how it leaves. Requiring the
 * timer and the handler it fires makes that structural rather than advisory
 * — there is no way to spell a success banner that stands. Completion that
 * genuinely needs to persist is `severity="neutral"`, which is what
 * `AgentCompletionBanner` already uses.
 */
interface RequiredDismissProps {
  onClose: () => void;
  autoDismissAfter: number;
}

/**
 * The action surface is gated on `severity`. Error banners follow the
 * CLAUDE.md Title-Message-Action rule — at most one contextual `action`
 * plus the optional close. The `actions?: never` here makes the
 * single-action limit enforceable at the type level rather than only in
 * prose: passing `actions` on an error banner is a compile error.
 * Surface any demoted affordances through `trailingSlot`.
 */
interface ErrorActionProps {
  action?: BannerAction;
  actions?: never;
}

/**
 * Non-error banners (warning / info / success / neutral) are not bound by
 * the single-action rule and may pass an `actions` array, or the single
 * `action` convenience prop (handy for callers whose severity is computed
 * dynamically and may resolve to either branch).
 */
interface NonErrorActionProps {
  action?: BannerAction;
  actions?: BannerAction[];
}

export type InlineStatusBannerProps = BaseInlineStatusBannerProps &
  (
    | ({ severity: "error" } & ErrorActionProps & OptionalDismissProps)
    | ({ severity: "success" } & NonErrorActionProps & RequiredDismissProps)
    | ({
        severity: Exclude<InlineStatusBannerSeverity, "error" | "success">;
      } & NonErrorActionProps &
        OptionalDismissProps)
  );

const SEVERITY_VAR: Record<Exclude<InlineStatusBannerSeverity, "neutral">, string> = {
  error: "--color-status-error",
  warning: "--color-status-warning",
  info: "--color-status-info",
  success: "--color-status-success",
};

/**
 * One glyph per severity, matching `NotificationCenterEntry` so a banner and
 * the inbox row it may also produce read as the same event. Shape, not hue,
 * is what tells a red banner from an amber one under forced colours.
 */
export const SEVERITY_ICON: Record<InlineStatusBannerSeverity, BannerIcon> = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
  neutral: Info,
};

/**
 * Banner actions are ordinary `Button`s so the family shares one geometry
 * with every other control in the app. The names here are the banner's own
 * vocabulary — what the action *means* on a banner — mapped onto the
 * primitive's variants; severity is carried by the band, so even the
 * "primary" treatment is neutral.
 */
const BUTTON_VARIANT: Record<ButtonVariant, NonNullable<ButtonProps["variant"]>> = {
  primary: "outline",
  accent: "ghost-info",
  dismiss: "ghost",
  danger: "ghost-danger",
  // Every caller uses this for the *fix* on an error banner — Retry, Reload,
  // Restart — which is the primary action, not a destructive one.
  dangerFilled: "outline",
};

export function InlineStatusBanner({
  icon,
  title,
  description,
  contextLine,
  severity = "error",
  animated = true,
  className,
  action,
  actions,
  role = "alert",
  ariaLive,
  onClose,
  closeAriaLabel = "Dismiss",
  trailingSlot,
  descriptionExtras,
  autoDismissAfter,
}: InlineStatusBannerProps) {
  // Non-null only in the global banner host, where this banner owns the
  // window's title-bar band: it has to supply the drag region and top-edge
  // resize strip the toolbar normally provides (both get pushed below the
  // caption buttons while a banner is up), and report its severity so the
  // native caption strip can be tinted to match. Inline banners get none of
  // this — a banner inside a terminal must never drag the window.
  const reportSeverity = useTitleBarSurface();
  const isTitleBarSurface = reportSeverity !== null;

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    // `matchMedia` is guarded separately from `window`: the SSR check above only
    // covers `window` being absent entirely, but a jsdom environment has a
    // `window` with no `matchMedia` implementation. Calling it there threw and
    // took the whole banner subtree down with it — which, for a component this
    // widely mounted, turns one missing test-env stub into an unrelated-looking
    // render failure somewhere else on the page.
    ((typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
      (typeof document !== "undefined" &&
        (document.body.getAttribute("data-reduce-animations") === "true" ||
          document.body.getAttribute("data-performance-mode") === "true")));
  // The title-bar surface never slides in: main tints the native caption strip
  // the instant the severity is reported, and a banner easing in under an
  // already-tinted strip reads as two surfaces disagreeing. Inline banners
  // keep their entrance.
  const shouldAnimate = animated && !prefersReducedMotion && !isTitleBarSurface;

  const [isVisible, setIsVisible] = useState(!shouldAnimate);
  const rafRef = useRef<number | null>(null);
  const isNeutral = severity === "neutral";
  const colorVar = isNeutral ? undefined : SEVERITY_VAR[severity];
  const IconComponent = icon ?? SEVERITY_ICON[severity];

  // When hosted at the top of the window (global banner host), reserve space so
  // the title/icon and action buttons never sit under the OS window controls.
  // Empty for the common inline usage — see WindowControlsInset.
  const windowControlsInset = useWindowControlsInset();

  useEffect(() => {
    if (!reportSeverity) return;
    reportSeverity(severity);
    return () => reportSeverity(null);
  }, [reportSeverity, severity]);

  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (import.meta.env.DEV && severity === "success" && !(autoDismissAfter! > 0)) {
      console.warn(
        'InlineStatusBanner: severity="success" needs a positive autoDismissAfter. ' +
          `Got ${String(autoDismissAfter)}, so this banner will stand — which is the one ` +
          'thing a success banner may not do. Use severity="neutral" for persistent completion.'
      );
    }
    if (!(autoDismissAfter! > 0) || !onCloseRef.current) return;
    const timer = setTimeout(() => onCloseRef.current?.(), autoDismissAfter);
    return () => clearTimeout(timer);
  }, [autoDismissAfter, severity]);

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

  const rootRef = useRef<HTMLDivElement>(null);

  const actionList: BannerAction[] = actions ?? (action ? [action] : []);

  const hasDescription = description || contextLine || descriptionExtras;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    // A keyboard dismissal unmounts the control that holds focus, which would
    // drop focus on <body> and strand the user at the top of the document.
    // The unmount lands after this handler returns, so check on the next
    // frame: if the banner is gone and focus went with it, hand it to the app
    // shell's first tabbable. A pointer dismissal moved focus with the click.
    const root = rootRef.current;
    const hadFocus = !!root && root.contains(document.activeElement);
    onClose?.();
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      if (root?.isConnected) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      restoreFocusTo();
    });
  };

  const closeButton = onClose ? (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={handleClose}
      aria-label={closeAriaLabel}
      className={cn("shrink-0", isTitleBarSurface && "app-no-drag")}
    >
      <X aria-hidden="true" />
    </Button>
  ) : null;

  const showControlsRow = !!trailingSlot || (!hasDescription && !!onClose) || actionList.length > 0;

  return (
    <div
      ref={rootRef}
      className={cn(
        hasDescription
          ? "flex flex-col gap-2 px-3 py-2 shrink-0"
          : "flex items-center justify-between gap-3 px-3 py-2 shrink-0",
        // Scoped, not bare: `transition` carries box-shadow, every colour
        // property and filter along with it, and this banner's entry is an
        // opacity-and-slide. 250ms is BANNER_ENTER_DURATION from the motion
        // scale, which is what generates this utility.
        shouldAnimate && "transition-[opacity,translate] duration-250",
        shouldAnimate && (isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"),
        isNeutral && "bg-overlay-subtle",
        // The native caption strip is a fixed 48px tall. A shorter banner would
        // let the tint applied to that strip bleed over the toolbar beneath it,
        // so a title-bar banner always fills the band it is colouring.
        isTitleBarSurface && "relative min-h-12 app-drag-region",
        className
      )}
      style={{
        ...(isNeutral
          ? undefined
          : {
              backgroundColor: `color-mix(in oklab, var(${colorVar}) ${TINT_PERCENT}, transparent)`,
              borderBottom: `1px solid color-mix(in oklab, var(${colorVar}) 20%, transparent)`,
            }),
        ...windowControlsInset,
      }}
      role={role}
      aria-live={ariaLive}
      aria-atomic={ariaLive && ariaLive !== "off" ? "true" : undefined}
    >
      {isTitleBarSurface && !isLinux() && <div className="window-resize-strip" />}
      {/* The band's tint and this glyph carry the severity; the text does not.
          Severity-coloured type failed 4.5:1 on most themes, and a title that
          is only legible on some of them is not a title. */}
      <div className="flex items-start gap-2 min-w-0">
        <IconComponent
          className={cn("w-4 h-4 shrink-0 mt-0.5", isNeutral && "text-text-secondary")}
          style={isNeutral ? undefined : { color: `var(${colorVar})` }}
          aria-hidden="true"
        />
        {hasDescription ? (
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-2">
              <span className="text-sm font-medium text-text-primary">{title}</span>
              {closeButton && <div className="-mt-1 -mr-1">{closeButton}</div>}
            </div>
            {description && (
              <p className="text-xs mt-0.5 break-words text-text-secondary">{description}</p>
            )}
            {contextLine && (
              <p
                className="text-xs font-mono mt-1 truncate text-text-secondary"
                title={contextLine}
              >
                {contextLine}
              </p>
            )}
            {isTitleBarSurface && descriptionExtras ? (
              <div className="app-no-drag">{descriptionExtras}</div>
            ) : (
              descriptionExtras
            )}
          </div>
        ) : (
          <span className="text-sm font-medium text-text-primary">{title}</span>
        )}
      </div>

      {showControlsRow && (
        <div
          className={cn(
            "flex items-center shrink-0",
            hasDescription ? "gap-2 ml-6" : "gap-1",
            // `.app-no-drag *` carries the opt-out down to every control in the
            // row, including nested popover triggers.
            isTitleBarSurface && "app-no-drag"
          )}
        >
          {trailingSlot}
          {actionList.map((action) => {
            const variant = BUTTON_VARIANT[action.variant ?? "primary"];
            const buttonEl = (
              <Button
                key={action.id}
                variant={variant}
                size={action.iconOnly ? "icon-sm" : "sm"}
                disabled={action.disabled}
                loading={action.loading}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                }}
                aria-label={action.ariaLabel}
              >
                {action.icon && <action.icon aria-hidden="true" />}
                {!action.iconOnly && action.label}
              </Button>
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
          {/* Dismiss sits after the actions, at the row's end, in both layouts —
              never between two controls, where it reads as a third action. */}
          {!hasDescription && closeButton}
        </div>
      )}
    </div>
  );
}
