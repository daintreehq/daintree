import { useEffect, useId, useRef, useState } from "react";
import { Globe, Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { useGlobalLinksStore } from "@/store/globalLinksStore";
import { withGlobalLinks } from "@/lib/portalLinks";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_SYSTEM_LINKS, type PortalLink } from "@shared/types";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { linkUrlProblem, validateLink, type LinkError } from "./linkValidation";

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

export function PortalSettingsTab() {
  const systemLinks = usePortalStore((s) => s.links);
  const userLinks = useGlobalLinksStore((s) => s.links);
  const defaultNewTabUrl = usePortalStore((s) => s.defaultNewTabUrl);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editError, setEditError] = useState<LinkError | null>(null);
  // One write at a time. While it runs the form it came from is read-only, so
  // its completion can never clear or close something typed after submitting.
  const [pending, setPendingState] = useState<"edit" | "custom" | null>(null);
  // State drives the read-only rendering; the ref is the guard, because two
  // submits in one batch would both read the stale state.
  const pendingRef = useRef<typeof pending>(null);
  const setPending = (next: typeof pending) => {
    pendingRef.current = next;
    setPendingState(next);
  };
  const [focusNewTabSelect, setFocusNewTabSelect] = useState(false);
  const editNameRef = useRef<HTMLInputElement>(null);
  const editUrlRef = useRef<HTMLInputElement>(null);
  // The link whose Edit button gets focus back once its editor closes — the
  // editor replaced that button, so without this focus falls to the page.
  const [returnFocusTo, setReturnFocusTo] = useState<string | null>(null);
  const [showCustomUrlInput, setShowCustomUrlInput] = useState(false);
  const [customDefaultUrl, setCustomDefaultUrl] = useState("");
  const [customUrlError, setCustomUrlError] = useState<LinkError | null>(null);
  // Every submission that fails bumps this, and it keys the rendered message:
  // a fresh `role="alert"` node is announced even when the text repeats.
  const [errorSeq, setErrorSeq] = useState(0);
  const customUrlRef = useRef<HTMLInputElement>(null);
  const customUrlErrorId = useId();
  const editErrorId = useId();

  useEffect(() => {
    if (returnFocusTo === null) return;
    document
      .querySelector<HTMLButtonElement>(`[data-portal-edit="${CSS.escape(returnFocusTo)}"]`)
      ?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo]);

  // Closing the custom-URL editor hands focus to what opened it: its own Edit
  // button while a custom URL is in effect, otherwise the select.
  useEffect(() => {
    if (!focusNewTabSelect) return;
    (
      document.querySelector<HTMLElement>("[data-portal-edit-custom-url]") ??
      document.querySelector<HTMLElement>('#portal-default-agent [role="combobox"]')
    )?.focus();
    setFocusNewTabSelect(false);
  }, [focusNewTabSelect]);

  // Report validation state to sidebar
  const hasError = Boolean(customUrlError || editError);
  useSettingsTabValidation("portal", hasError);

  const handleStartEdit = (id: string, title: string, url: string) => {
    if (pendingRef.current) return;
    setEditingLinkId(id);
    setEditName(title);
    setEditUrl(url);
    setEditError(null);
  };

  const closeEditor = () => {
    if (pendingRef.current) return;
    setReturnFocusTo(editingLinkId);
    setEditingLinkId(null);
    setEditName("");
    setEditUrl("");
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingLinkId || pendingRef.current) return;
    const problem = validateLink(editName, editUrl);
    if (problem) {
      setEditError(problem);
      setErrorSeq((n) => n + 1);
      (problem.field === "name" ? editNameRef : editUrlRef).current?.focus();
      return;
    }

    setPending("edit");
    const result = await actionService.dispatch(
      "portal.links.update",
      { id: editingLinkId, updates: { title: editName, url: editUrl } },
      { source: "user" }
    );
    setPending(null);
    if (!result.ok) {
      setEditError({ field: "form", message: "Couldn't save the link. Try again." });
      setErrorSeq((n) => n + 1);
      return;
    }
    closeEditor();
  };

  const enabledLinks = withGlobalLinks(systemLinks, userLinks)
    .filter((l) => l.enabled)
    .sort((a, b) => a.order - b.order);

  const isCustomUrl =
    defaultNewTabUrl !== null && !enabledLinks.some((l) => l.url === defaultNewTabUrl);

  const handleDefaultAgentChange = (value: string) => {
    if (pendingRef.current) return;
    if (value === "none") {
      void actionService.dispatch("portal.setDefaultNewTab", { url: null }, { source: "user" });
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError(null);
    } else if (value === "custom") {
      setShowCustomUrlInput(true);
      if (isCustomUrl && defaultNewTabUrl) {
        setCustomDefaultUrl(defaultNewTabUrl);
      }
    } else {
      void actionService.dispatch("portal.setDefaultNewTab", { url: value }, { source: "user" });
      setShowCustomUrlInput(false);
      setCustomDefaultUrl("");
      setCustomUrlError(null);
    }
  };

  const customUrlUnchanged =
    customDefaultUrl.trim() === "" || customDefaultUrl === defaultNewTabUrl;

  const handleCustomUrlSave = async () => {
    if (pendingRef.current || customDefaultUrl === defaultNewTabUrl) return;
    if (!customDefaultUrl.trim()) {
      setCustomUrlError({ field: "url", message: "Enter a URL" });
      setErrorSeq((n) => n + 1);
      customUrlRef.current?.focus();
      return;
    }
    const problem = linkUrlProblem(customDefaultUrl);
    if (problem) {
      setCustomUrlError({ field: "url", message: problem });
      setErrorSeq((n) => n + 1);
      customUrlRef.current?.focus();
      return;
    }
    setPending("custom");
    const result = await actionService.dispatch(
      "portal.setDefaultNewTab",
      { url: customDefaultUrl },
      { source: "user" }
    );
    setPending(null);
    if (!result.ok) {
      setCustomUrlError({ field: "form", message: "Couldn't save the URL. Try again." });
      setErrorSeq((n) => n + 1);
      return;
    }
    setShowCustomUrlInput(false);
    setCustomDefaultUrl("");
    setCustomUrlError(null);
    setFocusNewTabSelect(true);
  };

  const handleEditCustomUrl = () => {
    if (pendingRef.current || !defaultNewTabUrl) return;
    setCustomDefaultUrl(defaultNewTabUrl);
    setCustomUrlError(null);
    setShowCustomUrlInput(true);
  };

  const handleCustomUrlCancel = () => {
    if (pendingRef.current) return;
    setShowCustomUrlInput(false);
    setCustomDefaultUrl("");
    setCustomUrlError(null);
    setFocusNewTabSelect(true);
  };

  const renderLinkRow = (link: PortalLink) => {
    if (editingLinkId === link.id) {
      return (
        <div key={link.id} className="divide-y divide-border-subtle">
          <SettingsRow
            layout="stacked"
            label={`Edit ${link.title || "link"}`}
            error={
              editError ? (
                <span key={errorSeq} id={editErrorId} role="alert">
                  {editError.message}
                </span>
              ) : undefined
            }
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  ref={editNameRef}
                  value={editName}
                  readOnly={pending === "edit"}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setEditError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveEdit();
                    if (e.key === "Escape") closeEditor();
                  }}
                  className="w-40"
                  placeholder="Name"
                  aria-label="Link name"
                  invalid={editError?.field === "name"}
                  aria-invalid={editError?.field === "name" || undefined}
                  aria-describedby={editError ? editErrorId : undefined}
                  autoFocus
                />
                <Input
                  type="text"
                  ref={editUrlRef}
                  value={editUrl}
                  readOnly={pending === "edit"}
                  onChange={(e) => {
                    setEditUrl(e.target.value);
                    setEditError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveEdit();
                    if (e.key === "Escape") closeEditor();
                  }}
                  className="flex-1 min-w-0 font-mono"
                  placeholder="https://…"
                  aria-label="Link URL"
                  invalid={editError?.field === "url"}
                  aria-invalid={editError?.field === "url" || undefined}
                  aria-describedby={editError ? editErrorId : undefined}
                />
              </div>
            }
          />
          <SettingsActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeEditor}
              disabled={pending === "edit"}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="contrast"
              size="sm"
              onClick={() => void handleSaveEdit()}
              disabled={pending !== null || (editName === link.title && editUrl === link.url)}
            >
              Save
            </Button>
          </SettingsActions>
        </div>
      );
    }

    // A built-in link the user renamed, re-pointed or turned off is a departure
    // from what shipped, and gets the same bar and reset as any other setting.
    const shipped = DEFAULT_SYSTEM_LINKS.find((d) => d.id === link.id);
    const isModified =
      !!shipped &&
      (shipped.title !== link.title ||
        shipped.url !== link.url ||
        shipped.enabled !== link.enabled);

    return (
      <SettingsRow
        key={link.id}
        isModified={isModified}
        onReset={
          shipped
            ? () =>
                void actionService.dispatch(
                  "portal.links.update",
                  {
                    id: link.id,
                    updates: { title: shipped.title, url: shipped.url, enabled: shipped.enabled },
                  },
                  { source: "user" }
                )
            : undefined
        }
        resetAriaLabel={`Reset ${shipped?.title ?? link.title} to its default`}
        label={
          <span className="flex items-center gap-2">
            <span className="flex shrink-0">
              <ServiceIcon name={link.icon} />
            </span>
            {link.title}
          </span>
        }
        labelText={link.title}
        description={
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Indented past the icon, so the URL reads under the title it belongs to. */}
              <span className="block pl-6 font-mono truncate">{link.url}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{link.url}</TooltipContent>
          </Tooltip>
        }
        control={({ labelId, descriptionId }) => (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleStartEdit(link.id, link.title, link.url)}
              disabled={pending !== null}
              aria-describedby={labelId}
              data-portal-edit={link.id}
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
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            />
          </>
        )}
      />
    );
  };

  const defaultAgentValue = showCustomUrlInput
    ? "custom"
    : defaultNewTabUrl === null
      ? "none"
      : isCustomUrl
        ? "custom"
        : defaultNewTabUrl;

  const defaultAgentOptions = [
    { value: "none", label: "Launchpad", isDefault: true },
    ...enabledLinks.map((link) => ({ value: link.url, label: link.title })),
    { value: "custom", label: "Custom URL…" },
  ];

  return (
    <div className="space-y-8">
      <SettingsSection title="New tab">
        <SettingsGroup>
          <SettingsSelect
            id="portal-default-agent"
            label="New tabs open"
            description="What the + button in the Portal panel opens"
            isModified={defaultNewTabUrl !== null && !showCustomUrlInput}
            onReset={() => handleDefaultAgentChange("none")}
            resetAriaLabel="Reset new tabs to the Launchpad"
            controlWidth="wide"
            value={defaultAgentValue}
            onValueChange={(v) => handleDefaultAgentChange(v)}
            options={defaultAgentOptions}
          />

          {/* A saved custom URL keeps its own Edit: re-choosing "Custom URL…" in
              the select is not a change, so it can't reopen the editor. */}
          {isCustomUrl && !showCustomUrlInput && defaultNewTabUrl && (
            <SettingsRow
              label="Custom URL"
              description={<span className="block font-mono truncate">{defaultNewTabUrl}</span>}
              control={({ labelId }) => (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleEditCustomUrl}
                  disabled={pending !== null}
                  aria-describedby={labelId}
                  data-portal-edit-custom-url=""
                >
                  Edit
                </Button>
              )}
            />
          )}

          {showCustomUrlInput && (
            <>
              <SettingsRow
                layout="stacked"
                label="Custom URL"
                error={
                  customUrlError ? (
                    <span key={errorSeq} id={customUrlErrorId} role="alert">
                      {customUrlError.message}
                    </span>
                  ) : undefined
                }
                control={({ labelId }) => (
                  <Input
                    type="text"
                    placeholder="https://…"
                    ref={customUrlRef}
                    value={customDefaultUrl}
                    readOnly={pending === "custom"}
                    onChange={(e) => {
                      setCustomDefaultUrl(e.target.value);
                      setCustomUrlError(null);
                    }}
                    className="min-w-0 font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCustomUrlSave();
                      if (e.key === "Escape") handleCustomUrlCancel();
                    }}
                    aria-labelledby={labelId}
                    invalid={customUrlError?.field === "url"}
                    aria-invalid={customUrlError?.field === "url" || undefined}
                    aria-describedby={customUrlError ? customUrlErrorId : undefined}
                    autoFocus
                  />
                )}
              />
              <SettingsActions>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCustomUrlCancel}
                  disabled={pending === "custom"}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="contrast"
                  size="sm"
                  onClick={() => void handleCustomUrlSave()}
                  disabled={pending !== null || customUrlUnchanged}
                >
                  Save
                </Button>
              </SettingsActions>
            </>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="portal-default-links"
        title="Default links"
        description="Built-in agent and service links. Turn one off to hide it from the portal tab bar."
      >
        <SettingsGroup>{systemLinks.map((link) => renderLinkRow(link))}</SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Your links"
        description="Add, edit and reorder the links you keep for every project on the Links page"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "links", sectionId: "global-links" },
                { source: "user" }
              )
            }
          >
            Open Links settings
          </Button>
        }
      >
        {null}
      </SettingsSection>
    </div>
  );
}
