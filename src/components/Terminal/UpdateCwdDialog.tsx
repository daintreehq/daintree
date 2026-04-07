import { useState, useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, AlertCircle } from "lucide-react";
import { systemClient } from "@/clients/systemClient";
import { usePanelStore } from "@/store/panelStore";

interface UpdateCwdDialogProps {
  isOpen: boolean;
  terminalId: string;
  currentCwd: string;
  onClose: () => void;
}

export function UpdateCwdDialog({ isOpen, terminalId, currentCwd, onClose }: UpdateCwdDialogProps) {
  const [newCwd, setNewCwd] = useState(currentCwd);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const updateTerminalCwd = usePanelStore((state) => state.updateTerminalCwd);
  const restartTerminal = usePanelStore((state) => state.restartTerminal);

  useEffect(() => {
    if (isOpen) {
      setNewCwd(currentCwd);
      setValidationError(undefined);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isOpen, currentCwd]);

  const handleUpdate = useCallback(async () => {
    if (!newCwd.trim()) {
      setValidationError("Directory path is required");
      return;
    }

    setValidating(true);
    setValidationError(undefined);

    try {
      const exists = await systemClient.checkDirectory(newCwd);
      if (!exists) {
        setValidationError("Directory does not exist");
        return;
      }

      updateTerminalCwd(terminalId, newCwd);
      await restartTerminal(terminalId);

      onClose();
    } catch (error) {
      setValidationError("Could not restart terminal. Please try again.");
      console.error("Failed to update CWD and restart:", error);
    } finally {
      setValidating(false);
    }
  }, [terminalId, newCwd, updateTerminalCwd, restartTerminal, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !validating) {
        e.preventDefault();
        handleUpdate();
      }
    },
    [handleUpdate, validating]
  );

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md">
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderOpen className="w-5 h-5 text-canopy-accent" />}>
          Update Working Directory
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <AppDialog.Description className="mb-4">
          The current working directory no longer exists. Choose a new directory to restart this
          terminal.
        </AppDialog.Description>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-canopy-text/70 mb-1">
              Current (invalid):
            </label>
            <code className="block p-2 bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)] border border-status-error/30 rounded text-sm text-status-error font-mono truncate">
              {currentCwd}
            </code>
          </div>

          <div>
            <label
              htmlFor="new-cwd-input"
              className="block text-sm font-medium text-canopy-text/70 mb-1"
            >
              New Directory:
            </label>
            <input
              ref={inputRef}
              id="new-cwd-input"
              type="text"
              value={newCwd}
              onChange={(e) => {
                setNewCwd(e.target.value);
                setValidationError(undefined);
              }}
              onKeyDown={handleKeyDown}
              className="w-full p-2 bg-canopy-bg border border-canopy-border rounded font-mono text-sm text-canopy-text focus:outline-none focus:border-canopy-accent"
              placeholder="/path/to/directory"
              aria-invalid={!!validationError}
              aria-describedby={validationError ? "cwd-error" : undefined}
            />
            {validationError && (
              <div
                id="cwd-error"
                className="flex items-center gap-1 mt-1.5 text-sm text-status-error"
                role="alert"
              >
                <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                {validationError}
              </div>
            )}
          </div>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleUpdate} disabled={validating}>
          {validating ? "Updating..." : "Update & Restart"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
