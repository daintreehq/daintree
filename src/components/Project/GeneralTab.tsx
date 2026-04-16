import { useState, useRef, useEffect, useCallback } from "react";
import { Image, Upload, X, Rocket, Check, FolderOpen, Copy, Palette } from "lucide-react";
import { WorktreeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { getProjectGradient, isValidHexColor } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";
import { sanitizeSvg, svgToDataUrl } from "@/lib/svg";
import { GITIGNORE_SNIPPET } from "./projectSettingsConstants";
import type { Project } from "@shared/types/project";

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
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
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
  projectIconSvg,
  onProjectIconSvgChange,
  enableInRepoSettings,
  disableInRepoSettings,
  projectId,
  isOpen,
}: GeneralTabProps) {
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
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
      setInRepoError(err instanceof Error ? err.message : "Failed to enable in-repo settings");
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
      setInRepoError(err instanceof Error ? err.message : "Failed to disable in-repo settings");
    } finally {
      setInRepoEnabling(false);
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

  return (
    <>
      {currentProject && (
        <div className="mb-6 pb-6 border-b border-daintree-border">
          <h3 className="text-sm font-semibold text-daintree-text/80 mb-2">Project Identity</h3>
          <p className="text-xs text-daintree-text/60 mb-4">
            Customize how your project appears in the sidebar and dashboard.
          </p>

          <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border">
            <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Change project emoji"
                  className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-xl)] shadow-inner shrink-0 bg-tint/5 hover:bg-tint/10 transition-colors border border-transparent hover:border-daintree-border cursor-pointer group"
                  style={{
                    background: getProjectGradient(color),
                  }}
                >
                  <span className="text-3xl select-none filter drop-shadow-sm group-hover:scale-110 transition-transform">
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

            <div className="flex-1 min-w-0 flex flex-col justify-center h-14">
              <label
                htmlFor="project-name-input"
                className="text-xs font-medium text-daintree-text/60 mb-1.5 ml-1"
              >
                Project Name
              </label>
              <input
                id="project-name-input"
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                className="w-full bg-transparent border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
                placeholder="My Awesome Project"
              />
            </div>
          </div>
        </div>
      )}

      {currentProject && (
        <div className="mb-6 pb-6 border-b border-daintree-border">
          <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Project Color
          </h3>
          <p className="text-xs text-daintree-text/60 mb-4">
            Choose a color for your project&apos;s gradient background in the sidebar and dashboard.
          </p>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            {resolvedSwatches.map((hex, i) => (
              <button
                key={PRESET_SWATCHES[i].cssVar}
                type="button"
                title={PRESET_SWATCHES[i].label}
                aria-label={`Set project color to ${PRESET_SWATCHES[i].label}`}
                onClick={() => onColorChange(hex)}
                className={cn(
                  "h-7 w-7 rounded-full transition border-2 shrink-0",
                  color === hex
                    ? "border-daintree-text scale-110 shadow-sm"
                    : "border-transparent hover:border-daintree-border hover:scale-105"
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
                className="h-8 w-8 rounded-[var(--radius-md)] border border-daintree-border flex items-center justify-center cursor-pointer hover:border-daintree-text/40 transition-colors"
                style={{
                  backgroundColor: color ?? undefined,
                }}
              >
                {!color && <Palette className="h-4 w-4 text-daintree-text/40" />}
              </div>
            </div>
            <input
              type="text"
              value={hexInput}
              onChange={(e) => handleHexInputChange(e.target.value)}
              placeholder="#hex"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Hex color value"
              className={cn(
                "w-28 bg-daintree-bg border rounded px-3 py-1.5 text-sm text-daintree-text font-mono focus:outline-none focus:ring-1 transition placeholder:text-text-muted",
                hexInput && !isValidHexColor(hexInput)
                  ? "border-status-error/50 focus:border-status-error focus:ring-status-error/30"
                  : "border-daintree-border focus:border-daintree-accent focus:ring-daintree-accent/30"
              )}
            />
            {color && (
              <button
                type="button"
                onClick={() => onColorChange(undefined)}
                className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-daintree-text/60 hover:text-daintree-text hover:bg-tint/5 transition-colors"
                aria-label="Clear project color"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mb-6 pb-6 border-b border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <Rocket className="h-4 w-4" />
          Dev Server Command
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Command to start the development server (e.g., npm run dev). When configured, a button
          will appear in the toolbar to start the dev server.
        </p>

        <input
          id="dev-server-command"
          type="text"
          value={devServerCommand}
          onChange={(e) => onDevServerCommandChange(e.target.value)}
          className="w-full bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
          placeholder="npm run dev"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Dev server command"
        />

        <div className="mt-3">
          <label
            htmlFor="dev-server-load-timeout"
            className="block text-xs text-daintree-text/60 mb-1"
          >
            Load timeout (seconds)
          </label>
          <input
            id="dev-server-load-timeout"
            type="number"
            min={1}
            max={120}
            value={devServerLoadTimeout ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onDevServerLoadTimeoutChange(undefined);
              } else {
                const num = Math.max(1, Math.min(120, Math.round(Number(raw))));
                onDevServerLoadTimeoutChange(num);
              }
            }}
            className="w-28 bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
            placeholder="30"
            aria-label="Dev server load timeout in seconds"
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            id="turbopack-enabled"
            type="checkbox"
            checked={turbopackEnabled}
            onChange={(e) => onTurbopackEnabledChange(e.target.checked)}
            className="h-4 w-4 rounded border-canopy-border accent-canopy-accent cursor-pointer"
            aria-label="Auto-inject --turbopack for Next.js 15+ projects"
          />
          <label
            htmlFor="turbopack-enabled"
            className="text-xs text-canopy-text/60 cursor-pointer select-none"
          >
            Auto-inject <code className="font-mono">--turbopack</code> for Next.js 15+ projects
          </label>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <Image className="h-4 w-4" />
          Project Icon (SVG)
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Shown in the grid empty state. SVG only, max 250KB.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/svg+xml,.svg"
          onChange={handleFileSelect}
          className="hidden"
          aria-label="Select SVG file"
        />

        {projectIconSvg ? (
          <div className="flex items-center gap-4 p-3 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border">
            <div className="h-16 w-16 rounded-[var(--radius-md)] bg-daintree-sidebar flex items-center justify-center overflow-hidden">
              {(() => {
                const sanitized = sanitizeSvg(projectIconSvg);
                if (!sanitized.ok) {
                  return <Image className="h-8 w-8 text-daintree-text/40" aria-hidden="true" />;
                }
                return (
                  <img
                    src={svgToDataUrl(sanitized.svg)}
                    alt="Project icon preview"
                    className="max-h-14 max-w-14 object-contain"
                  />
                );
              })()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-daintree-text mb-1">Custom icon configured</p>
              <p className="text-xs text-daintree-text/60">
                {Math.round(new Blob([projectIconSvg]).size / 1024)}KB
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload />
                Replace
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRemoveIcon}>
                <X />
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col items-center justify-center p-8 rounded-[var(--radius-md)] border-2 border-dashed transition-colors cursor-pointer",
              isDraggingIcon
                ? "border-daintree-accent bg-daintree-accent/10"
                : "border-daintree-border hover:border-daintree-border/80 hover:bg-daintree-bg/50"
            )}
            onDrop={handleIconDrop}
            onDragOver={handleIconDragOver}
            onDragLeave={handleIconDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-8 w-8 text-daintree-text/40 mb-3" />
            <p className="text-sm text-daintree-text/60 text-center mb-1">
              Drag and drop an SVG file here
            </p>
            <p className="text-xs text-daintree-text/40">or click to browse</p>
          </div>
        )}

        {iconError && (
          <div className="mt-2 text-xs text-status-error bg-status-error/10 border border-status-error/20 rounded p-2">
            {iconError}
          </div>
        )}
      </div>

      {/* In-Repository Settings */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <WorktreeIcon className="h-4 w-4" />
          In-Repository Settings
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Store project name, emoji, and run commands in{" "}
          <code className="font-mono text-daintree-text/80">.daintree/</code> so your team shares
          the same configuration.
        </p>

        {currentProject?.daintreeConfigPresent && (
          <div className="flex items-center gap-2 mb-3 text-xs text-daintree-text/60">
            <FolderOpen className="h-3.5 w-3.5 text-status-success shrink-0" />
            <span>
              Settings loaded from{" "}
              <code className="font-mono text-daintree-text/80">.daintree/</code>
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={handleInRepoToggle}
          disabled={inRepoEnabling}
          role="switch"
          aria-checked={currentProject?.inRepoSettings ?? false}
          aria-label="Store settings in repository"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent",
            currentProject?.inRepoSettings
              ? "bg-daintree-accent/10 border-daintree-accent text-daintree-accent"
              : "border-daintree-border hover:bg-tint/5 text-daintree-text/70",
            inRepoEnabling && "opacity-50 cursor-not-allowed"
          )}
        >
          <div className="flex items-center gap-3">
            <WorktreeIcon
              className={cn(
                "w-5 h-5",
                currentProject?.inRepoSettings ? "text-daintree-accent" : "text-daintree-text/50"
              )}
              aria-hidden="true"
            />
            <div className="text-left">
              <div className="text-sm font-medium">Store settings in repository</div>
              <div className="text-xs opacity-70">
                Writes to <code className="font-mono">.daintree/project.json</code> and{" "}
                <code className="font-mono">.daintree/settings.json</code>
              </div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              currentProject?.inRepoSettings ? "bg-daintree-accent" : "bg-daintree-border"
            )}
            aria-hidden="true"
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full transition-transform",
                currentProject?.inRepoSettings
                  ? "translate-x-6 bg-text-inverse"
                  : "translate-x-1 bg-daintree-text"
              )}
            />
          </div>
        </button>

        {inRepoError && (
          <div
            className="mt-2 text-xs text-status-error bg-status-error/10 border border-status-error/20 rounded p-2"
            role="alert"
          >
            {inRepoError}
          </div>
        )}

        {!currentProject?.inRepoSettings && inRepoExpanded && (
          <div className="mt-3 rounded-[var(--radius-lg)] border border-daintree-border bg-daintree-bg p-4 space-y-4">
            <div>
              <p className="text-xs font-medium text-daintree-text/80 mb-2">
                The following files will be created:
              </p>
              <ul className="space-y-1 text-xs text-daintree-text/60">
                <li className="flex items-center gap-2">
                  <span className="font-mono text-daintree-text/80">.daintree/project.json</span>—
                  project name, emoji, color
                </li>
                <li className="flex items-center gap-2">
                  <span className="font-mono text-daintree-text/80">.daintree/settings.json</span>—
                  run commands, dev server, context settings
                </li>
              </ul>
              <p className="mt-2 text-xs text-daintree-text/50">
                Machine-local settings (environment variables, secrets) are never written to these
                files.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-daintree-text/80">
                  Recommended <code className="font-mono">.gitignore</code> guidance
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopyGitignore()}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs text-daintree-text/60 hover:text-daintree-text hover:bg-tint/5 transition-colors"
                  aria-label="Copy .gitignore snippet"
                >
                  {gitignoreCopied ? (
                    <Check className="h-3.5 w-3.5 text-status-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {gitignoreCopied ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-sidebar p-3 text-xs font-mono text-daintree-text/70 overflow-x-auto whitespace-pre select-text">
                {GITIGNORE_SNIPPET}
              </pre>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInRepoExpanded(false);
                  setInRepoError(null);
                }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleEnableInRepoSettings()}
                disabled={inRepoEnabling}
                className="flex-1"
              >
                {inRepoEnabling ? "Enabling..." : "Confirm and enable"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
