import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Image, Upload, Check, FolderInput, Copy, Palette, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import type { ChoiceboxOption } from "@/components/Settings/SettingsChoicebox";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsNumberInput } from "@/components/Settings/SettingsNumberInput";
import { getProjectGradient, isValidHexColor } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";
import { sanitizeSvg, svgToDataUrl } from "@/lib/svg";
import { GITIGNORE_SNIPPET } from "./projectSettingsConstants";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import type { DaintreeMcpTier, Project } from "@shared/types/project";
import { workspaceResidencyClient } from "@/clients/workspaceResidencyClient";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { findDevServerCandidate } from "@/utils/devServerDetection";

const DAINTREE_MCP_TIER_OPTIONS: readonly ChoiceboxOption<DaintreeMcpTier>[] = [
  {
    value: "off",
    label: "Off",
    description: "No Daintree MCP access. Default for new projects.",
  },
  {
    value: "workbench",
    label: "Workbench",
    description: "Read-only: worktree status, terminal output, file search, project history",
  },
  {
    value: "action",
    label: "Action",
    description:
      "Workbench + create worktrees, open terminals and run commands in them, confirm-gated worktree deletes. Over MCP, an agent can only type into terminals it opened.",
  },
  {
    value: "system",
    label: "System",
    description:
      "Action + git commits and pushes, forge and file writes, terminal arming, worktree creation anywhere on disk",
  },
];

const PRESET_SWATCHES = [
  { label: "Blue", cssVar: "--theme-category-blue" },
  { label: "Purple", cssVar: "--theme-category-purple" },
  { label: "Cyan", cssVar: "--theme-category-cyan" },
  { label: "Green", cssVar: "--theme-category-green" },
  { label: "Amber", cssVar: "--theme-category-amber" },
  { label: "Orange", cssVar: "--theme-category-orange" },
  { label: "Teal", cssVar: "--theme-category-teal" },
  { label: "Indigo", cssVar: "--theme-category-indigo" },
  { label: "Rose", cssVar: "--theme-category-rose" },
  { label: "Pink", cssVar: "--theme-category-pink" },
  { label: "Violet", cssVar: "--theme-category-violet" },
  { label: "Slate", cssVar: "--theme-category-slate" },
] as const;

function cssColorToHex(cssColor: string): string | undefined {
  if (!cssColor) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${r!.toString(16).padStart(2, "0")}${g!.toString(16).padStart(2, "0")}${b!.toString(16).padStart(2, "0")}`;
}

interface GeneralTabProps {
  currentProject: Project | undefined;
  name: string;
  onNameChange: (value: string) => void;
  emoji: string;
  onEmojiChange: (value: string) => void;
  color: string | undefined;
  onColorChange: (value: string | undefined) => void;
  devServerCommand: string;
  onDevServerCommandChange: (value: string) => void;
  devServerLoadTimeout: number | undefined;
  onDevServerLoadTimeoutChange: (value: number | undefined) => void;
  turbopackEnabled: boolean;
  onTurbopackEnabledChange: (value: boolean) => void;
  daintreeMcpTier: DaintreeMcpTier;
  onDaintreeMcpTierChange: (value: DaintreeMcpTier) => void;
  projectIconSvg: string | undefined;
  onProjectIconSvgChange: (value: string | undefined) => void;
  enableInRepoSettings: (projectId: string) => Promise<Project>;
  disableInRepoSettings: (projectId: string) => Promise<Project>;
  projectId: string;
  isOpen: boolean;
}

export function GeneralTab({
  currentProject,
  name,
  onNameChange,
  emoji,
  onEmojiChange,
  color,
  onColorChange,
  devServerCommand,
  onDevServerCommandChange,
  devServerLoadTimeout,
  onDevServerLoadTimeoutChange,
  turbopackEnabled,
  onTurbopackEnabledChange,
  daintreeMcpTier,
  onDaintreeMcpTierChange,
  projectIconSvg,
  onProjectIconSvgChange,
  enableInRepoSettings,
  disableInRepoSettings,
  projectId,
  isOpen,
}: GeneralTabProps) {
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [keepResident, setKeepResident] = useState(false);
  // Read by the residency save handler to tell "still this project" from "the
  // dialog moved on"; a captured `projectId` would only ever equal itself.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [keepResidentBusy, setKeepResidentBusy] = useState(true);
  const [keepResidentError, setKeepResidentError] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [isDraggingIcon, setIsDraggingIcon] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [hexInput, setHexInput] = useState(color ?? "");
  const [resolvedSwatches, setResolvedSwatches] = useState<string[]>([]);
  const colorInputRef = useRef<HTMLInputElement>(null);

  const [inRepoExpanded, setInRepoExpanded] = useState(false);
  const [inRepoEnabling, setInRepoEnabling] = useState(false);
  const [inRepoError, setInRepoError] = useState<string | null>(null);
  const [gitignoreCopied, setGitignoreCopied] = useState(false);
  const gitignoreCopyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const allDetectedRunners = useProjectSettingsStore((s) => s.allDetectedRunners);
  const openRelocation = useProjectRelocationStore((s) => s.open);

  const handleMoveOrRename = useCallback(() => {
    if (!currentProject) return;
    openRelocation({
      projectId,
      mode: "move",
      oldPath: currentProject.path,
      // Seed from the live Settings draft so an unsaved inline edit carries in,
      // and sync the draft back on commit so the Settings close-flush can't
      // revert the dialog's rename.
      name,
      onDisplayNameCommitted: onNameChange,
    });
  }, [openRelocation, projectId, currentProject, name, onNameChange]);

  const detectedCandidate = useMemo(() => {
    const candidate = findDevServerCandidate(allDetectedRunners, turbopackEnabled);
    if (candidate) return candidate;
    return allDetectedRunners?.find((r) => r.id === "devcontainer-poststart");
  }, [allDetectedRunners, turbopackEnabled]);

  const detectedCandidateRef = useRef(detectedCandidate);
  detectedCandidateRef.current = detectedCandidate;

  const handleApplyDetected = useCallback(() => {
    if (detectedCandidateRef.current) {
      onDevServerCommandChange(detectedCandidateRef.current.command);
    }
  }, [onDevServerCommandChange]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const hexValues = PRESET_SWATCHES.map((s) => {
        const raw = styles.getPropertyValue(s.cssVar).trim();
        return cssColorToHex(raw) ?? "#000000";
      });
      setResolvedSwatches(hexValues);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  useEffect(() => {
    setHexInput(color ?? "");
  }, [color]);

  const handleHexInputChange = useCallback(
    (value: string) => {
      setHexInput(value);
      if (value === "") {
        onColorChange(undefined);
      } else if (isValidHexColor(value)) {
        onColorChange(value.toLowerCase());
      }
    },
    [onColorChange]
  );

  useEffect(() => {
    if (!isOpen) {
      setIsEmojiPickerOpen(false);
      setIconError(null);
      setIsDraggingIcon(false);
      setInRepoExpanded(false);
      setInRepoEnabling(false);
      setInRepoError(null);
      setGitignoreCopied(false);
      if (gitignoreCopyTimeoutRef.current) {
        clearTimeout(gitignoreCopyTimeoutRef.current);
        gitignoreCopyTimeoutRef.current = null;
      }
    }
  }, [isOpen]);

  const handleIconFile = async (file: File) => {
    setIconError(null);
    if (!file.type.includes("svg")) {
      setIconError("Please select an SVG file");
      return;
    }
    try {
      const text = await file.text();
      const result = sanitizeSvg(text);
      if (!result.ok) {
        setIconError(result.error);
        return;
      }
      onProjectIconSvgChange(result.svg);
    } catch {
      setIconError("Failed to read file");
    }
  };

  const handleIconDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      void handleIconFile(file);
    }
  };

  const handleIconDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(true);
  };

  const handleIconDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleIconFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRemoveIcon = () => {
    onProjectIconSvgChange(undefined);
    setIconError(null);
  };

  const handleCopyGitignore = async () => {
    try {
      await navigator.clipboard.writeText(GITIGNORE_SNIPPET);
      setGitignoreCopied(true);
      if (gitignoreCopyTimeoutRef.current) clearTimeout(gitignoreCopyTimeoutRef.current);
      gitignoreCopyTimeoutRef.current = setTimeout(() => {
        setGitignoreCopied(false);
        gitignoreCopyTimeoutRef.current = null;
      }, 2000);
    } catch {
      // clipboard access denied — fail silently
    }
  };

  const handleEnableInRepoSettings = async () => {
    if (!currentProject || inRepoEnabling) return;
    setInRepoEnabling(true);
    setInRepoError(null);
    try {
      const updated = await enableInRepoSettings(projectId);
      if (!updated.inRepoSettings) {
        setInRepoError("In-repo settings could not be enabled. Please try again.");
      } else {
        setInRepoExpanded(false);
      }
    } catch (err) {
      // The forward-compat refusal (#12261) carries its per-file detail in
      // `userMessage` — `context` never survives the contextBridge — so lead
      // with why nothing was written and list the files underneath.
      if (isClientAppError(err) && err.code === "RECIPE_FORWARD_COMPAT_CONFLICT") {
        setInRepoError(
          "In-repo settings weren't enabled. These recipe files hold content this version of " +
            "Daintree doesn't understand, and enabling would delete it from them:\n" +
            (err.userMessage ?? "")
        );
      } else {
        setInRepoError(formatErrorMessage(err, "Failed to enable in-repo settings"));
      }
    } finally {
      setInRepoEnabling(false);
    }
  };

  const handleDisableInRepoSettings = async () => {
    if (!currentProject || inRepoEnabling) return;
    setInRepoEnabling(true);
    setInRepoError(null);
    try {
      await disableInRepoSettings(projectId);
    } catch (err) {
      setInRepoError(formatErrorMessage(err, "Failed to disable in-repo settings"));
    } finally {
      setInRepoEnabling(false);
    }
  };

  // Loaded on open rather than held in a store: the grant lives in
  // electron-store, another window can change it, and this dialog is the only
  // place that reads it — so a fresh read when the tab opens is both simpler and
  // more current than anything cached would be.
  useEffect(() => {
    if (!isOpen || !projectId) {
      // The toggle starts disabled and only the load re-enables it, so a tab
      // that never loads must not leave it stuck that way.
      setKeepResidentBusy(false);
      return;
    }
    let cancelled = false;
    setKeepResidentBusy(true);
    setKeepResidentError(null);
    void workspaceResidencyClient
      .get(projectId)
      .then((value) => {
        if (!cancelled) setKeepResident(value);
      })
      .catch((err) => {
        if (!cancelled) {
          setKeepResidentError(formatErrorMessage(err, "Failed to read the residency setting"));
        }
      })
      .finally(() => {
        if (!cancelled) setKeepResidentBusy(false);
      });
    return () => {
      // Guards the late response after the dialog closes or the project
      // changes — otherwise a slow read lands on the next project's toggle.
      cancelled = true;
    };
  }, [isOpen, projectId]);

  const handleKeepResidentToggle = async () => {
    const next = !keepResident;
    // The write is for the project as it stands now. The dialog can be pointed
    // at another project while it is in flight, and the load effect's own guard
    // does not cover this direction — without the capture, a slow save for one
    // project lands its result on whichever project the tab is showing when it
    // settles, reporting the wrong grant or the wrong error.
    const savingProjectId = projectId;
    setKeepResidentBusy(true);
    setKeepResidentError(null);
    try {
      await workspaceResidencyClient.set(savingProjectId, next);
      if (savingProjectId === projectIdRef.current) setKeepResident(next);
    } catch (err) {
      if (savingProjectId === projectIdRef.current) {
        setKeepResidentError(formatErrorMessage(err, "Failed to save the residency setting"));
      }
    } finally {
      if (savingProjectId === projectIdRef.current) setKeepResidentBusy(false);
    }
  };

  const handleInRepoToggle = () => {
    if (currentProject?.inRepoSettings) {
      void handleDisableInRepoSettings();
    } else {
      setInRepoExpanded((prev) => !prev);
      setInRepoError(null);
    }
  };

  const iconPreview = (() => {
    if (!projectIconSvg) return null;
    const sanitized = sanitizeSvg(projectIconSvg);
    if (!sanitized.ok) {
      return <Image className="h-6 w-6 text-text-secondary" aria-hidden="true" />;
    }
    return (
      <img
        src={svgToDataUrl(sanitized.svg)}
        alt="Project icon preview"
        className="max-h-10 max-w-10 object-contain"
      />
    );
  })();

  return (
    <div className="space-y-8">
      {currentProject && (
        <SettingsSection
          id="project-name"
          title="Project identity"
          description="How this project appears in the sidebar and dashboard"
        >
          <SettingsGroup>
            <SettingsRow
              label="Name"
              description="Click the emoji to change it"
              layout="stacked"
              control={({ labelId, descriptionId }) => (
                <div className="flex items-center gap-3">
                  <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Change project emoji"
                        className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-lg)] shadow-inner shrink-0 border border-border-strong cursor-pointer group"
                        style={{
                          background: getProjectGradient(color),
                        }}
                      >
                        <span className="text-2xl select-none filter drop-shadow-sm group-hover:scale-110 transition-transform">
                          {emoji}
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <EmojiPicker
                        onEmojiSelect={({ emoji }) => {
                          onEmojiChange(emoji);
                          setIsEmojiPickerOpen(false);
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                  <Input
                    id="project-name-input"
                    type="text"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    placeholder="My project"
                  />
                </div>
              )}
            />

            <SettingsRow
              label="Color"
              description="Tints the project's gradient in the sidebar and dashboard"
              layout="stacked"
              control={
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {resolvedSwatches.map((hex, i) => (
                      <button
                        key={PRESET_SWATCHES[i]!.cssVar}
                        type="button"
                        title={PRESET_SWATCHES[i]!.label}
                        aria-label={`Set project color to ${PRESET_SWATCHES[i]!.label}`}
                        onClick={() => onColorChange(hex)}
                        className={cn(
                          "h-7 w-7 rounded-full transition-[border-color,scale,box-shadow] border-2 shrink-0",
                          color === hex
                            ? "border-text-primary scale-110 shadow-sm"
                            : "border-transparent hover:border-border-default hover:scale-105"
                        )}
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <input
                        ref={colorInputRef}
                        type="color"
                        value={color ?? "#6366f1"}
                        onChange={(e) => onColorChange(e.target.value.toLowerCase())}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        aria-label="Pick a custom color"
                      />
                      <div
                        className="h-8 w-8 rounded-[var(--radius-md)] border border-border-strong flex items-center justify-center cursor-pointer"
                        style={{
                          backgroundColor: color ?? undefined,
                        }}
                      >
                        {!color && <Palette className="h-4 w-4 text-text-secondary" />}
                      </div>
                    </div>
                    <Input
                      type="text"
                      value={hexInput}
                      onChange={(e) => handleHexInputChange(e.target.value)}
                      placeholder="#hex"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                      aria-label="Hex color value"
                      invalid={!!hexInput && !isValidHexColor(hexInput)}
                      className="w-28 font-mono"
                    />
                    {color && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onColorChange(undefined)}
                        aria-label="Clear project color"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              }
            />

            <SettingsRow
              label="Icon"
              description="An SVG shown in the empty grid, up to 250KB"
              layout="stacked"
              error={iconError ?? undefined}
              control={({ labelId, descriptionId, disabled: rowDisabled }) => (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/svg+xml,.svg"
                    onChange={handleFileSelect}
                    className="hidden"
                    aria-label="Select SVG file"
                  />
                  {projectIconSvg ? (
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 rounded-[var(--radius-md)] bg-surface-sidebar flex items-center justify-center overflow-hidden shrink-0">
                        {iconPreview}
                      </div>
                      <p className="flex-1 min-w-0 text-xs text-text-secondary">
                        Custom icon · {Math.round(new Blob([projectIconSvg]).size / 1024)}KB
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload />
                        Replace
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleRemoveIcon}>
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="project-icon-uploader"
                      // The visible prompt joins the row label so the spoken name
                      // contains what sighted users read on the button (WCAG 2.5.3).
                      aria-labelledby={`${labelId} project-icon-uploader-prompt`}
                      aria-describedby={descriptionId}
                      disabled={rowDisabled}
                      className={cn(
                        "flex w-full items-center justify-center gap-2 px-4 py-4 rounded-[var(--radius-md)] border border-dashed border-border-strong transition-colors cursor-pointer",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        isDraggingIcon ? "bg-overlay-soft" : "hover:bg-overlay-subtle"
                      )}
                      onDrop={handleIconDrop}
                      onDragOver={handleIconDragOver}
                      onDragLeave={handleIconDragLeave}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                      <span
                        id="project-icon-uploader-prompt"
                        className="text-xs text-text-secondary"
                      >
                        Drop an SVG here or click to browse
                      </span>
                    </button>
                  )}
                </>
              )}
            />

            <SettingsRow
              label="Location"
              description={
                <span className="block truncate font-mono" title={currentProject.path}>
                  {currentProject.path}
                </span>
              }
              control={
                <Button variant="outline" size="sm" onClick={handleMoveOrRename}>
                  <FolderInput />
                  Move or rename…
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        id="project-dev-server"
        title="Dev server"
        description="When a command is set, the toolbar shows a button that starts it"
      >
        <SettingsGroup>
          <SettingsRow
            label="Command"
            layout="stacked"
            control={
              <div className="space-y-2">
                <Input
                  id="dev-server-command"
                  type="text"
                  value={devServerCommand}
                  onChange={(e) => onDevServerCommandChange(e.target.value)}
                  className="font-mono"
                  placeholder="npm run dev"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  aria-label="Dev server command"
                />
                {devServerCommand === "" && detectedCandidate && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">
                      Detected:{" "}
                      <code className="font-mono text-text-primary">
                        {detectedCandidate.command}
                      </code>
                    </span>
                    <Button onClick={handleApplyDetected} variant="outline" size="sm">
                      Use command
                    </Button>
                  </div>
                )}
              </div>
            }
          />
          <SettingsNumberInput
            label="Load timeout"
            description="How long to wait for the server to respond · Default: 30 seconds"
            suffix="s"
            min={1}
            max={120}
            value={devServerLoadTimeout ?? ""}
            isModified={devServerLoadTimeout !== undefined}
            onReset={() => onDevServerLoadTimeoutChange(undefined)}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onDevServerLoadTimeoutChange(undefined);
              } else {
                const num = Math.max(1, Math.min(120, Math.round(Number(raw))));
                onDevServerLoadTimeoutChange(num);
              }
            }}
            placeholder="30"
          />
          <SettingsSwitchCard
            title="Use Turbopack for Next.js"
            subtitle="Adds --turbopack to the dev command in Next.js 15+ projects"
            isEnabled={turbopackEnabled}
            onChange={() => onTurbopackEnabledChange(!turbopackEnabled)}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="project-agent-integrations"
        title="Agent integrations"
        description="How much of Daintree the Claude Code agents launched in this project's worktrees can reach. Newly launched agents pick up the change."
      >
        <SettingsGroup className="checkbox-neutral">
          <fieldset className="divide-y divide-border-subtle">
            <legend className="sr-only">Daintree MCP access tier</legend>
            {DAINTREE_MCP_TIER_OPTIONS.map((option) => (
              <RadioChoiceRow
                key={option.value}
                name="daintreeMcpTier"
                value={option.value}
                checked={daintreeMcpTier === option.value}
                onChange={() => onDaintreeMcpTierChange(option.value)}
                label={option.label}
                description={option.description}
                bare
                className="w-full px-4 py-3"
              />
            ))}
          </fieldset>
          {daintreeMcpTier === "system" && (
            <div className="flex items-start gap-2 px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-px" />
              <p className="text-xs text-text-secondary leading-relaxed select-text">
                System tier adds git commits and pushes, forge issue/PR writes, clipboard and file
                writes, terminal arming, and worktree creation anywhere on disk — some of these are
                irreversible or visible to teammates. Only enable it for projects where you trust
                the agent to take that kind of action.
              </p>
            </div>
          )}
        </SettingsGroup>
        <SettingsGroup>
          <SettingsSwitchCard
            title="Keep workspace resident"
            subtitle="Holds this project's view in the cache so a bound MCP session stays reachable. Other projects close first to stay within your cached-view limit; low memory can still unload this one."
            isEnabled={keepResident}
            onChange={() => void handleKeepResidentToggle()}
            disabled={keepResidentBusy}
          />
          {keepResidentError && (
            <p
              className="whitespace-pre-line px-4 py-2.5 text-xs text-status-error select-text"
              role="alert"
            >
              {keepResidentError}
            </p>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="project-in-repo-settings"
        title="In-repository settings"
        description="Keeps the project name, emoji, and run commands in .daintree/ so your team shares one configuration"
      >
        <SettingsGroup>
          <SettingsSwitchCard
            title="Store settings in repository"
            subtitle={
              currentProject?.daintreeConfigPresent
                ? "Writes to .daintree/project.json and .daintree/settings.json. Settings are currently loaded from .daintree/."
                : "Writes to .daintree/project.json and .daintree/settings.json"
            }
            isEnabled={currentProject?.inRepoSettings ?? false}
            onChange={handleInRepoToggle}
            disabled={inRepoEnabling}
          />

          {!currentProject?.inRepoSettings && inRepoExpanded && (
            <div className="px-4 py-3 space-y-4">
              <div>
                <p className="text-xs font-medium text-text-primary mb-2">
                  These files will be created
                </p>
                <ul className="space-y-1 text-xs text-text-secondary">
                  <li className="flex items-center gap-2">
                    <span className="font-mono font-medium text-text-primary">
                      .daintree/project.json
                    </span>
                    <span>project name, emoji, color</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="font-mono font-medium text-text-primary">
                      .daintree/settings.json
                    </span>
                    <span>run commands, dev server, context settings</span>
                  </li>
                </ul>
                <p className="mt-2 text-xs text-text-secondary">
                  Machine-local settings (environment variables, secrets) are never written to these
                  files.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-medium text-text-primary">
                    Recommended <code className="font-mono">.gitignore</code> entries
                  </p>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleCopyGitignore()}
                    aria-label="Copy .gitignore snippet"
                  >
                    {gitignoreCopied ? <Check /> : <Copy />}
                    {gitignoreCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="rounded-[var(--radius-md)] border border-border-default bg-surface-sidebar p-3 text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre select-text">
                  {GITIGNORE_SNIPPET}
                </pre>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInRepoExpanded(false);
                    setInRepoError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="contrast"
                  size="sm"
                  onClick={() => void handleEnableInRepoSettings()}
                  disabled={inRepoEnabling}
                >
                  {inRepoEnabling ? "Enabling…" : "Confirm and enable"}
                </Button>
              </div>
            </div>
          )}

          {inRepoError && (
            <p
              className="whitespace-pre-line px-4 py-2.5 text-xs text-status-error select-text"
              role="alert"
            >
              {inRepoError}
            </p>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
