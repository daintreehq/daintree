import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  Globe,
  Check,
  X,
  Search,
  Layers,
  ArrowRightToLine,
  SquareStack,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidecarStore } from "@/store/sidecarStore";
import { useLinkDiscovery } from "@/hooks/useLinkDiscovery";
import {
  LINK_TEMPLATES,
  SIDECAR_MIN_WIDTH,
  SIDECAR_MAX_WIDTH,
  SIDECAR_DEFAULT_WIDTH,
  MIN_GRID_WIDTH,
} from "@shared/types";
import type { SidecarLayoutModePreference } from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { actionService } from "@/services/ActionService";

function ServiceIcon({ name, size = 16 }: { name: string; size?: number }) {
  const className = size === 16 ? "w-4 h-4" : size === 32 ? "w-8 h-8" : "w-4 h-4";

  // Handle special cases first
  if (name === "globe") {
    return <Globe className={className} />;
  }
  if (name === "search") {
    return <Search className={className} />;
  }

  // Try to get agent config from registry
  if (isRegisteredAgent(name)) {
    const config = getAgentConfig(name);
    if (config) {
      const Icon = config.icon;
      return <Icon className={className} brandColor={config.color} />;
    }
  }

  return <Globe className={className} />;
}

function FaviconIcon({ url }: { url: string }) {
  const [hasError, setHasError] = useState(false);

  try {
    const domain = new URL(url).hostname;
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

    if (hasError) {
      return <Globe className="w-4 h-4" />;
    }

    return <img src={faviconUrl} alt="" className="w-4 h-4" onError={() => setHasError(true)} />;
  } catch {
    return <Globe className="w-4 h-4" />;
  }
}

const LAYOUT_MODE_OPTIONS: Array<{
  id: SidecarLayoutModePreference;
  label: string;
  description: string;
  icon: typeof Layers;
}> = [
  {
    id: "auto",
    label: "Auto",
    description: "Adapts to window size",
    icon: Layers,
  },
  {
    id: "push",
    label: "Push",
    description: "Always pushes content",
    icon: ArrowRightToLine,
  },
  {
    id: "overlay",
    label: "Overlay",
    description: "Always overlays content",
    icon: SquareStack,
  },
];

export function SidecarSettingsTab() {
  const links = useSidecarStore((s) => s.links);
  const layoutModePreference = useSidecarStore((s) => s.layoutModePreference);
  const width = useSidecarStore((s) => s.width);
  const defaultNewTabUrl = useSidecarStore((s) => s.defaultNewTabUrl);
  const { rescan, isScanning } = useLinkDiscovery();

  const [newLinkName, setNewLinkName] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [localWidth, setLocalWidth] = useState(width);
  const isAdjustingWidthRef = useRef(false);
  const [showCustomUrlInput, setShowCustomUrlInput] = useState(false);
  const [customDefaultUrl, setCustomDefaultUrl] = useState("");
  const [customUrlError, setCustomUrlError] = useState("");

  const clampWidth = (v: number) => Math.min(SIDECAR_MAX_WIDTH, Math.max(SIDECAR_MIN_WIDTH, v));

  useEffect(() => {
    if (!isAdjustingWidthRef.current) setLocalWidth(width);
  }, [width]);

  const discoveredLinks = links.filter((l) => l.type === "discovered");
  const userLinks = links.filter((l) => l.type === "user");

  const handleAddLink = () => {
    if (!newLinkName.trim() || !newLinkUrl.trim()) {
      setUrlError("Name and URL are required");
      return;
    }

    try {
      const url = new URL(newLinkUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        setUrlError("URL must use http:// or https://");
        return;
      }
    } catch {
      setUrlError("Invalid URL format");
      return;
    }

    void actionService.dispatch(
      "sidecar.links.add",
      {
        title: newLinkName,
        url: newLinkUrl,
        icon: "globe",
        type: "user",
        enabled: true,
      },
      { source: "user" }
    );

    setNewLinkName("");
    setNewLinkUrl("");
    setUrlError("");
  };

  const handleStartEdit = (id: string, title: string, url: string) => {
    setEditingLinkId(id);
    setEditName(title);
    setEditUrl(url);
  };

  const handleSaveEdit = () => {
    if (!editingLinkId || !editName.trim() || !editUrl.trim()) {
      setUrlError("Name and URL are required");
      return;
    }

    try {
      const url = new URL(editUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        setUrlError("URL must use http:// or https://");
        return;
      }
    } catch {
      setUrlError("Invalid URL format");
      return;
    }

    void actionService.dispatch(
      "sidecar.links.update",
      { id: editingLinkId, updates: { title: editName, url: editUrl } },
      { source: "user" }
    );
    setEditingLinkId(null);
    setEditName("");
    setEditUrl("");
    setUrlError("");
  };

  const handleCancelEdit = () => {
    setEditingLinkId(null);
    setEditName("");
    setEditUrl("");
    setUrlError("");
  };

  const knownServices = Object.entries(LINK_TEMPLATES).filter(
    ([_, template]) => template.cliDetector
  );

  const enabledLinks = links.filter((l) => l.enabled).sort((a, b) => a.order - b.order);

  const isCustomUrl =
    defaultNewTabUrl !== null && !enabledLinks.some((l) => l.url === defaultNewTabUrl);

  const handleDefaultAgentChange = (value: string) => {
    if (value === "none") {
      void actionService.dispatch("sidecar.setDefaultNewTab", { url: null }, { source: "user" });
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError("");
    } else if (value === "custom") {
      setShowCustomUrlInput(true);
      if (isCustomUrl && defaultNewTabUrl) {
        setCustomDefaultUrl(defaultNewTabUrl);
      }
    } else {
      void actionService.dispatch("sidecar.setDefaultNewTab", { url: value }, { source: "user" });
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError("");
    }
  };

  const handleCustomUrlSave = () => {
    if (!customDefaultUrl.trim()) {
      setCustomUrlError("URL is required");
      return;
    }
    try {
      const url = new URL(customDefaultUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        setCustomUrlError("URL must use http:// or https://");
        return;
      }
      void actionService.dispatch(
        "sidecar.setDefaultNewTab",
        { url: customDefaultUrl },
        { source: "user" }
      );
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError("");
    } catch {
      setCustomUrlError("Invalid URL format");
    }
  };

  const handleCustomUrlCancel = () => {
    setShowCustomUrlInput(false);
    setCustomDefaultUrl("");
    setCustomUrlError("");
  };

  return (
    <div className="space-y-6">
      <section>
        <h4 id="default-agent-label" className="text-sm font-medium text-canopy-text mb-2">
          Default New Tab Agent
        </h4>
        <p className="text-xs text-canopy-text/50 mb-3">
          Choose which agent opens when you click the + button. Select "None" to show the Launchpad.
        </p>

        <div className="space-y-3">
          <select
            aria-labelledby="default-agent-label"
            value={
              showCustomUrlInput
                ? "custom"
                : defaultNewTabUrl === null
                  ? "none"
                  : isCustomUrl
                    ? "custom"
                    : defaultNewTabUrl
            }
            onChange={(e) => handleDefaultAgentChange(e.target.value)}
            className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text focus:border-canopy-accent focus:outline-none"
          >
            <option value="none">None (show Launchpad)</option>
            {enabledLinks.map((link) => (
              <option key={link.id} value={link.url}>
                {link.title}
              </option>
            ))}
            <option value="custom">Custom URL...</option>
          </select>

          {showCustomUrlInput && (
            <div className="flex gap-2">
              <input
                id="custom-url-input"
                type="text"
                placeholder="https://..."
                value={customDefaultUrl}
                onChange={(e) => {
                  setCustomDefaultUrl(e.target.value);
                  setCustomUrlError("");
                }}
                className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text focus:border-canopy-accent focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomUrlSave();
                  if (e.key === "Escape") handleCustomUrlCancel();
                }}
                aria-invalid={!!customUrlError}
                aria-describedby={customUrlError ? "custom-url-error" : undefined}
                autoFocus
              />
              <button
                type="button"
                onClick={handleCustomUrlSave}
                aria-label="Save custom URL"
                className="px-3 py-2 rounded-[var(--radius-md)] bg-canopy-accent text-white text-sm hover:bg-canopy-accent/90 transition-colors"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleCustomUrlCancel}
                aria-label="Cancel custom URL"
                className="px-3 py-2 rounded-[var(--radius-md)] border border-canopy-border text-canopy-text/70 text-sm hover:bg-canopy-border/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {customUrlError && (
            <p id="custom-url-error" role="alert" className="text-xs text-red-500">
              {customUrlError}
            </p>
          )}

          {isCustomUrl && !showCustomUrlInput && defaultNewTabUrl && (
            <div className="text-xs text-canopy-text/50 flex items-center gap-2">
              <Globe className="w-3 h-3" />
              <span className="truncate">{defaultNewTabUrl}</span>
            </div>
          )}
        </div>
      </section>

      <section className="pt-4 border-t border-canopy-border">
        <h4 className="text-sm font-medium text-canopy-text mb-3">AI Services</h4>
        <div className="space-y-2">
          {knownServices.map(([key, template]) => {
            const link = discoveredLinks.find((l) => l.id === `discovered-${key}`);
            const isDetected = !!link;

            return (
              <div
                key={key}
                className="flex items-center justify-between p-3 rounded-[var(--radius-lg)] bg-canopy-bg border border-canopy-border"
              >
                {editingLinkId === link?.id ? (
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-canopy-bg border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text w-32 focus:border-canopy-accent focus:outline-none"
                      placeholder="Name"
                    />
                    <input
                      type="text"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      className="bg-canopy-bg border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text flex-1 focus:border-canopy-accent focus:outline-none"
                      placeholder="URL"
                    />
                    <button
                      onClick={handleSaveEdit}
                      className="p-1.5 rounded hover:bg-canopy-border text-green-500"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="p-1.5 rounded hover:bg-canopy-border text-zinc-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <ServiceIcon name={template.icon} />
                      <div className="flex flex-col">
                        <span className="text-sm text-canopy-text">
                          {link?.title || template.title}
                        </span>
                        <span
                          className="text-[11px] font-mono text-zinc-500 truncate min-w-0"
                          title={link?.url || template.url}
                        >
                          {link?.url || template.url}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "text-xs flex items-center gap-1",
                          isDetected ? "text-green-500" : "text-zinc-500"
                        )}
                      >
                        {isDetected ? (
                          <>
                            <Check className="w-3 h-3" /> CLI detected
                          </>
                        ) : (
                          <>
                            <X className="w-3 h-3" /> Not detected
                          </>
                        )}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {isDetected && (
                        <button
                          onClick={() => link && handleStartEdit(link.id, link.title, link.url)}
                          className="text-xs text-zinc-500 hover:text-canopy-text px-2 py-1 rounded hover:bg-canopy-border"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        onClick={() =>
                          link &&
                          void actionService.dispatch(
                            "sidecar.links.toggle",
                            { id: link.id },
                            { source: "user" }
                          )
                        }
                        disabled={!isDetected}
                        className={cn(
                          "w-10 h-5 rounded-full relative transition-colors",
                          !isDetected && "opacity-50 cursor-not-allowed",
                          link?.enabled ? "bg-canopy-accent" : "bg-canopy-border"
                        )}
                      >
                        <div
                          className={cn(
                            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                            link?.enabled ? "translate-x-5" : "translate-x-0.5"
                          )}
                        />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <button
          onClick={rescan}
          disabled={isScanning}
          className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs rounded-[var(--radius-md)] border border-canopy-border hover:bg-canopy-border/50 transition-colors text-canopy-text/70"
        >
          <RefreshCw className={cn("w-3 h-3", isScanning && "animate-spin")} />
          {isScanning ? "Scanning..." : "Re-scan for tools"}
        </button>
      </section>

      <section className="pt-4 border-t border-canopy-border">
        <h4 className="text-sm font-medium text-canopy-text mb-3">Custom Links</h4>
        <div className="space-y-2">
          {userLinks.map((link) => (
            <div
              key={link.id}
              className="flex items-center justify-between p-3 rounded-[var(--radius-lg)] bg-canopy-bg border border-canopy-border"
            >
              {editingLinkId === link.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="bg-canopy-bg border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text w-32 focus:border-canopy-accent focus:outline-none"
                    placeholder="Name"
                  />
                  <input
                    type="text"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="bg-canopy-bg border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text flex-1 focus:border-canopy-accent focus:outline-none"
                    placeholder="URL"
                  />
                  <button
                    onClick={handleSaveEdit}
                    className="p-1.5 rounded hover:bg-canopy-border text-green-500"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="p-1.5 rounded hover:bg-canopy-border text-zinc-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <FaviconIcon url={link.url} />
                    <span className="text-sm text-canopy-text">{link.title}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleStartEdit(link.id, link.title, link.url)}
                      className="text-xs text-zinc-500 hover:text-canopy-text px-2 py-1 rounded hover:bg-canopy-border"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() =>
                        void actionService.dispatch(
                          "sidecar.links.toggle",
                          { id: link.id },
                          { source: "user" }
                        )
                      }
                      disabled={link.alwaysEnabled}
                      className={cn(
                        "w-10 h-5 rounded-full relative transition-colors",
                        link.alwaysEnabled && "opacity-50 cursor-not-allowed",
                        link.enabled ? "bg-canopy-accent" : "bg-canopy-border"
                      )}
                    >
                      <div
                        className={cn(
                          "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                          link.enabled ? "translate-x-5" : "translate-x-0.5"
                        )}
                      />
                    </button>
                    <button
                      onClick={() =>
                        void actionService.dispatch(
                          "sidecar.links.remove",
                          { id: link.id },
                          { source: "user" }
                        )
                      }
                      disabled={link.alwaysEnabled}
                      className={cn(
                        "p-1.5 rounded hover:bg-canopy-border text-zinc-500 hover:text-red-500",
                        link.alwaysEnabled && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Name"
              value={newLinkName}
              onChange={(e) => {
                setNewLinkName(e.target.value);
                setUrlError("");
              }}
              className="bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text w-32 focus:border-canopy-accent focus:outline-none"
            />
            <input
              type="text"
              placeholder="https://..."
              value={newLinkUrl}
              onChange={(e) => {
                setNewLinkUrl(e.target.value);
                setUrlError("");
              }}
              className="bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text flex-1 focus:border-canopy-accent focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddLink();
              }}
            />
            <button
              onClick={handleAddLink}
              disabled={!newLinkName.trim() || !newLinkUrl.trim()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--radius-md)] bg-canopy-accent text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-canopy-accent/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {urlError && <p className="text-xs text-red-500 mt-1">{urlError}</p>}
        </div>
      </section>

      <section className="pt-4 border-t border-canopy-border">
        <h4 className="text-sm font-medium text-canopy-text mb-2">Layout Mode</h4>
        <p className="text-xs text-canopy-text/50 mb-4">
          Control how the sidecar panel interacts with the main content area.
        </p>

        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Layout mode">
          {LAYOUT_MODE_OPTIONS.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                void actionService.dispatch(
                  "sidecar.setLayoutMode",
                  { mode: id },
                  { source: "user" }
                )
              }
              role="radio"
              aria-checked={layoutModePreference === id}
              aria-label={`${label} - ${description}`}
              className={cn(
                "flex flex-col items-center justify-center p-3 rounded-[var(--radius-md)] border transition-all",
                layoutModePreference === id
                  ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                  : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
              )}
            >
              <Icon className="w-5 h-5 mb-1.5" />
              <span className="text-xs font-medium">{label}</span>
              <span className="text-[11px] mt-0.5 opacity-60">{description}</span>
            </button>
          ))}
        </div>

        <div className="text-xs text-canopy-text/50 space-y-1.5 bg-canopy-bg/50 rounded-[var(--radius-md)] p-3 mt-3">
          <div className="font-medium text-canopy-text/70 mb-2">Mode behavior:</div>
          <div className="flex justify-between">
            <span>Auto</span>
            <span className="text-canopy-text/70">
              Switches to overlay when grid width &lt; {MIN_GRID_WIDTH}px
            </span>
          </div>
          <div className="flex justify-between">
            <span>Push</span>
            <span className="text-canopy-text/70">Always pushes content aside</span>
          </div>
          <div className="flex justify-between">
            <span>Overlay</span>
            <span className="text-canopy-text/70">Always overlays on top of content</span>
          </div>
        </div>

        {layoutModePreference === "push" && (
          <p className="text-xs text-amber-500/80 flex items-center gap-1.5 mt-3">
            <AlertTriangle className="w-3 h-3" />
            Forcing push mode on small windows may make the terminal grid unusable.
          </p>
        )}
      </section>

      <section className="pt-4 border-t border-canopy-border">
        <h4 className="text-sm font-medium text-canopy-text mb-2">Default Width</h4>
        <p className="text-xs text-canopy-text/50 mb-4">
          Set the default width of the sidecar panel. You can still resize it manually.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={SIDECAR_MIN_WIDTH}
              max={SIDECAR_MAX_WIDTH}
              value={localWidth}
              onChange={(e) => setLocalWidth(clampWidth(Number(e.currentTarget.value)))}
              onPointerDown={() => {
                isAdjustingWidthRef.current = true;
              }}
              onPointerUp={(e) => {
                isAdjustingWidthRef.current = false;
                void actionService.dispatch(
                  "sidecar.width.set",
                  { width: clampWidth(Number(e.currentTarget.value)) },
                  { source: "user" }
                );
              }}
              onBlur={(e) => {
                isAdjustingWidthRef.current = false;
                void actionService.dispatch(
                  "sidecar.width.set",
                  { width: clampWidth(Number(e.currentTarget.value)) },
                  { source: "user" }
                );
              }}
              className="flex-1 h-2 bg-canopy-border rounded-lg appearance-none cursor-pointer accent-canopy-accent"
              aria-label="Default sidecar width"
            />
            <span className="text-sm font-mono text-canopy-text/70 w-16 text-right">
              {localWidth}px
            </span>
          </div>

          <div className="h-4 bg-canopy-bg rounded-[var(--radius-sm)] border border-canopy-border overflow-hidden">
            <div
              className="h-full bg-canopy-accent/30 transition-all"
              style={{
                width: `${Math.max(0, Math.min(100, ((localWidth - SIDECAR_MIN_WIDTH) / (SIDECAR_MAX_WIDTH - SIDECAR_MIN_WIDTH)) * 100))}%`,
              }}
            />
          </div>

          <div className="flex justify-between text-[11px] text-canopy-text/40">
            <span>{SIDECAR_MIN_WIDTH}px (min)</span>
            <button
              onClick={() => {
                setLocalWidth(SIDECAR_DEFAULT_WIDTH);
                void actionService.dispatch("sidecar.resetWidth", undefined, { source: "user" });
              }}
              className="hover:text-canopy-text/70 transition-colors"
            >
              Reset to {SIDECAR_DEFAULT_WIDTH}px
            </button>
            <span>{SIDECAR_MAX_WIDTH}px (max)</span>
          </div>
        </div>
      </section>

      <section className="pt-4 border-t border-canopy-border">
        <p className="text-xs text-canopy-text/50">
          Enabled links appear as tabs in the Sidecar browser panel. AI service links are
          auto-detected based on installed CLI tools.
        </p>
      </section>
    </div>
  );
}
