import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

/** The confirmation every copy control shows. Never "Copied!". */
export const COPIED_LABEL = "Copied";
/** What a labelled copy shows, and every copy announces, when the write is refused. */
export const COPY_FAILED_LABEL = "Couldn't copy";

interface CopyButtonBaseProps extends Omit<
  ButtonProps,
  "variant" | "size" | "children" | "asChild" | "type" | "title" | "aria-label"
> {
  /**
   * What lands on the clipboard. A function is read at click time, for a
   * payload too costly to build on every render (a serialised log entry) or
   * one that has to be re-read first (a key that may have rotated). A function
   * that throws or rejects counts as a failed copy.
   */
  text: string | (() => string | Promise<string>);
  /** Tooltip text. An icon-only button defaults to its accessible name; a labelled one has none. */
  tooltip?: React.ReactNode;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
  /** Polite announcement on success. Defaults to the hook's "Copied". */
  announcement?: string;
  /** The clipboard write, for panes that go through the main process. */
  write?: (text: string) => Promise<unknown>;
  /**
   * The caller reports failures itself (a settings row's error line). The
   * button then skips its own "Couldn't copy" label and announcement, so the
   * failure is stated once. Receives what the payload function threw, or the
   * clipboard's refusal.
   */
  onCopyError?: (error: unknown) => void;
  /** Runs once the write lands, for a caller clearing an earlier failure. */
  onCopied?: () => void;
}

interface IconCopyButtonProps extends CopyButtonBaseProps {
  label?: undefined;
  /**
   * Constant for the life of the button. It never flips to "Copied": the hook
   * announces the copy through the polite live region, and a name that changes
   * under focus is announced a second time.
   */
  "aria-label": string;
  variant?: undefined;
  /** `icon-xs` (24px) by default; `icon-sm` in a row of `icon-sm` actions. */
  size?: "icon-xs" | "icon-sm";
}

interface LabelledCopyButtonProps extends CopyButtonBaseProps {
  /** The visible verb-noun ("Copy MCP config"). Swaps to "Copied" for the dwell. */
  label: string;
  /** Defaults to `label`. Constant, for the same reason as the icon form's. */
  "aria-label"?: string;
  /**
   * `ghost` `xs` standing beside a payload, `outline` `sm` on a settings row
   * or rail, otherwise whatever the button group it sits in uses.
   */
  variant?: "ghost" | "outline" | "subtle" | "contrast";
  size?: "xs" | "sm" | "default";
}

const SIZER_CLASS = "invisible col-start-1 row-start-1 after:content-[attr(data-label)]";

export type CopyButtonProps = IconCopyButtonProps | LabelledCopyButtonProps;

/**
 * The one copy control, in two shapes.
 *
 * Icon-only (no `label`): a ghost `icon-xs` button (24px target) with a 14px
 * glyph that swaps to a check for the success dwell.
 *
 * Labelled (`label`): the glyph plus the label, which reads "Copied" for the
 * dwell and "Couldn't copy" when the clipboard refuses the write. The label
 * slot is sized to the widest of those, so the button holds its width through
 * the confirmation and its neighbours don't slide.
 *
 * The check is neutral. The glyph swap and the announcement carry the
 * confirmation; green on some copy buttons and not others was the
 * inconsistency this replaced. A refused write is announced assertively in
 * both shapes, since the next paste would otherwise be the previous value.
 *
 * For a string `text`, the check only shows while `copiedText` is the current
 * value, so a value that changes under the button (a re-rooted path, a new
 * endpoint) never inherits the previous copy's confirmation. `data-copied` is set for the
 * same window, so a hover-revealed caller can hold the button visible while
 * it confirms (`data-copied:opacity-100`).
 *
 * `onClick` runs first; a handler that calls `preventDefault()` cancels the
 * copy, and one that stops propagation keeps the row behind it untouched.
 */
export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>((props, ref) => {
  const {
    text,
    tooltip,
    tooltipSide = "top",
    announcement,
    write,
    onCopyError,
    onCopied,
    className,
    onClick,
    label,
    ...rest
  } = props;
  const labelled = label !== undefined;
  const {
    variant = "ghost",
    size,
    ...buttonProps
  } = rest as Omit<
    IconCopyButtonProps | LabelledCopyButtonProps,
    keyof CopyButtonBaseProps | "label"
  >;
  const ariaLabel = buttonProps["aria-label"] ?? label;

  // The hook reports a refusal as `false`; the reason is kept here so a caller
  // stating the failure itself can say what the clipboard said.
  const writeErrorRef = React.useRef<unknown>(null);
  const { copiedText, copy } = useCopyWithFeedback({
    ...(announcement === undefined ? {} : { announcement }),
    write: async (value: string) => {
      try {
        return await (write ? write(value) : navigator.clipboard.writeText(value));
      } catch (error) {
        writeErrorRef.current = error;
        throw error;
      }
    },
  });
  // A refusal outranks an earlier success still in its dwell: the clipboard
  // no longer holds what that check described.
  const [failed, setFailed] = React.useState(false);
  const copied =
    !failed && copiedText !== null && (typeof text === "function" || copiedText === text);
  React.useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(false), UI_ACTION_SUCCESS_DWELL_MS);
    return () => clearTimeout(timer);
  }, [failed]);

  // Only the latest click may write or report, and nothing after unmount: an
  // async payload that resolves late would otherwise overwrite a newer copy,
  // or report into a surface that has moved on.
  const attemptRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fail = (error: unknown) => {
    setFailed(true);
    if (onCopyError) {
      onCopyError(error);
      return;
    }
    useAnnouncerStore.getState().announce(COPY_FAILED_LABEL, "assertive");
  };

  const run = async () => {
    const attempt = ++attemptRef.current;
    const current = () => mountedRef.current && attempt === attemptRef.current;
    setFailed(false);
    let payload: string;
    try {
      payload = typeof text === "function" ? await text() : text;
    } catch (error) {
      if (current()) fail(error);
      return;
    }
    if (!current()) return;
    writeErrorRef.current = null;
    const ok = await copy(payload);
    if (!current()) return;
    if (ok) onCopied?.();
    else fail(writeErrorRef.current ?? new Error("The clipboard rejected the write."));
  };
  const showFailure = failed && !onCopyError;

  const glyph = copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />;
  const button = (
    <Button
      ref={ref}
      variant={labelled ? variant : "ghost"}
      size={size ?? (labelled ? "xs" : "icon-xs")}
      className={cn(labelled || size ? "shrink-0" : "shrink-0 [&_svg]:size-3.5", className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        void run();
      }}
      {...buttonProps}
      aria-label={ariaLabel}
      data-copied={copied || undefined}
    >
      {glyph}
      {labelled && (
        <span className="grid">
          <span className="col-start-1 row-start-1">
            {copied ? COPIED_LABEL : showFailure ? COPY_FAILED_LABEL : label}
          </span>
          {/* Sizers: the slot is as wide as the widest word it can show.
              Drawn from an attribute, so they add no text to the button. */}
          <span aria-hidden="true" data-label={label} className={SIZER_CLASS} />
          <span aria-hidden="true" data-label={COPIED_LABEL} className={SIZER_CLASS} />
          {!onCopyError && (
            <span aria-hidden="true" data-label={COPY_FAILED_LABEL} className={SIZER_CLASS} />
          )}
        </span>
      )}
    </Button>
  );

  const tip = labelled ? tooltip : (tooltip ?? ariaLabel);
  if (tip === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tip}</TooltipContent>
    </Tooltip>
  );
});
CopyButton.displayName = "CopyButton";
