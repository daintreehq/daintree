import { useState, useEffect, useRef, useCallback } from "react";

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (dialog?.type === "alert") {
          handleOk();
        } else {
          handleCancel();
        }
      }
    },
    [dialog, handleOk, handleCancel]
  );

  if (!dialog) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim-medium"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-daintree-bg border border-daintree-border rounded-lg shadow-[var(--theme-shadow-dialog)] max-w-sm w-full mx-4 p-4">
        <p className="text-sm text-daintree-text whitespace-pre-wrap break-words mb-4">
          {dialog.message}
        </p>

        {dialog.type === "prompt" && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-daintree-sidebar border border-daintree-border rounded-md text-daintree-text focus:outline-none focus:ring-1 focus:ring-daintree-accent/50 mb-4"
          />
        )}

        <div className="flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs font-medium text-daintree-text/70 bg-daintree-bg hover:bg-tint/5 border border-daintree-border rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-daintree-accent/50"
            >
              Cancel
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            onClick={handleOk}
            className="px-3 py-1.5 text-xs font-medium text-text-inverse bg-daintree-accent hover:bg-daintree-accent/90 rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-daintree-accent/50"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
