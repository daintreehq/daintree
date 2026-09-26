import { useState, useEffect, useRef, useId } from "react";
import { CheckCircle, AlertCircle, RefreshCw, ExternalLink, ChevronRight } from "lucide-react";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsActions,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { editorClient } from "@/clients/editorClient";
import type { EditorConfig, DiscoveredEditor, KnownEditorId } from "@shared/types/editor";
import { KNOWN_EDITOR_IDS } from "@shared/types/editor";
import { useProjectStore, patchCachedProjectSettings } from "@/store";
import { invalidateProjectSettingsCache } from "@/clients/projectClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";

const EDITOR_LABELS: Record<KnownEditorId, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  windsurf: "Windsurf",
  "antigravity-ide": "Antigravity IDE",
  zed: "Zed",
  neovim: "Neovim",
  webstorm: "WebStorm / IntelliJ",
  sublime: "Sublime Text",
  custom: "Custom…",
};

export function EditorIntegrationTab() {
  const [discoveredEditors, setDiscoveredEditors] = useState<DiscoveredEditor[]>([]);
  const [preferredEditor, setPreferredEditor] = useState<EditorConfig | null>(null);
  const [selectedId, setSelectedId] = useState<KnownEditorId>("vscode");
  const [customCommand, setCustomCommand] = useState("");
  const [customTemplate, setCustomTemplate] = useState("{file}:{line}:{col}");
  const [isSaving, setIsSaving] = useState(false);
  const [isRescanning, setIsRescanning] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<"ok" | "error" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Until the saved preference is read, the selection shown is a placeholder: nothing
  // edits or saves it, and nothing claims it isn't saved yet.
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [rescanFailed, setRescanFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [showDetected, setShowDetected] = useState(false);
  const isMountedRef = useRef(true);
  const editorId = useId();
  const commandId = useId();
  const argsId = useId();
  const detectedRegionId = useId();

  const activeProjectId = useProjectStore((s) => s.currentProject?.id);
  const activeProjectPath = useProjectStore((s) => s.currentProject?.path);
  const activeProjectName = useProjectStore((s) => s.currentProject?.name);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    setLoadError(null);
    setIsLoadingConfig(true);
    editorClient
      .getConfig(activeProjectId)
      .then(({ preferredEditor: pref, discoveredEditors: discovered }) => {
        if (cancelled || !isMountedRef.current) return;
        setIsLoadingConfig(false);
        setDiscoveredEditors(discovered);
        if (pref) {
          setPreferredEditor(pref);
          setSelectedId(pref.id);
          setCustomCommand(pref.customCommand ?? "");
          setCustomTemplate(pref.customTemplate ?? "{file}:{line}:{col}");
        } else {
          // Auto-select first available
          const first = discovered.find((d) => d.available);
          if (first) {
            setSelectedId(first.id);
          }
        }
      })
      .catch((err) => {
        if (cancelled || !isMountedRef.current) return;
        logError("[EditorIntegrationTab] Failed to load config", err);
        setIsLoadingConfig(false);
        setLoadError(formatErrorMessage(err, "Couldn't read the saved editor"));
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, loadAttempt]);

  // Any edit makes the last test result about a different choice.
  const editDraft = () => {
    setTestResult(null);
    setSaveError(null);
  };

  const handleRescan = async () => {
    setIsRescanning(true);
    setRescanFailed(false);
    try {
      const editors = await editorClient.discover();
      if (!isMountedRef.current) return;
      setDiscoveredEditors(editors);
    } catch (err) {
      logError("[EditorIntegrationTab] Rescan failed", err);
      // The list below is the previous scan; say so rather than let it pass as fresh.
      if (isMountedRef.current) setRescanFailed(true);
    } finally {
      if (isMountedRef.current) setIsRescanning(false);
    }
  };

  const handleSave = async () => {
    if (!activeProjectId || isSaving || isLoadingConfig || loadError) return;
    if (selectedId === "custom" && !customCommand.trim()) {
      setCommandError("Enter the command that opens your editor");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const editor: EditorConfig = {
        id: selectedId,
        customCommand: selectedId === "custom" ? customCommand.trim() || undefined : undefined,
        customTemplate: selectedId === "custom" ? customTemplate.trim() || undefined : undefined,
      };
      await editorClient.setConfig({ editor, projectId: activeProjectId });
      // Main writes preferredEditor straight into the project settings file, so
      // every renderer-side copy is now stale. Both must be refreshed before
      // anything else reads or re-saves the whole settings object (#12326).
      invalidateProjectSettingsCache(activeProjectId);
      patchCachedProjectSettings(activeProjectId, { preferredEditor: editor });
      if (!isMountedRef.current) return;
      setPreferredEditor(editor);
    } catch (err) {
      if (!isMountedRef.current) return;
      setSaveError(formatErrorMessage(err, "Failed to save editor preference"));
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (!activeProjectId || !activeProjectPath || isTesting) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      // Open the active project's root to test the editor integration. It is a
      // known-to-exist path inside an allowed root, so it passes the main-process
      // path-containment guard (homeDir would now be rejected as outside-root).
      const fallback = await window.electron.system.openInEditor({
        path: activeProjectPath,
        projectId: activeProjectId,
      });
      if (!isMountedRef.current) return;
      // A remote window copies the host path when no editor here can open it: not a pass.
      setTestResult(fallback ? "error" : "ok");
    } catch {
      if (!isMountedRef.current) return;
      setTestResult("error");
    } finally {
      if (isMountedRef.current) setIsTesting(false);
    }
  };

  const availabilityMap = new Map(discoveredEditors.map((d) => [d.id, d]));

  // The inventory rule: the current choice and anything that needs attention stay in
  // view; the healthy remainder, with its paths, sits behind a disclosure.
  const selectedEntry = discoveredEditors.find((d) => d.id === selectedId);
  const missingEditors = discoveredEditors.filter((d) => !d.available && d.id !== selectedId);
  const otherFoundEditors = discoveredEditors.filter((d) => d.available && d.id !== selectedId);
  const foundCount = discoveredEditors.filter((d) => d.available).length;

  const renderEditorEntry = (d: DiscoveredEditor) => (
    <li
      key={d.id}
      data-editor-entry={d.id}
      className="flex min-w-0 items-center gap-2 text-xs text-text-secondary"
    >
      {d.available ? (
        <CheckCircle className="w-3.5 h-3.5 text-text-secondary shrink-0" aria-label="Found" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 text-text-secondary shrink-0" aria-label="Not found" />
      )}
      <span
        className={cn(
          "shrink-0 whitespace-nowrap",
          d.available ? "text-text-primary" : "text-text-secondary"
        )}
      >
        {EDITOR_LABELS[d.id]}
      </span>
      {d.executablePath && (
        <span className="min-w-0 truncate font-mono text-text-secondary" title={d.executablePath}>
          {d.executablePath}
        </span>
      )}
    </li>
  );

  // No saved preference yet counts as dirty: the auto-selected editor is only a
  // suggestion until it is saved, and main falls back to discovery order until then.
  const isDirty =
    !preferredEditor ||
    preferredEditor.id !== selectedId ||
    (selectedId === "custom" &&
      ((preferredEditor.customCommand ?? "") !== customCommand.trim() ||
        (preferredEditor.customTemplate ?? "") !== customTemplate.trim()));

  if (!activeProjectId) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        Open a project to configure its editor preference.
      </div>
    );
  }

  return (
    <SettingsSection
      id="editor-external"
      title="External editor"
      description={`For ${activeProjectName ?? "this project"} only. The editor that "Open in editor" launches from the diff viewer and worktree cards.`}
    >
      <SettingsGroup>
        <SettingsRow
          label="Editor"
          control={({ labelId, descriptionId, disabled }) => (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleRescan}
                    disabled={disabled || isRescanning}
                    aria-label="Re-scan for installed editors"
                  >
                    <SpinningIcon icon={RefreshCw} active={isRescanning} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Re-scan for installed editors</TooltipContent>
              </Tooltip>
              <Select
                value={selectedId}
                onValueChange={(value) => {
                  setSelectedId(value as KnownEditorId);
                  setCommandError(null);
                  editDraft();
                }}
                disabled={disabled || isLoadingConfig}
              >
                <SelectTrigger
                  id={editorId}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  className={SETTINGS_CONTROL_WIDTH.wide}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KNOWN_EDITOR_IDS.map((id) => {
                    const disc = availabilityMap.get(id);
                    const available = id === "custom" ? true : (disc?.available ?? false);
                    return (
                      <SelectItem key={id} value={id}>
                        {EDITOR_LABELS[id]}
                        {id !== "custom" && !available ? " (not found)" : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </>
          )}
        />

        {selectedId !== "custom" && discoveredEditors.length > 0 && (
          <>
            <SettingsRow
              label="Detected editors"
              description={
                rescanFailed ? (
                  <span className="text-status-error">
                    Couldn&apos;t re-scan — showing the previous scan. Use the re-scan button to try
                    again.
                  </span>
                ) : (
                  `${foundCount} of ${discoveredEditors.length} found on this machine`
                )
              }
              layout="stacked"
              control={
                <div className="space-y-1">
                  {selectedEntry && <ul>{renderEditorEntry(selectedEntry)}</ul>}
                  {missingEditors.length > 0 && (
                    <p
                      data-editor-missing=""
                      className="flex min-w-0 items-start gap-2 text-xs text-text-secondary"
                    >
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                      <span>
                        Not found: {missingEditors.map((d) => EDITOR_LABELS[d.id]).join(", ")}
                      </span>
                    </p>
                  )}
                </div>
              }
            />
            {otherFoundEditors.length > 0 && (
              <div>
                <button
                  type="button"
                  aria-expanded={showDetected}
                  aria-controls={detectedRegionId}
                  onClick={() => setShowDetected((v) => !v)}
                  className={cn(
                    "group flex w-full items-center gap-2 py-2.5 pl-4 pr-4 text-left",
                    "text-sm text-text-secondary hover:text-text-primary transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                  )}
                >
                  <ChevronRight
                    data-animated-chevron
                    className={cn(
                      "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150 group-hover:text-text-primary",
                      showDetected ? "rotate-90" : "rotate-0"
                    )}
                    aria-hidden="true"
                  />
                  {showDetected
                    ? "Hide other found editors"
                    : `Show ${otherFoundEditors.length} other found editor${otherFoundEditors.length === 1 ? "" : "s"}`}
                </button>
                <div id={detectedRegionId}>
                  {showDetected && (
                    <ul className="space-y-1 pb-3 pl-4 pr-4">
                      {otherFoundEditors.map(renderEditorEntry)}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {selectedId === "custom" && (
          <>
            <SettingsRow
              label="Command"
              layout="stacked"
              error={commandError ?? undefined}
              control={({ labelId, descriptionId }) => (
                <Input
                  id={commandId}
                  type="text"
                  value={customCommand}
                  onChange={(e) => {
                    setCustomCommand(e.target.value);
                    setCommandError(null);
                    editDraft();
                  }}
                  placeholder="code, nvim, subl"
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  aria-invalid={commandError ? true : undefined}
                  className="font-mono"
                />
              )}
            />
            <SettingsRow
              label="Arguments template"
              description={
                <>
                  Use <code className="font-mono">{"{file}"}</code>,{" "}
                  <code className="font-mono">{"{line}"}</code>,{" "}
                  <code className="font-mono">{"{col}"}</code> as placeholders
                </>
              }
              layout="stacked"
              control={({ labelId, descriptionId }) => (
                <Input
                  id={argsId}
                  type="text"
                  value={customTemplate}
                  onChange={(e) => {
                    setCustomTemplate(e.target.value);
                    editDraft();
                  }}
                  placeholder="{file}:{line}:{col}"
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  className="font-mono"
                />
              )}
            />
          </>
        )}

        <SettingsActions
          status={
            loadError ? (
              <span className="text-status-error">{loadError}</span>
            ) : saveError ? (
              <span className="text-status-error">{saveError}</span>
            ) : testResult === "ok" ? (
              <span className="flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Open requested
              </span>
            ) : testResult === "error" ? (
              <span className="flex items-center gap-1 text-status-error">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Failed to open
              </span>
            ) : isLoadingConfig ? null : preferredEditor ? (
              <span>
                Saved:{" "}
                <span className="font-medium">
                  {preferredEditor.id === "custom"
                    ? `Custom (${preferredEditor.customCommand ?? "no command"})`
                    : EDITOR_LABELS[preferredEditor.id]}
                </span>
                {isDirty && " · Unsaved changes"}
              </span>
            ) : (
              "Not saved yet — Daintree uses the first editor it finds"
            )
          }
        >
          {loadError && (
            <Button variant="outline" size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
              Retry
            </Button>
          )}
          {/* Test opens the SAVED preference (main resolves it from the project), so it
              stays off while the draft differs rather than testing something else. */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={isTesting || !preferredEditor || isDirty}
          >
            <ExternalLink aria-hidden="true" />
            {isTesting ? "Testing…" : "Test saved editor"}
          </Button>
          <Button
            variant="contrast"
            size="sm"
            onClick={handleSave}
            disabled={
              isSaving || isLoadingConfig || !activeProjectId || !isDirty || Boolean(loadError)
            }
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
