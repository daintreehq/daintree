import { useState, useEffect, useRef, useCallback, useId, type CSSProperties } from "react";
import { Globe } from "lucide-react";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { FIELD_INPUT } from "@/components/Worktree/views/WorktreeFormLayout";

/**
 * `ScrollShadow` reads its fade colour from this variable, and the card is the surface the
 * fades have to disappear into. Declared as a typed constant rather than asserted inline:
 * `CSSProperties` has no index signature for custom properties, and the cast that would
 * paper over that is the one the lint ratchet counts.
 */
const CARD_STYLE: CSSProperties & Record<"--scroll-shadow-color", string> = {
  "--scroll-shadow-color": "var(--color-surface-dialog)",
};

// Kept in sync with src/lib/accessibility.ts — this dialog cannot import from there
// because it renders inside the webview overlay. Every branch excludes tabindex="-1":
// a roving-tabindex widget member is not a tab stop whatever its tag.
const TABBABLE_SELECTOR =
  'a[href]:not([tabindex^="-"]), area[href]:not([tabindex^="-"]), input:not([disabled]):not([type="hidden"]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), audio[controls]:not([tabindex^="-"]), video[controls]:not([tabindex^="-"]), [contenteditable]:not([contenteditable="false"]):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';

export interface WebviewDialogRequest {
  dialogId: string;
  panelId: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue: string;
  /**
   * Host of the frame that raised the dialog, or null when it has none worth claiming
   * (data:, blob:, about:). Never guessed — see `formatDialogOrigin`.
   */
  origin: string | null;
}

interface WebviewDialogProps {
  dialog: WebviewDialogRequest | null;
  onRespond: (confirmed: boolean, response?: string) => void;
}

export function WebviewDialog({ dialog, onRespond }: WebviewDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const inputId = useId();

  useEffect(() => {
    if (!dialog) return;
    if (dialog.type === "prompt") {
      setInputValue(dialog.defaultValue);
    }
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    requestAnimationFrame(() => {
      if (dialog.type === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        okRef.current?.focus();
      }
    });
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    const handleTabTrap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const activeEl = document.activeElement;
      if (activeEl) {
        const closestModal = activeEl.closest('[aria-modal="true"]');
        if (closestModal && !closestModal.contains(panelRef.current)) return;
      }
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!panelRef.current.contains(activeEl)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleTabTrap);
    return () => window.removeEventListener("keydown", handleTabTrap);
  }, [dialog]);

  const handleOk = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === "prompt") {
      onRespond(true, inputValue);
    } else {
      onRespond(true);
    }
  }, [dialog, inputValue, onRespond]);

  const handleCancel = useCallback(() => {
    onRespond(false);
  }, [onRespond]);

  // Escape only. Enter is deliberately left alone so a focused button runs its
  // native activation — intercepting it here cancelled the Cancel button's
  // Enter-to-click and confirmed the guest's dialog instead (issue #11106).
  const handleEscape = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (dialog?.type === "alert") {
        handleOk();
      } else {
        handleCancel();
      }
    },
    [dialog, handleOk, handleCancel]
  );

  // Text inputs have no native Enter action outside a <form>, so the prompt
  // owns its own submit. keyCode 229 is Chromium's "Process" signal on the first
  // keydown of an IME composition, before isComposing is set — submitting there
  // would send a half-composed value.
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      e.preventDefault();
      handleOk();
    },
    [handleOk]
  );

  if (!dialog) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim-medium p-4"
      onKeyDown={handleEscape}
    >
      <div
        ref={panelRef}
        role="dialog"
        // Strictly speaking this overstates the scope — the dialog blocks one pane, not
        // the app, and ARIA reads `aria-modal` as "everything else is hidden". It stays
        // because four consumers key off `[role="dialog"][aria-modal="true"]` to know a
        // dialog owns input: `hasBlockingOverlay` (lib/typeAnywhere.ts), the `modalOpen`
        // keybinding clause (services/keybindingWhenContext.ts), Escape ownership
        // (hooks/useGlobalKeybindings.ts), and the capture-phase Enter guard in
        // FleetArmingRibbon that exists because of #11106. Dropping it here would let
        // type-anywhere eat keystrokes aimed at this dialog and let Enter confirm a fleet
        // action instead of the focused button — the exact regression #11106 fixed.
        // Narrowing the scope properly means giving those four a signal that is not
        // `aria-modal`; that is a cross-cutting change, not this component's to make.
        aria-modal="true"
        // Named by Daintree's own header, described by the guest's message. Pointing the
        // name at the message would make the dialog's accessible name whatever the page
        // chose to put in alert() — so a screen reader would announce a page's
        // "Daintree — your session has expired" as this dialog's own identity. Chromium
        // names its own JS dialogs the same way: "<origin> says", body as description.
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="bg-surface-dialog border border-border-default rounded-[var(--radius-xl)] shadow-[var(--theme-shadow-dialog)] w-full max-w-md max-h-full flex flex-col overflow-hidden"
        style={CARD_STYLE}
      >
        {/* The only line on this surface Daintree wrote. Everything below it is the
            page's. Carries no focusable control on purpose: adding one would change the
            Tab order and the initial-focus target the dialog's contract depends on. */}
        <SurfaceHeader className="px-4 py-2.5 gap-2 justify-start">
          <Globe className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          {/* Deliberately not `truncate`: `text-overflow: ellipsis` clips from the right,
              the direction `clipOriginTail` exists to avoid. This card is narrower than
              the 64-char JS threshold, so a 40-63 char host would clear the clip and then
              be cut by CSS into `bank.com…` — the endorsement-reading spoof. Wrapping
              keeps the identifying tail visible at any pane width; a character budget
              tuned to one width cannot. */}
          <p id={titleId} className="text-xs text-text-secondary min-w-0">
            {dialog.origin ? (
              <>
                Message from{" "}
                <span className="font-mono text-text-primary break-all">{dialog.origin}</span>
              </>
            ) : (
              "Message from this page"
            )}
          </p>
        </SurfaceHeader>

        {/* Scrolls rather than growing: a page picks this text, and an unbounded card in a
            short pane pushes its own action row out of reach. The edge fades matter here
            beyond tidiness — without them a page can put agreeable text in view and leave
            what it is actually asking for below the fold. */}
        <ScrollShadow className="flex-1 min-h-0" scrollClassName="px-4 py-3.5">
          {/* One stable element child: `useVerticalScrollShadows` observes only
              `firstElementChild`, so letting the prompt field come and go as a sibling
              would leave the observer watching a box whose height never changes. */}
          <div>
            <p
              id={messageId}
              // /80 is the app's weight for third-party prose (see PluginMcpConfirmDialog).
              // At full strength the page outranked Daintree's own dialog copy, which sits
              // at /70.
              className="text-sm text-daintree-text/80 whitespace-pre-wrap break-words"
            >
              {dialog.message}
            </p>

            {dialog.type === "prompt" && (
              <>
                {/* The page supplies a message, never a field label. Naming the input
                    after that message would hand a form control an arbitrarily long,
                    possibly hostile accessible name. */}
                <label htmlFor={inputId} className="sr-only">
                  Response
                </label>
                <input
                  ref={inputRef}
                  id={inputId}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  aria-describedby={messageId}
                  className={`${FIELD_INPUT} mt-3`}
                />
              </>
            )}
          </div>
        </ScrollShadow>

        <div className="px-4 py-3 border-t border-border-strong bg-surface-panel flex items-center justify-end gap-2 shrink-0">
          {dialog.type !== "alert" && (
            <Button
              variant="ghost"
              onClick={handleCancel}
              className="text-daintree-text/70 hover:text-text-primary"
              data-confirm-role="cancel"
            >
              Cancel
            </Button>
          )}
          <Button ref={okRef} variant="contrast" onClick={handleOk} data-confirm-role="confirm">
            OK
          </Button>
        </div>

        {/* Co-located so store-dispatched announcements reach VoiceOver while
            this aria-modal subtree holds focus (Chromium 354736464). */}
        <AccessibilityAnnouncer />
      </div>
    </div>
  );
}
