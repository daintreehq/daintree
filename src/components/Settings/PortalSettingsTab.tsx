import { useId, useState } from "react";
import { Plus, Trash2, Globe, Check, X, Search, PanelRight, Link } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";

function ServiceIcon({ name, size = 16 }: { name: string; size?: number }) {
  const className = size === 16 ? "w-4 h-4" : size === 32 ? "w-8 h-8" : "w-4 h-4";

  if (name === "globe") {
    return <Globe className={className} />;
  }
  if (name === "search") {
    return <Search className={className} />;
  }

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

export function PortalSettingsTab() {
  const links = usePortalStore((s) => s.links);
  const defaultNewTabUrl = usePortalStore((s) => s.defaultNewTabUrl);
  const [newLinkName, setNewLinkName] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [showCustomUrlInput, setShowCustomUrlInput] = useState(false);
  const [customDefaultUrl, setCustomDefaultUrl] = useState("");
  const [customUrlError, setCustomUrlError] = useState("");
  const customUrlErrorId = useId();
  const addLinkErrorId = useId();

  const systemLinks = links.filter((l) => l.type === "system");
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
      "portal.links.add",
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
      "portal.links.update",
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

  const enabledLinks = links.filter((l) => l.enabled).sort((a, b) => a.order - b.order);

  const isCustomUrl =
    defaultNewTabUrl !== null && !enabledLinks.some((l) => l.url === defaultNewTabUrl);

  const handleDefaultAgentChange = (value: string) => {
    if (value === "none") {
      void actionService.dispatch("portal.setDefaultNewTab", { url: null }, { source: "user" });
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError("");
    } else if (value === "custom") {
      setShowCustomUrlInput(true);
      if (isCustomUrl && defaultNewTabUrl) {
        setCustomDefaultUrl(defaultNewTabUrl);
      }
    } else {
      void actionService.dispatch("portal.setDefaultNewTab", { url: value }, { source: "user" });
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
        "portal.setDefaultNewTab",
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

  const renderLinkRow = (link: (typeof links)[0], allowDelete: boolean) => {
    if (editingLinkId === link.id) {
      return (
        <div
          key={link.id}
          className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
        >
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="bg-canopy-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-sm text-canopy-text w-32 focus:border-canopy-accent focus:outline-none"
            placeholder="Name"
          />
          <input
            type="text"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            className="bg-canopy-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-sm text-canopy-text flex-1 focus:border-canopy-accent focus:outline-none"
            placeholder="URL"
          />
          <button
            onClick={handleSaveEdit}
            className="p-1.5 rounded hover:bg-canopy-border/50 text-status-success"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            onClick={handleCancelEdit}
            className="p-1.5 rounded hover:bg-canopy-border/50 text-canopy-text/50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      );
    }

    return (
      <div
        key={link.id}
        className="flex items-center justify-between p-3 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
      >
        <div className="flex items-center gap-3">
          {allowDelete ? <FaviconIcon url={link.url} /> : <ServiceIcon name={link.icon} />}
          <div className="flex flex-col">
            <span className="text-sm text-canopy-text">{link.title}</span>
            {!allowDelete && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[11px] font-mono text-canopy-text/50 truncate min-w-0">
                      {link.url}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{link.url}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleStartEdit(link.id, link.title, link.url)}
            className="text-xs text-canopy-text/50 hover:text-canopy-text px-2 py-1 rounded hover:bg-canopy-border/50"
          >
            Edit
          </button>
          <button
            onClick={() =>
              void actionService.dispatch(
                "portal.links.toggle",
                { id: link.id },
                { source: "user" }
              )
            }
            disabled={link.alwaysEnabled}
            className={cn(
              "w-10 h-5 rounded-full relative transition-colors shrink-0",
              link.alwaysEnabled && "opacity-50 cursor-not-allowed",
              link.enabled ? "bg-canopy-accent" : "bg-canopy-border"
            )}
          >
            <div
              className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full transition-transform",
                link.enabled ? "translate-x-5 bg-text-inverse" : "translate-x-0.5 bg-canopy-text"
              )}
            />
          </button>
          {allowDelete && (
            <button
              onClick={() =>
                void actionService.dispatch(
                  "portal.links.remove",
                  { id: link.id },
                  { source: "user" }
                )
              }
              disabled={link.alwaysEnabled}
              className={cn(
                "p-1.5 rounded hover:bg-canopy-border/50 text-canopy-text/50 hover:text-status-error",
                link.alwaysEnabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={PanelRight}
        title="Default New Tab Agent"
        description='Choose which agent opens when you click the + button. Select "None" to show the Launchpad.'
      >
        <div className="flex flex-col gap-3">
          <SettingsSelect
            label="Default Agent"
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
          >
            <option value="none">None (show Launchpad)</option>
            {enabledLinks.map((link) => (
              <option key={link.id} value={link.url}>
                {link.title}
              </option>
            ))}
            <option value="custom">Custom URL...</option>
          </SettingsSelect>

          {showCustomUrlInput && (
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="https://..."
                value={customDefaultUrl}
                onChange={(e) => {
                  setCustomDefaultUrl(e.target.value);
                  setCustomUrlError("");
                }}
                className="flex-1 bg-canopy-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomUrlSave();
                  if (e.key === "Escape") handleCustomUrlCancel();
                }}
                aria-invalid={!!customUrlError || undefined}
                aria-describedby={customUrlError ? customUrlErrorId : undefined}
                autoFocus
              />
              <button
                type="button"
                onClick={handleCustomUrlSave}
                aria-label="Save custom URL"
                className="px-3 py-1.5 rounded-[var(--radius-md)] bg-canopy-accent text-canopy-bg text-sm hover:bg-canopy-accent/90 transition-colors"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleCustomUrlCancel}
                aria-label="Cancel custom URL"
                className="px-3 py-1.5 rounded-[var(--radius-md)] border border-canopy-border text-canopy-text/70 text-sm hover:bg-canopy-border/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {customUrlError && (
            <p id={customUrlErrorId} role="alert" className="text-xs text-status-error">
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
      </SettingsSection>

      <SettingsSection
        icon={Link}
        title="Default Links"
        description="Built-in agent and service links. Toggle visibility in the portal tab bar."
      >
        <div className="space-y-2">{systemLinks.map((link) => renderLinkRow(link, false))}</div>
      </SettingsSection>

      <SettingsSection
        icon={Globe}
        title="Custom Links"
        description="Add your own links to AI services or documentation."
      >
        <div className="space-y-2">{userLinks.map((link) => renderLinkRow(link, true))}</div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Name"
              value={newLinkName}
              onChange={(e) => {
                setNewLinkName(e.target.value);
                setUrlError("");
              }}
              className="bg-canopy-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text w-32 focus:border-canopy-accent focus:outline-none transition-colors"
            />
            <input
              type="text"
              placeholder="https://..."
              value={newLinkUrl}
              onChange={(e) => {
                setNewLinkUrl(e.target.value);
                setUrlError("");
              }}
              className="bg-canopy-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text flex-1 focus:border-canopy-accent focus:outline-none transition-colors"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddLink();
              }}
              aria-invalid={!!urlError || undefined}
              aria-describedby={urlError ? addLinkErrorId : undefined}
            />
            <button
              onClick={handleAddLink}
              disabled={!newLinkName.trim() || !newLinkUrl.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] bg-canopy-accent text-canopy-bg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-canopy-accent/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {urlError && (
            <p id={addLinkErrorId} role="alert" className="text-xs text-status-error">
              {urlError}
            </p>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
