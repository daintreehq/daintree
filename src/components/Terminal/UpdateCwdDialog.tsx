import { useState, useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { FIELD_INPUT, FormGrid, FormRow } from "@/components/Worktree/views";
import { cn } from "@/lib/utils";
import { FolderOpen, AlertCircle } from "lucide-react";
import { logError } from "@/utils/logger";
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
        setValidationError("Directory doesn't exist");
        return;
      }

      updateTerminalCwd(terminalId, newCwd);
      // Suppress resume-latest: cwd is changing, so a CWD-scoped fallback
      // would pick up an unrelated session in the new directory.
      await restartTerminal(terminalId, { allowResumeLatest: false });

      onClose();
    } catch (error) {
      setValidationError("Couldn't restart terminal. Try again.");
      logError("Failed to update CWD and restart", error);
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
        <AppDialog.Title icon={<FolderOpen className="w-5 h-5 text-daintree-accent" />}>
          Update Working Directory
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <AppDialog.Description className="mb-4">
          The current working directory no longer exists. Choose a new directory to restart this
          terminal.
        </AppDialog.Description>

        <FormGrid>
          <FormRow label="Current directory">
            <code className="block p-2 bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)] border border-status-error/30 rounded text-sm text-status-error font-mono truncate">
              {currentCwd}
            </code>
          </FormRow>

          <FormRow
            label="New directory"
            htmlFor="new-cwd-input"
            hint={
              validationError && (
                <div
                  id="cwd-error"
                  className="flex items-center gap-1 text-xs text-status-error"
                  role="alert"
                >
                  <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  {validationError}
                </div>
              )
            }
          >
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
              className={cn(FIELD_INPUT, "font-mono")}
              placeholder="/path/to/directory"
              aria-invalid={!!validationError}
              aria-describedby={validationError ? "cwd-error" : undefined}
            />
          </FormRow>
        </FormGrid>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contrast" onClick={handleUpdate} disabled={validating}>
          {validating ? "Updating…" : "Update and restart"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
