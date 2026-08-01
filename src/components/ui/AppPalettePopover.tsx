import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PALETTE_HEADER_ATTR } from "@/components/ui/paletteHeaderAttr";
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
 * Close when a foreign overlay stacks above an open palette. Compares
 * consecutive reads rather than a snapshot taken at open, so only growth after
 * the palette was already open counts — the palette itself never claims a slot
 * (see the `modal` note below), so it cannot trip its own watcher.
 */
function useForeignOverlayDismissal(
  isOpen: boolean,
  enabled: boolean,
  onOpenChange: (open: boolean) => void
) {
  // Selector returns a constant while disabled, so a palette that doesn't opt
  // in never re-renders on unrelated overlay traffic.
  const overlayStackLength = useUIStore((state) => (enabled ? state.overlayStack.length : 0));
  const previousLengthRef = useRef(overlayStackLength);

  useEffect(() => {
    if (isOpen && overlayStackLength > previousLengthRef.current && overlayStackLength > 0) {
      onOpenChange(false);
    }
    previousLengthRef.current = overlayStackLength;
  }, [isOpen, overlayStackLength, onOpenChange]);
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
  "onOpenAutoFocus" | "onCloseAutoFocus" | "onPointerDownOutside" | "aria-label"
> {
  /**
   * Radix renders the content as `role="dialog"`. Without a name a screen
   * reader announces a generic dialog before reaching the search box, so match
   * the visible header and speech control can target it by the word on screen.
   */
  ariaLabel: string;
  /** The palette's search box. Focus is driven into it on every open. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Called when the first Escape spends itself clearing a non-empty query. */
  onClearQuery: () => void;
  /**
   * Keep Radix's focus return to the trigger even when the palette was
   * dismissed by pointer. Off by default — a pointer dismissal that restores
   * focus leaves the trigger wearing a focus-visible ring nobody asked for
   * (#6119). Keyboard dismissal always restores, per WAI-ARIA.
   */
  restoreFocusOnPointerDismiss?: boolean;
  /**
   * Fired before Radix restores focus, for triggers that have to suppress
   * something on the way out (a tooltip that would re-open on focus). The shell
   * keeps ownership of the Radix event itself.
   */
  onCloseAutoFocus?: () => void;
}

function AppPalettePopoverContent({
  ariaLabel,
  inputRef,
  onClearQuery,
  restoreFocusOnPointerDismiss = false,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onFocus,
  onMouseDown,
  children,
  ...props
}: AppPalettePopoverContentProps) {
  const { isOpen, modal } = useAnchoredPaletteContext();

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef]);

  // Second focus attempt behind `onOpenAutoFocus`. `PopoverContent` renders
  // nothing until its lazily imported Radix chunk resolves, so on a cold open
  // this frame can fire before the input exists; on a warm one it runs after
  // the mount handler already focused it and is a harmless no-op. Neither
  // covers both orders alone — dropping either regresses one of them.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, focusInput]);

  // Set in onPointerDownOutside, read in onCloseAutoFocus.
  const wasPointerCloseRef = useRef(false);

  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      // Radix would otherwise focus the content wrapper; the search box is what
      // the user is about to type into.
      event.preventDefault();
      focusInput();
    },
    [focusInput]
  );

  const handlePointerDownOutside = useCallback(() => {
    wasPointerCloseRef.current = true;
  }, []);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      onCloseAutoFocus?.();
      if (!restoreFocusOnPointerDismiss && wasPointerCloseRef.current) {
        event.preventDefault();
      }
      // Cleared on every close, not just the suppressed ones: a palette that
      // opts into restoration would otherwise stay armed after its first
      // pointer dismissal and taint the next keyboard close.
      wasPointerCloseRef.current = false;
    },
    [onCloseAutoFocus, restoreFocusOnPointerDismiss]
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
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // The input's own mousedown is left untouched so caret placement and
      // drag-select still work inside the field.
      if (target === inputRef.current) return;
      // The header padding around the input is a click target that isn't the
      // input, and Radix's focus scope wrapper is tabIndex={-1}, so clicking it
      // parks focus on the content: Escape then dead-ends, because the content
      // vetoes the close while only the input clears the query.
      if (!target.closest(`[${PALETTE_HEADER_ATTR}]`)) return;
      event.preventDefault();
      focusInput();
    },
    [focusInput, inputRef, onMouseDown]
  );

  return (
    <PopoverContent
      aria-label={ariaLabel}
      // Radix does not set this itself. `aria-modal="false"` is noise, so the
      // non-modal form carries nothing rather than a negation.
      aria-modal={modal ? true : undefined}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      onPointerDownOutside={handlePointerDownOutside}
      onEscapeKeyDown={handleEscapeKeyDown}
      onFocus={handleFocus}
      onMouseDown={handleMouseDown}
      {...props}
    >
      {children}
    </PopoverContent>
  );
}

AppPalettePopover.Content = AppPalettePopoverContent;
