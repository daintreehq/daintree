import { useId, useState } from "react";
import { Plus, Trash2, Globe, Check, X, Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
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
        <div key={link.id} className="flex items-center gap-2 px-4 py-3">
          <Input
            type="text"
            density="compact"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="w-40"
            placeholder="e.g. My portal"
            aria-label="Edit link name"
          />
          <Input
            type="text"
            density="compact"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            className="flex-1 min-w-0 font-mono"
            placeholder="e.g. https://github.com/owner/repo"
            aria-label="Edit link URL"
          />
          <button
            type="button"
            onClick={handleSaveEdit}
            aria-label="Save edit"
            className="p-1.5 rounded-[var(--radius-sm)] hover:bg-overlay-soft text-status-success"
          >
            <Check className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleCancelEdit}
            aria-label="Cancel edit"
            className="p-1.5 rounded-[var(--radius-sm)] hover:bg-overlay-soft text-text-secondary hover:text-text-primary"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      );
    }

    return (
      <SettingsRow
        key={link.id}
        label={
          <span className="flex items-center gap-2">
            {allowDelete ? <FaviconIcon url={link.url} /> : <ServiceIcon name={link.icon} />}
            {link.title}
          </span>
        }
        labelText={link.title}
        description={
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block font-mono truncate">{link.url}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{link.url}</TooltipContent>
          </Tooltip>
        }
        control={({ labelId }) => (
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => handleStartEdit(link.id, link.title, link.url)}
              aria-describedby={labelId}
            >
              Edit
            </Button>
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
                type="button"
                onClick={() => setPendingRemoveId(link.id)}
                disabled={link.alwaysEnabled}
                aria-label={`Remove ${link.title || "link"}`}
                className="p-1.5 rounded-[var(--radius-sm)] hover:bg-overlay-soft text-text-secondary hover:text-status-error disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      />
    );
  };

  const pendingRemoveLink = links.find((l) => l.id === pendingRemoveId) ?? null;

  const defaultAgentValue = showCustomUrlInput
    ? "custom"
    : defaultNewTabUrl === null
      ? "none"
      : isCustomUrl
        ? "custom"
        : defaultNewTabUrl;

  const defaultAgentOptions = [
    { value: "none", label: "None (show Launchpad)" },
    ...enabledLinks.map((link) => ({ value: link.url, label: link.title })),
    { value: "custom", label: "Custom URL…" },
  ];

  return (
    <div className="space-y-8">
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

      <SettingsSection title="New tab">
        <SettingsGroup>
          <SettingsSelect
            id="portal-default-agent"
            label="Default agent"
            description={
              isCustomUrl && !showCustomUrlInput && defaultNewTabUrl ? (
                <span className="block font-mono truncate">{defaultNewTabUrl}</span>
              ) : (
                "Opens when you click the + button. None shows the Launchpad."
              )
            }
            controlWidth="wide"
            value={defaultAgentValue}
            onValueChange={(v) => handleDefaultAgentChange(v)}
            options={defaultAgentOptions}
          />

          {showCustomUrlInput && (
            <SettingsRow
              layout="stacked"
              label="Custom URL"
              error={
                customUrlError ? <span id={customUrlErrorId}>{customUrlError}</span> : undefined
              }
              control={({ labelId }) => (
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder="https://..."
                    value={customDefaultUrl}
                    onChange={(e) => {
                      setCustomDefaultUrl(e.target.value);
                      setCustomUrlError("");
                    }}
                    className="flex-1 min-w-0 font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCustomUrlSave();
                      if (e.key === "Escape") handleCustomUrlCancel();
                    }}
                    aria-labelledby={labelId}
                    invalid={!!customUrlError}
                    aria-invalid={!!customUrlError || undefined}
                    aria-describedby={customUrlError ? customUrlErrorId : undefined}
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="contrast"
                    size="icon"
                    onClick={handleCustomUrlSave}
                    aria-label="Save custom URL"
                  >
                    <Check aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleCustomUrlCancel}
                    aria-label="Cancel custom URL"
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              )}
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="portal-default-links"
        title="Default links"
        description="Built-in agent and service links. Turn one off to hide it from the portal tab bar."
      >
        <SettingsGroup>{systemLinks.map((link) => renderLinkRow(link, false))}</SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="portal-custom-links"
        title="Custom links"
        description="Add your own links to AI services or documentation."
      >
        <SettingsGroup>
          {userLinks.map((link) => renderLinkRow(link, true))}
          <SettingsRow
            layout="stacked"
            label="Add a link"
            error={urlError ? <span id={addLinkErrorId}>{urlError}</span> : undefined}
            control={
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="e.g. My portal"
                  value={newLinkName}
                  onChange={(e) => {
                    setNewLinkName(e.target.value);
                    setUrlError("");
                  }}
                  className="w-40"
                  aria-label="New link name"
                />
                <Input
                  type="text"
                  placeholder="e.g. https://github.com/owner/repo"
                  value={newLinkUrl}
                  onChange={(e) => {
                    setNewLinkUrl(e.target.value);
                    setUrlError("");
                  }}
                  className="flex-1 min-w-0 font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddLink();
                  }}
                  aria-label="New link URL"
                  invalid={!!urlError}
                  aria-invalid={!!urlError || undefined}
                  aria-describedby={urlError ? addLinkErrorId : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddLink}
                  disabled={!newLinkName.trim() || !newLinkUrl.trim()}
                >
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              </div>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
