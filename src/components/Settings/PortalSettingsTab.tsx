import { useEffect, useId, useRef, useState } from "react";
import { Plus, Globe, Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_SYSTEM_LINKS } from "@shared/types";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
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

function validateUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "URL must use http:// or https://";
    return null;
  } catch {
    return "Enter a full URL, starting with https://";
  }
}

/** A problem pinned to the field that has to change, or to the form when neither does. */
interface LinkError {
  field: "name" | "url" | "form";
  message: string;
}

function validateLink(name: string, url: string): LinkError | null {
  if (!name.trim()) return { field: "name", message: "Enter a name for the link" };
  if (!url.trim()) return { field: "url", message: "Enter the link's URL" };
  const problem = validateUrl(url);
  return problem ? { field: "url", message: problem } : null;
}

export function PortalSettingsTab() {
  const links = usePortalStore((s) => s.links);
  const defaultNewTabUrl = usePortalStore((s) => s.defaultNewTabUrl);
  const [newLinkName, setNewLinkName] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [addError, setAddError] = useState<LinkError | null>(null);
  const [editError, setEditError] = useState<LinkError | null>(null);
  // One write at a time. While it runs the form it came from is read-only, so
  // its completion can never clear or close something typed after submitting.
  const [pending, setPendingState] = useState<"add" | "edit" | "custom" | null>(null);
  // State drives the read-only rendering; the ref is the guard, because two
  // submits in one batch would both read the stale state.
  const pendingRef = useRef<typeof pending>(null);
  const setPending = (next: typeof pending) => {
    pendingRef.current = next;
    setPendingState(next);
  };
  const [focusNewTabSelect, setFocusNewTabSelect] = useState(false);
  const addNameRef = useRef<HTMLInputElement>(null);
  const addUrlRef = useRef<HTMLInputElement>(null);
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
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const customUrlErrorId = useId();
  const addLinkErrorId = useId();
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
  const hasError = Boolean(addError || customUrlError || editError);
  useSettingsTabValidation("portal", hasError);

  const systemLinks = links.filter((l) => l.type === "system");
  const userLinks = links.filter((l) => l.type === "user");

  const handleAddLink = async () => {
    if (pendingRef.current) return;
    const problem = validateLink(newLinkName, newLinkUrl);
    if (problem) {
      setAddError(problem);
      setErrorSeq((n) => n + 1);
      (problem.field === "name" ? addNameRef : addUrlRef).current?.focus();
      return;
    }

    // The draft clears only once the link exists, so a failed add keeps what
    // was typed for the retry.
    setPending("add");
    const result = await actionService.dispatch(
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
    setPending(null);
    if (!result.ok) {
      setAddError({ field: "form", message: "Couldn't add the link. Try again." });
      setErrorSeq((n) => n + 1);
      return;
    }

    setNewLinkName("");
    setNewLinkUrl("");
    setAddError(null);
  };

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

  const enabledLinks = links.filter((l) => l.enabled).sort((a, b) => a.order - b.order);

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
    const problem = validateUrl(customDefaultUrl);
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

  const renderLinkRow = (link: (typeof links)[0], allowDelete: boolean) => {
    if (editingLinkId === link.id) {
      // Remove lives in the editor rather than on every row: at rest each row
      // keeps the same Edit + switch rail as the built-in links above it.
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
          <SettingsActions
            status={
              allowDelete && (
                <Button
                  type="button"
                  variant="ghost-danger"
                  size="sm"
                  onClick={() => setPendingRemoveId(link.id)}
                  disabled={link.alwaysEnabled || pending !== null}
                >
                  Remove link
                </Button>
              )
            }
          >
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
    const shipped = allowDelete ? undefined : DEFAULT_SYSTEM_LINKS.find((d) => d.id === link.id);
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
              {allowDelete ? <FaviconIcon url={link.url} /> : <ServiceIcon name={link.icon} />}
            </span>
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

  const pendingRemoveLink = links.find((l) => l.id === pendingRemoveId) ?? null;

  const defaultAgentValue = showCustomUrlInput
    ? "custom"
    : defaultNewTabUrl === null
      ? "none"
      : isCustomUrl
        ? "custom"
        : defaultNewTabUrl;

  const defaultAgentOptions = [
    { value: "none", label: "Launchpad (default)" },
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
            if (editingLinkId === pendingRemoveId) {
              setEditingLinkId(null);
              setEditError(null);
            }
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
        <SettingsGroup>{systemLinks.map((link) => renderLinkRow(link, false))}</SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="portal-custom-links"
        title="Custom links"
        description="Add your own links to AI services or documentation"
      >
        <SettingsGroup>
          {userLinks.map((link) => renderLinkRow(link, true))}
          <SettingsRow
            layout="stacked"
            label="Add a link"
            error={
              addError ? (
                <span key={errorSeq} id={addLinkErrorId} role="alert">
                  {addError.message}
                </span>
              ) : undefined
            }
            control={
              <div className="flex items-center gap-2">
                <Input
                  ref={addNameRef}
                  type="text"
                  placeholder="Name"
                  value={newLinkName}
                  readOnly={pending === "add"}
                  onChange={(e) => {
                    setNewLinkName(e.target.value);
                    setAddError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddLink();
                  }}
                  className="w-40"
                  aria-label="New link name"
                  invalid={addError?.field === "name"}
                  aria-invalid={addError?.field === "name" || undefined}
                  aria-describedby={addError ? addLinkErrorId : undefined}
                />
                <Input
                  type="text"
                  placeholder="https://…"
                  ref={addUrlRef}
                  value={newLinkUrl}
                  readOnly={pending === "add"}
                  onChange={(e) => {
                    setNewLinkUrl(e.target.value);
                    setAddError(null);
                  }}
                  className="flex-1 min-w-0 font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddLink();
                  }}
                  aria-label="New link URL"
                  invalid={addError?.field === "url"}
                  aria-invalid={addError?.field === "url" || undefined}
                  aria-describedby={addError ? addLinkErrorId : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleAddLink()}
                  disabled={pending !== null || !newLinkName.trim() || !newLinkUrl.trim()}
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
