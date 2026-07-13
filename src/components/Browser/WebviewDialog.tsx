import { useState, useEffect, useRef, useCallback, useId } from "react";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";

const TABBABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"])';

export interface WebviewDialogRequest {
  dialogId: string;
  panelId: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue: string;
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
  const messageId = useId();

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
  // owns its own submit.
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      handleOk();
    },
    [handleOk]
  );

  if (!dialog) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim-medium"
      onKeyDown={handleEscape}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={messageId}
        tabIndex={-1}
        className="bg-daintree-bg border border-daintree-border rounded-lg shadow-[var(--theme-shadow-dialog)] max-w-sm w-full mx-4 p-4"
      >
        <p
          id={messageId}
          className="text-sm text-daintree-text whitespace-pre-wrap break-words mb-4"
        >
          {dialog.message}
        </p>

        {dialog.type === "prompt" && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            aria-describedby={messageId}
            className="w-full px-3 py-1.5 text-sm bg-daintree-sidebar border border-daintree-border rounded-md text-daintree-text focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/50 mb-4"
          />
        )}

        <div className="flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs font-medium text-daintree-text/70 bg-daintree-bg hover:bg-tint/5 border border-daintree-border rounded-md transition-colors focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/50"
            >
              Cancel
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            onClick={handleOk}
            className="px-3 py-1.5 text-xs font-medium text-text-inverse bg-daintree-accent hover:bg-daintree-accent/90 rounded-md transition-colors focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/50"
          >
            OK
          </button>
        </div>

        {/* Co-located so store-dispatched announcements reach VoiceOver while
            this aria-modal subtree holds focus (Chromium 354736464). */}
        <AccessibilityAnnouncer />
      </div>
    </div>
  );
}
