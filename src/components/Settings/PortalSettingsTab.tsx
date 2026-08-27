import { useId, useState } from "react";
import { Plus, Trash2, Globe, Check, X, Search, PanelRight, Link } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";

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
      return (
        <BrandMark brandColor={config.color} className={className}>
          <Icon className={className} />
        </BrandMark>
      );
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
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const customUrlErrorId = useId();
  const addLinkErrorId = useId();

  // Report validation state to sidebar
  const hasError = Boolean(urlError || customUrlError);
  useSettingsTabValidation("portal", hasError);

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
          className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] border border-border-default bg-daintree-bg/30"
        >
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-sm text-text-primary w-32 focus:border-daintree-accent/40 focus:outline-hidden"
            placeholder="e.g. My portal"
            aria-label="Edit link name"
          />
          <input
            type="text"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-sm text-text-primary flex-1 focus:border-daintree-accent/40 focus:outline-hidden"
            placeholder="e.g. https://github.com/owner/repo"
            aria-label="Edit link URL"
          />
          <button
            onClick={handleSaveEdit}
            aria-label="Save edit"
            className="p-1.5 rounded hover:bg-daintree-border/50 text-status-success"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            onClick={handleCancelEdit}
            aria-label="Cancel edit"
            className="p-1.5 rounded hover:bg-daintree-border/50 text-daintree-text/50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      );
    }

    return (
      <div
        key={link.id}
        className="flex items-center justify-between p-3 rounded-[var(--radius-md)] border border-border-default bg-daintree-bg/30"
      >
        <div className="flex items-center gap-3">
          {allowDelete ? <FaviconIcon url={link.url} /> : <ServiceIcon name={link.icon} />}
          <div className="flex flex-col">
            <span className="text-sm text-text-primary">{link.title}</span>
            {!allowDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-2xs font-mono text-daintree-text/50 truncate min-w-0">
                    {link.url}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{link.url}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleStartEdit(link.id, link.title, link.url)}
            className="text-xs text-daintree-text/50 hover:text-text-primary px-2 py-1 rounded hover:bg-daintree-border/50"
          >
            Edit
          </button>
          <SettingsSwitch
            checked={link.enabled}
            onCheckedChange={() =>
              void actionService.dispatch(
                "portal.links.toggle",
                { id: link.id },
                { source: "user" }
              )
            }
            disabled={link.alwaysEnabled}
            aria-label={`Toggle ${link.title || "portal link"}`}
          />
          {allowDelete && (
            <button
              onClick={() => setPendingRemoveId(link.id)}
              disabled={link.alwaysEnabled}
              className="p-1.5 rounded hover:bg-daintree-border/50 text-daintree-text/50 hover:text-status-error disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  };

  const pendingRemoveLink = links.find((l) => l.id === pendingRemoveId) ?? null;

  return (
    <div className="space-y-6">
      <ConfirmDialog
        isOpen={pendingRemoveId !== null}
        variant="destructive"
        title={`Remove '${pendingRemoveLink?.title || "this link"}'?`}
        description="This removes the link from your portal tab bar. You can add it back later."
        confirmLabel="Remove link"
        onConfirm={() => {
          if (pendingRemoveId !== null) {
            void actionService.dispatch(
              "portal.links.remove",
              { id: pendingRemoveId },
              { source: "user" }
            );
          }
          setPendingRemoveId(null);
        }}
        onClose={() => setPendingRemoveId(null)}
      />

      <SettingsSection
        icon={PanelRight}
        title="Default new tab agent"
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
            onValueChange={(v) => handleDefaultAgentChange(v)}
            options={[
              { value: "none", label: "None (show Launchpad)" },
              ...enabledLinks.map((link) => ({ value: link.url, label: link.title })),
              { value: "custom", label: "Custom URL..." },
            ]}
          />

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
                className="flex-1 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary focus:border-daintree-accent/40 focus:outline-hidden transition-colors"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomUrlSave();
                  if (e.key === "Escape") handleCustomUrlCancel();
                }}
                aria-label="Custom URL"
                aria-invalid={!!customUrlError || undefined}
                aria-describedby={customUrlError ? customUrlErrorId : undefined}
                autoFocus
              />
              <button
                type="button"
                onClick={handleCustomUrlSave}
                aria-label="Save custom URL"
                className="px-3 py-1.5 rounded-[var(--radius-md)] bg-accent-primary text-accent-primary-foreground text-sm hover:bg-daintree-accent/90 transition-colors"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleCustomUrlCancel}
                aria-label="Cancel custom URL"
                className="px-3 py-1.5 rounded-[var(--radius-md)] border border-border-default text-daintree-text/70 text-sm hover:bg-daintree-border/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {customUrlError && (
            <p id={customUrlErrorId} className="text-xs text-status-error">
              {customUrlError}
            </p>
          )}

          {isCustomUrl && !showCustomUrlInput && defaultNewTabUrl && (
            <div className="text-xs text-daintree-text/50 flex items-center gap-2">
              <Globe className="w-3 h-3" />
              <span className="truncate">{defaultNewTabUrl}</span>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Link}
        title="Default links"
        description="Built-in agent and service links. Toggle visibility in the portal tab bar."
      >
        <div className="space-y-2">{systemLinks.map((link) => renderLinkRow(link, false))}</div>
      </SettingsSection>

      <SettingsSection
        icon={Globe}
        title="Custom links"
        description="Add your own links to AI services or documentation."
      >
        <div className="space-y-2">{userLinks.map((link) => renderLinkRow(link, true))}</div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. My portal"
              value={newLinkName}
              onChange={(e) => {
                setNewLinkName(e.target.value);
                setUrlError("");
              }}
              className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary w-32 focus:border-daintree-accent/40 focus:outline-hidden transition-colors"
              aria-label="New link name"
            />
            <input
              type="text"
              placeholder="e.g. https://github.com/owner/repo"
              value={newLinkUrl}
              onChange={(e) => {
                setNewLinkUrl(e.target.value);
                setUrlError("");
              }}
              className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary flex-1 focus:border-daintree-accent/40 focus:outline-hidden transition-colors"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddLink();
              }}
              aria-label="New link URL"
              aria-invalid={!!urlError || undefined}
              aria-describedby={urlError ? addLinkErrorId : undefined}
            />
            <button
              onClick={handleAddLink}
              disabled={!newLinkName.trim() || !newLinkUrl.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] bg-accent-primary text-accent-primary-foreground text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none hover:bg-daintree-accent/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {urlError && (
            <p id={addLinkErrorId} className="text-xs text-status-error">
              {urlError}
            </p>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
