import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PALETTE_HEADER_ATTR } from "@/components/ui/paletteHeaderAttr";
import { PALETTE_SURFACE_WIDTHS, type PaletteSurfaceTier } from "@/components/ui/AppPaletteDialog";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";

/**
 * The anchored half of the palette shell.
 *
 * `AppPaletteDialog` can only be a centred modal over a scrim, so every
 * selector that hangs off the control that opened it used to rebuild the same
 * wiring by hand — open focus into the search box, focus return on keyboard
 * dismissal but not pointer dismissal, Escape that clears before it closes.
 * This carries those rules once; consumers bring the content and the policy
 * flags. Both forms render the same `AppPaletteDialog.Header/Body/Footer`
 * compound parts.
 *
 * Deliberately NOT wired into `useEscapeStack`, `registerDialogEscapeBackstop`,
 * `clearDialogOverlays` or the tooltip dismiss registry: that machinery keys off
 * `AppDialog`/`AppPaletteDialog` open/close transitions, and extending it to
 * popover-type overlays was considered and rejected in #11034 because it
 * misfires on unrelated interactions. Radix's own dismissal is the only
 * mechanism here.
 */

interface AnchoredPaletteContextValue {
  isOpen: boolean;
  modal: boolean;
}

const AnchoredPaletteContext = createContext<AnchoredPaletteContextValue | null>(null);

function useAnchoredPaletteContext(): AnchoredPaletteContextValue {
  const context = useContext(AnchoredPaletteContext);
  if (!context) {
    throw new Error("AppPalettePopover.Content must be rendered inside AppPalettePopover");
  }
  return context;
}

/**
 * Close when a foreign overlay stacks above an open palette.
 *
 * The baseline is re-established every time the palette opens (and every time a
 * palette opts in), then compared against, so an overlay that was already up —
 * or one raised in the same commit as the open — is never mistaken for
 * something stacking on top. The palette itself never claims a slot (see the
 * `modal` note below), so it cannot trip its own watcher either.
 */
function useForeignOverlayDismissal(
  isOpen: boolean,
  enabled: boolean,
  onOpenChange: (open: boolean) => void
) {
  // Selector returns a constant while disabled, so a palette that doesn't opt
  // in never re-renders on unrelated overlay traffic. The null baseline below
  // is what keeps that sentinel from reading as "the stack just emptied".
  const overlayStackLength = useUIStore((state) => (enabled ? state.overlayStack.length : 0));
  const baselineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !isOpen) {
      baselineRef.current = null;
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = overlayStackLength;
      return;
    }
    if (overlayStackLength > baselineRef.current) {
      onOpenChange(false);
      return;
    }
    baselineRef.current = overlayStackLength;
  }, [enabled, isOpen, overlayStackLength, onOpenChange]);
}

export interface AppPalettePopoverProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Radix's two content primitives, not a presentation flag: `true` renders
   * `PopoverContentModal` (focus trap, outside pointer events disabled,
   * siblings aria-hidden) and `false` renders `PopoverContentNonModal` (Tab
   * leaves naturally, the first outside click also activates what it hit).
   * Required with no default so a new selector has to make the choice
   * deliberately.
   */
  modal: boolean;
  /**
   * Close when something else stacks above the palette — a confirm dialog
   * opened from one of its own rows, say. Off by default: a modal palette
   * already owns the viewport through Radix, so only the non-modal form
   * generally needs it.
   */
  dismissOnForeignOverlay?: boolean;
  children: React.ReactNode;
}

export function AppPalettePopover({
  isOpen,
  onOpenChange,
  modal,
  dismissOnForeignOverlay = false,
  children,
}: AppPalettePopoverProps) {
  useForeignOverlayDismissal(isOpen, dismissOnForeignOverlay, onOpenChange);

  const context = useMemo(() => ({ isOpen, modal }), [isOpen, modal]);

  return (
    <AnchoredPaletteContext.Provider value={context}>
      <Popover open={isOpen} onOpenChange={onOpenChange} modal={modal}>
        {children}
      </Popover>
    </AnchoredPaletteContext.Provider>
  );
}

AppPalettePopover.Trigger = PopoverTrigger;

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverContent>;

export interface AppPalettePopoverContentProps extends Omit<
  PopoverContentProps,
  | "onOpenAutoFocus"
  | "onCloseAutoFocus"
  | "onPointerDownOutside"
  | "aria-label"
  // Derived from `modal`. A caller free to set it independently could
  // advertise a non-trapped, pointer-permeable surface as modal.
  | "aria-modal"
> {
  /**
   * Radix renders the content as `role="dialog"`. Without a name a screen
   * reader announces a generic dialog before reaching the search box, so match
   * the visible header and speech control can target it by the word on screen.
   */
  ariaLabel: string;
  /**
   * Which tier of surface this is. Required and never inferred — most anchored
   * palettes want `"anchored"`, but the tier tracks the palette's weight rather
   * than its host, so a genuinely global surface that happens to hang off a
   * button still says so.
   */
  tier: PaletteSurfaceTier;
  /** The palette's search box. Focus is driven into it on every open. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Called when the first Escape spends itself clearing a non-empty query. */
  onClearQuery: () => void;
  /**
   * Leave Radix's own close-autofocus policy alone when the palette was
   * dismissed by pointer, rather than cancelling it. Off by default — letting
   * a pointer dismissal restore focus leaves the trigger wearing a
   * focus-visible ring nobody asked for (#6119). Keyboard dismissal always
   * keeps the default return, per WAI-ARIA.
   *
   * This only decides whether the shell suppresses; it cannot manufacture a
   * restore Radix wasn't going to perform (non-modal content does not focus the
   * trigger after an outside interaction).
   */
  restoreFocusOnPointerDismiss?: boolean;
  /**
   * Asked once per close whether this particular close must not bounce focus
   * back to the trigger. Activating a row is an inside close, so Radix has no
   * event that tells it apart from Escape — the palette that just launched
   * something is the only thing that knows focus is already travelling.
   *
   * Separate from `restoreFocusOnPointerDismiss` rather than folded into it:
   * that flag is a standing policy about how pointer dismissals should look,
   * this is one close that must not bounce. Named for the side effect — the
   * shell asks exactly once per close, including closes the pointer branch was
   * going to suppress anyway, so the answer can be disarmed on the same call.
   *
   * Decide per close rather than arming and waiting to be asked: reopening
   * inside the content's exit animation cancels Radix's unmount, so that close
   * never reaches close-autofocus and an armed answer would survive to be spent
   * on the next dismissal.
   */
  consumeCloseAutoFocusSuppression?: () => boolean;
  /**
   * Fired before Radix restores focus, for triggers that have to suppress
   * something on the way out (a tooltip that would re-open on focus). The shell
   * keeps ownership of the Radix event itself.
   */
  onCloseAutoFocus?: () => void;
}

function AppPalettePopoverContent({
  ariaLabel,
  tier,
  inputRef,
  onClearQuery,
  restoreFocusOnPointerDismiss = false,
  consumeCloseAutoFocusSuppression,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onFocus,
  onMouseDown,
  className,
  children,
  ...props
}: AppPalettePopoverContentProps) {
  const { isOpen, modal } = useAnchoredPaletteContext();

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef]);

  // Set in onPointerDownOutside, read in onCloseAutoFocus.
  const wasPointerCloseRef = useRef(false);

  // Second focus attempt behind `onOpenAutoFocus`. `PopoverContent` renders
  // nothing until its lazily imported Radix chunk resolves, so on a cold open
  // this frame can fire before the input exists; on a warm one it runs after
  // the mount handler already focused it and is a harmless no-op. Neither
  // covers both orders alone — dropping either regresses one of them.
  useEffect(() => {
    if (!isOpen) return;
    // A dismissal that got vetoed, or one reversed mid-exit, can leave the
    // pointer flag armed with no close-autofocus to consume it.
    //
    // Only this flag: `consumeCloseAutoFocusSuppression` is the consumer's to
    // keep current, and reopening inside the exit animation cancels the unmount
    // outright rather than leaving a close-autofocus in flight.
    wasPointerCloseRef.current = false;
    const frame = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, focusInput]);

  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      const element = inputRef.current;
      // Nothing to hand focus to yet — leave Radix's own autofocus alone rather
      // than cancelling it and stranding focus on nothing.
      if (!element) return;
      // Radix would otherwise focus the content wrapper; the search box is what
      // the user is about to type into.
      event.preventDefault();
      element.focus({ preventScroll: true });
    },
    [inputRef]
  );

  const handlePointerDownOutside = useCallback(() => {
    wasPointerCloseRef.current = true;
  }, []);

  const handleInteractOutside = useCallback(
    (event: Parameters<NonNullable<PopoverContentProps["onInteractOutside"]>>[0]) => {
      onInteractOutside?.(event);
      // Radix fires this after `onPointerDownOutside` and dismisses only if
      // nobody vetoed. A vetoed interaction leaves the palette open with no
      // close coming, so disarm — otherwise the next keyboard dismissal is
      // misread as a pointer one and loses its focus return.
      if (event.defaultPrevented) wasPointerCloseRef.current = false;
    },
    [onInteractOutside]
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      // Unconditional, and ahead of everything else: the answer is a one-shot
      // the consumer disarms as it hands it over, so skipping the call on a
      // close the pointer branch would have suppressed anyway would leave it
      // armed for the next one.
      const suppressRequested = consumeCloseAutoFocusSuppression?.() === true;
      onCloseAutoFocus?.();
      if (suppressRequested || (!restoreFocusOnPointerDismiss && wasPointerCloseRef.current)) {
        event.preventDefault();
      }
      // Cleared on every close, not just the suppressed ones: a palette that
      // opts into restoration would otherwise stay armed after its first
      // pointer dismissal and taint the next keyboard close.
      wasPointerCloseRef.current = false;
    },
    [consumeCloseAutoFocusSuppression, onCloseAutoFocus, restoreFocusOnPointerDismiss]
  );

  const handleEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Radix dismisses from a document-level capture listener that runs ahead
      // of the input's own composition guard, so the IME check has to be
      // repeated here: mid-composition Escape belongs to the candidate window,
      // and letting it through would wipe the query or close the palette
      // underneath it.
      if (event.isComposing || event.keyCode === 229) {
        event.preventDefault();
        return;
      }
      // Consumer veto first. A nested editor inside the palette (the project
      // switcher's inline scratch rename) owns Escape while it holds focus and
      // has to be able to cancel itself without the palette spending the press.
      onEscapeKeyDown?.(event);
      if (event.defaultPrevented) return;
      // Spend the first Escape clearing the query and block the close here —
      // the dismissable layer listens on document with capture, so a
      // stopPropagation from the input would be too late. Whitespace alone
      // doesn't filter, so it must not cost the user a press.
      //
      // Read live off the DOM rather than a captured `query` prop: this fires
      // from a capture listener before React has re-rendered, so a closed-over
      // value can be a keystroke behind.
      if ((inputRef.current?.value ?? "").trim().length > 0) {
        event.preventDefault();
        onClearQuery();
      }
    },
    [inputRef, onClearQuery, onEscapeKeyDown]
  );

  const handleFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      onFocus?.(event);
      // A focus trap hauls focus back to the content wrapper whenever something
      // outside steals it — a panel launched moments ago re-focusing itself,
      // say. The wrapper is tabIndex={-1} and owns no keys, so leaving focus
      // parked there makes the next keystroke vanish; hand it to the search box.
      if (event.target === event.currentTarget) focusInput();
    },
    [focusInput, onFocus]
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      onMouseDown?.(event);
      if (event.defaultPrevented) return;
      // `Element`, not `HTMLElement`: a header adornment can be an SVG icon,
      // and the click lands on the glyph rather than a wrapper.
      const target = event.target;
      if (!(target instanceof Element)) return;
      // The input's own mousedown is left untouched so caret placement and
      // drag-select still work inside the field.
      if (target === inputRef.current) return;
      // The header padding around the input is a click target that isn't the
      // input, and Radix's focus scope wrapper is tabIndex={-1}, so clicking it
      // parks focus on the content: Escape then dead-ends, because the content
      // vetoes the close while only the input clears the query.
      const header = target.closest(`[${PALETTE_HEADER_ATTR}]`);
      // React events from a portal nested inside this one still bubble through
      // here, and that portal may carry its own stamped header — so the match
      // has to actually live in this content, not merely in the React tree.
      if (!header || !event.currentTarget.contains(header)) return;
      event.preventDefault();
      focusInput();
    },
    [focusInput, inputRef, onMouseDown]
  );

  return (
    // Consumer props first: everything below is shell-owned policy, and a
    // spread object can carry a key the prop types omit. Positioning, class
    // names and data attributes still come through untouched.
    <PopoverContent
      {...props}
      // The tier's width, carried by the shell rather than restated at each
      // anchor, and resolved from the same map the modal form reads — a
      // palette on a given tier is the same box whichever host it opens in.
      // `cn` merges, so a palette that genuinely needs another width can still
      // pass one.
      className={cn(PALETTE_SURFACE_WIDTHS[tier], className)}
      aria-label={ariaLabel}
      // Radix does not set this itself. `aria-modal="false"` is noise, so the
      // non-modal form carries nothing rather than a negation.
      aria-modal={modal ? true : undefined}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      onPointerDownOutside={handlePointerDownOutside}
      onInteractOutside={handleInteractOutside}
      onEscapeKeyDown={handleEscapeKeyDown}
      onFocus={handleFocus}
      onMouseDown={handleMouseDown}
    >
      {children}
    </PopoverContent>
  );
}

AppPalettePopover.Content = AppPalettePopoverContent;
