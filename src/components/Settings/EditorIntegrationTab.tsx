import { useState, useEffect, useRef, useId } from "react";
import { CheckCircle, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
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
  const isMountedRef = useRef(true);
  const editorId = useId();
  const commandId = useId();
  const argsId = useId();

  const activeProjectId = useProjectStore((s) => s.currentProject?.id);
  const activeProjectPath = useProjectStore((s) => s.currentProject?.path);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    editorClient
      .getConfig(activeProjectId)
      .then(({ preferredEditor: pref, discoveredEditors: discovered }) => {
        if (cancelled || !isMountedRef.current) return;
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
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const handleRescan = async () => {
    setIsRescanning(true);
    try {
      const editors = await editorClient.discover();
      if (!isMountedRef.current) return;
      setDiscoveredEditors(editors);
    } catch (err) {
      logError("[EditorIntegrationTab] Rescan failed", err);
    } finally {
      if (isMountedRef.current) setIsRescanning(false);
    }
  };

  const handleSave = async () => {
    if (!activeProjectId || isSaving) return;
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
      await window.electron.system.openInEditor({
        path: activeProjectPath,
        projectId: activeProjectId,
      });
      if (!isMountedRef.current) return;
      setTestResult("ok");
    } catch {
      if (!isMountedRef.current) return;
      setTestResult("error");
    } finally {
      if (isMountedRef.current) setIsTesting(false);
    }
  };

  const availabilityMap = new Map(discoveredEditors.map((d) => [d.id, d]));

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
      description="The editor that opens when you click 'Open in editor' in the diff viewer or worktree cards"
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
                onValueChange={(value) => setSelectedId(value as KnownEditorId)}
                disabled={disabled}
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
          <SettingsRow
            label="Detected editors"
            layout="stacked"
            control={
              <ul className="space-y-1">
                {discoveredEditors.map((d) => (
                  <li
                    key={d.id}
                    className="flex min-w-0 items-center gap-2 text-xs text-text-secondary"
                  >
                    {d.available ? (
                      <CheckCircle
                        className="w-3.5 h-3.5 text-text-secondary shrink-0"
                        aria-label="Found"
                      />
                    ) : (
                      <AlertCircle
                        className="w-3.5 h-3.5 text-text-secondary shrink-0"
                        aria-label="Not found"
                      />
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
                      <span
                        className="min-w-0 truncate font-mono text-text-secondary"
                        title={d.executablePath}
                      >
                        {d.executablePath}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            }
          />
        )}

        {selectedId === "custom" && (
          <>
            <SettingsRow
              label="Command"
              layout="stacked"
              control={({ labelId }) => (
                <Input
                  id={commandId}
                  type="text"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="e.g. code, nvim, subl"
                  aria-labelledby={labelId}
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
                  onChange={(e) => setCustomTemplate(e.target.value)}
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
            saveError ? (
              <span className="text-status-error">{saveError}</span>
            ) : testResult === "ok" ? (
              <span className="flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Open requested
              </span>
            ) : testResult === "error" ? (
              <span className="flex items-center gap-1 text-status-error">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Failed to open
              </span>
            ) : preferredEditor ? (
              <span>
                Saved: <span className="font-medium">{EDITOR_LABELS[preferredEditor.id]}</span>
                {isDirty && " · Save to test this choice"}
              </span>
            ) : (
              "Not saved yet — Daintree uses the first editor it finds"
            )
          }
        >
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
            disabled={isSaving || !activeProjectId || !isDirty}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
