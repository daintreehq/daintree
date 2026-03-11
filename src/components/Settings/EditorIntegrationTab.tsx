import { useState, useEffect, useRef } from "react";
import { Code2, CheckCircle, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { editorClient } from "@/clients/editorClient";
import type { EditorConfig, DiscoveredEditor, KnownEditorId } from "@shared/types/editor";
import { useProjectStore } from "@/store";

const EDITOR_LABELS: Record<KnownEditorId, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  windsurf: "Windsurf",
  zed: "Zed",
  neovim: "Neovim",
  webstorm: "WebStorm / IntelliJ",
  sublime: "Sublime Text",
  custom: "Custom…",
};

const ORDERED_KNOWN_IDS: KnownEditorId[] = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "zed",
  "neovim",
  "webstorm",
  "sublime",
  "custom",
];

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

  const activeProjectId = useProjectStore((s) => s.currentProject?.id);

  useEffect(() => {
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
        console.error("[EditorIntegrationTab] Failed to load config:", err);
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
      console.error("[EditorIntegrationTab] Rescan failed:", err);
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
      if (!isMountedRef.current) return;
      setPreferredEditor(editor);
    } catch (err) {
      if (!isMountedRef.current) return;
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (!activeProjectId || isTesting) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      // Open a safe, known-to-exist file to test the editor integration
      const homeDir = await window.electron.system.getHomeDir();
      await window.electron.system.openInEditor({ path: homeDir });
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

  if (!activeProjectId) {
    return (
      <div className="p-4 text-sm text-canopy-text/50">
        Open a project to configure its editor preference.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={Code2}
        title="External Editor"
        description="Choose the editor that opens when you click 'Open in editor' in the diff viewer or worktree cards."
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-canopy-text/60">Editor</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value as KnownEditorId)}
                className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors"
              >
                {ORDERED_KNOWN_IDS.map((id) => {
                  const disc = availabilityMap.get(id);
                  const available = id === "custom" ? true : (disc?.available ?? false);
                  return (
                    <option key={id} value={id}>
                      {EDITOR_LABELS[id]}
                      {id !== "custom" && !available ? " (not found)" : ""}
                    </option>
                  );
                })}
              </select>
              <button
                onClick={handleRescan}
                disabled={isRescanning}
                title="Re-scan for installed editors"
                className="p-2 rounded-[var(--radius-md)] border border-canopy-border hover:bg-white/5 text-canopy-text/60 hover:text-canopy-text transition-colors disabled:opacity-40"
              >
                <RefreshCw className={cn("w-4 h-4", isRescanning && "animate-spin")} />
              </button>
            </div>
          </div>

          {selectedId !== "custom" && (
            <div className="space-y-1">
              <p className="text-xs text-canopy-text/50">Detected editors:</p>
              <div className="space-y-1">
                {discoveredEditors.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-xs text-canopy-text/60">
                    {d.available ? (
                      <CheckCircle className="w-3.5 h-3.5 text-status-success shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 text-canopy-text/30 shrink-0" />
                    )}
                    <span className={d.available ? "text-canopy-text/80" : "text-canopy-text/30"}>
                      {EDITOR_LABELS[d.id]}
                    </span>
                    {d.executablePath && (
                      <span className="font-mono text-canopy-text/30 truncate">
                        {d.executablePath}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedId === "custom" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-canopy-text/60">Command</label>
                <input
                  type="text"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="e.g. code, nvim, subl"
                  className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-canopy-text/60">Arguments template</label>
                <input
                  type="text"
                  value={customTemplate}
                  onChange={(e) => setCustomTemplate(e.target.value)}
                  placeholder="{file}:{line}:{col}"
                  className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors font-mono"
                />
                <p className="text-xs text-canopy-text/40">
                  Use <code className="font-mono">{"{file}"}</code>,{" "}
                  <code className="font-mono">{"{line}"}</code>,{" "}
                  <code className="font-mono">{"{col}"}</code> as placeholders.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving || !activeProjectId}
              className="px-4 py-2 rounded-[var(--radius-md)] bg-canopy-accent text-canopy-bg text-sm font-medium hover:bg-canopy-accent/90 disabled:opacity-50 transition-colors"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>

            <button
              onClick={handleTest}
              disabled={isTesting}
              className="px-4 py-2 rounded-[var(--radius-md)] border border-canopy-border text-sm text-canopy-text/70 hover:text-canopy-text hover:bg-white/5 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {isTesting ? "Testing…" : "Test"}
            </button>

            {testResult === "ok" && (
              <span className="flex items-center gap-1 text-xs text-status-success">
                <CheckCircle className="w-3.5 h-3.5" /> Opened successfully
              </span>
            )}
            {testResult === "error" && (
              <span className="flex items-center gap-1 text-xs text-status-error">
                <AlertCircle className="w-3.5 h-3.5" /> Failed to open
              </span>
            )}
          </div>

          {saveError && <p className="text-xs text-status-error">{saveError}</p>}

          {preferredEditor && (
            <p className="text-xs text-canopy-text/40">
              Saved: <span className="font-medium">{EDITOR_LABELS[preferredEditor.id]}</span>
            </p>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
