import { useState, useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { CircleAlert, FolderPen } from "lucide-react";
import { basename, dirname, normalize } from "@shared/utils/path";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { PathSegments } from "@/components/ui/PathSegments";
import { FormGrid, FormRow } from "@/components/Worktree/views";
import { BrowseSlotButton, SlottedInputField } from "@/components/Project/projectDialogFields";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { logError } from "@/utils/logger";
import { systemClient } from "@/clients/systemClient";
import { projectClient } from "@/clients/projectClient";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

interface UpdateCwdDialogProps {
  isOpen: boolean;
  terminalId: string;
  currentCwd: string;
  onClose: () => void;
}

/** How far up the missing path to look for a folder that still exists. */
const MAX_ANCESTOR_PROBES = 8;

/**
 * Folders worth offering in place of the missing one: the project root, where a
 * terminal from a deleted worktree most often belongs, then the nearest ancestor
 * of the missing path that still exists. Only folders the check confirmed.
 */
async function findSuggestions(missing: string, projectRoot: string | undefined) {
  const found: string[] = [];
  const missingPath = normalize(missing);
  if (projectRoot) {
    const root = normalize(projectRoot);
    if (root !== missingPath && (await systemClient.checkDirectory(root).catch(() => false))) {
      found.push(root);
    }
  }
  let candidate = dirname(missingPath);
  for (let i = 0; i < MAX_ANCESTOR_PROBES && candidate && candidate !== dirname(candidate); i++) {
    if (await systemClient.checkDirectory(candidate).catch(() => false)) {
      if (!found.includes(candidate)) found.push(candidate);
      break;
    }
    candidate = dirname(candidate);
  }
  return found;
}

export function UpdateCwdDialog({ isOpen, terminalId, currentCwd, onClose }: UpdateCwdDialogProps) {
  // Frozen at open: the store rewrites the terminal's cwd before the restart
  // resolves, and the missing folder must not turn into the new one mid-flight.
  const [missingCwd, setMissingCwd] = useState(currentCwd);
  const [newCwd, setNewCwd] = useState(currentCwd);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  const [restartError, setRestartError] = useState<string>();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped by every close and every edit, so an answer that arrives after
  // either belongs to an attempt the user has already walked away from.
  const attemptRef = useRef(0);
  const busyRef = useRef(false);
  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;
  const errorId = useId();
  const showBusy = useDohertyGate(busy);

  const updateTerminalCwd = usePanelStore((state) => state.updateTerminalCwd);
  const restartTerminal = usePanelStore((state) => state.restartTerminal);
  const projectRoot = useProjectStore((state) => state.currentProject?.path);

  useEffect(() => {
    if (!isOpen) {
      attemptRef.current++;
      busyRef.current = false;
      setBusy(false);
      return;
    }
    const missing = currentCwdRef.current;
    setMissingCwd(missing);
    setNewCwd(missing);
    setFieldError(undefined);
    setRestartError(undefined);
    setSuggestions([]);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    let cancelled = false;
    void findSuggestions(missing, projectRoot).then((found) => {
      if (!cancelled) setSuggestions(found);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [isOpen, projectRoot]);

  /** Any change to the draft abandons whatever attempt was in flight for the old one. */
  const abandonAttempt = useCallback(() => {
    attemptRef.current++;
    busyRef.current = false;
    setBusy(false);
  }, []);

  /**
   * A field error is spoken exactly once. From the footer, focus moves to the
   * field it describes — on the next frame, once the invalid state and the
   * described-by message are committed — so arriving there reads it. From the
   * field itself focus doesn't move, so nothing would be read: announce it.
   */
  const failField = useCallback((message: string) => {
    setFieldError(message);
    if (inputRef.current && document.activeElement === inputRef.current) {
      useAnnouncerStore.getState().announce(message, "assertive");
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, []);

  const choosePath = useCallback(
    (path: string) => {
      abandonAttempt();
      setNewCwd(path);
      setFieldError(undefined);
      setRestartError(undefined);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    [abandonAttempt]
  );

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await projectClient.openDialog();
      if (picked) choosePath(picked);
      else inputRef.current?.focus();
    } catch (error) {
      failField("Couldn't open the folder picker. Type the path instead.");
      logError("Failed to open folder picker for terminal cwd", error);
    }
  }, [choosePath, failField]);

  const handleUpdate = useCallback(async () => {
    if (busyRef.current) return;
    const path = newCwd.trim();
    if (!path) {
      failField("Enter a folder path");
      return;
    }

    const attempt = ++attemptRef.current;
    const isCurrent = () => attempt === attemptRef.current;
    busyRef.current = true;
    setBusy(true);
    setFieldError(undefined);
    setRestartError(undefined);

    try {
      let exists: boolean;
      try {
        exists = await systemClient.checkDirectory(path);
      } catch (error) {
        if (isCurrent()) failField("Couldn't check this folder. Try again.");
        logError("Failed to check terminal cwd", error);
        return;
      }
      if (!isCurrent()) return;
      if (!exists) {
        failField("This folder doesn't exist. Check the path, or browse for one.");
        return;
      }

      updateTerminalCwd(terminalId, path);
      try {
        // Suppress resume-latest: cwd is changing, so a CWD-scoped fallback
        // would pick up an unrelated session in the new directory.
        await restartTerminal(terminalId, { allowResumeLatest: false });
      } catch (error) {
        if (isCurrent()) setRestartError("The folder is set, but the terminal didn't start.");
        logError("Failed to restart terminal after cwd change", error);
        return;
      }
      if (isCurrent()) onClose();
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [terminalId, newCwd, updateTerminalCwd, restartTerminal, onClose, failField]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleUpdate();
      }
    },
    [handleUpdate]
  );

  // A successful restart clears the banner whose button opened this, so focus
  // would otherwise fall to the first control in the app shell.
  const restoreFocusToTerminal = useCallback(() => {
    if (!focusPanelInput(terminalId)) return null;
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [terminalId]);

  const shownSuggestions = suggestions.filter((path) => path !== normalize(newCwd.trim()));

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      // The field takes focus itself, with its value selected.
      initialFocus="none"
      restoreFocusTo={restoreFocusToTerminal}
    >
      <AppDialog.Header>
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. Same
            glyph as the banner's "Change directory" that opens this. */}
        <AppDialog.Title icon={<FolderPen className="w-5 h-5 text-text-secondary" />}>
          Change working directory
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        {restartError && (
          <InlineStatusBanner
            severity="error"
            title="Couldn't restart the terminal"
            description={restartError}
            className="rounded-[var(--radius-md)]"
          />
        )}

        <AppDialog.Description>
          This terminal couldn&apos;t start in its folder. Choose where to restart it.
        </AppDialog.Description>

        <FormGrid>
          {/* Top-aligned: a long path wraps, and the label belongs to its first line. */}
          <FormRow label="Old folder" labelClassName="self-start">
            {/* Inset to the field's text, so the old and new paths share a column. */}
            <p
              className="min-w-0 px-2.5 font-mono text-xs text-text-secondary select-text"
              aria-label={missingCwd}
              data-testid="update-cwd-missing-path"
            >
              <PathSegments path={normalize(missingCwd)} />
            </p>
          </FormRow>

          <FormRow
            label="New folder"
            htmlFor="new-cwd-input"
            hint={
              (fieldError || shownSuggestions.length > 0) && (
                <div className="space-y-1.5">
                  {/* No live role: aria-invalid plus the described-by link
                      announce it when focus lands back on the field. */}
                  {fieldError && (
                    <p id={errorId} className="flex items-start gap-1 text-xs text-status-error">
                      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {fieldError}
                    </p>
                  )}
                  {shownSuggestions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-text-secondary">Use</span>
                      {shownSuggestions.map((path) => (
                        <Button
                          key={path}
                          variant="subtle"
                          size="xs"
                          className="max-w-full font-mono"
                          title={path}
                          aria-label={`Use ${path}`}
                          onClick={() => choosePath(path)}
                        >
                          <span className="truncate">{basename(path) || path}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )
            }
          >
            <SlottedInputField
              ref={inputRef}
              id="new-cwd-input"
              value={newCwd}
              onChange={(e) => {
                abandonAttempt();
                setNewCwd(e.target.value);
                setFieldError(undefined);
                setRestartError(undefined);
              }}
              onKeyDown={handleKeyDown}
              invalid={!!fieldError}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder="/path/to/folder"
              aria-describedby={fieldError ? errorId : undefined}
              trailing={
                <BrowseSlotButton
                  onBrowse={() => void handleBrowse()}
                  label="Browse for the new folder"
                />
              }
            />
          </FormRow>
        </FormGrid>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contrast" onClick={() => void handleUpdate()} loading={showBusy}>
          Restart terminal
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
