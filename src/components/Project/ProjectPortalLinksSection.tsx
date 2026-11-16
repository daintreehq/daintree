import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { projectClient } from "@/clients";
import { changeProjectPortalLinks, useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { ProjectPortalLink, ProjectPortalLinkChange } from "@shared/types";
import {
  MAX_PROJECT_PORTAL_LINK_TITLE_LENGTH,
  MAX_PROJECT_PORTAL_LINK_URL_LENGTH,
  portalLinkHost,
} from "@shared/utils/projectPortalLinks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

const NO_LINKS: ProjectPortalLink[] = [];

interface Draft {
  title: string;
  url: string;
}

const EMPTY_DRAFT: Draft = { title: "", url: "" };

/**
 * The project's own Portal launchpad links, added here by hand or by the
 * Assistant (#17091). Main owns the list, so every change is one operation
 * and the page shows the list main returns. A change made here takes an
 * Assistant-added link over: from then on only the user can change it.
 */
export function ProjectPortalLinksSection({ projectId }: { projectId: string }) {
  // The project on screen keeps its links in the settings store, where an
  // Assistant change also lands; another project's are read for this page.
  const storeLinks = useProjectSettingsStore((s) =>
    s.projectId === projectId && s.settings ? (s.settings.portalLinks ?? NO_LINKS) : null
  );
  const [loaded, setLoaded] = useState<{ projectId: string; links: ProjectPortalLink[] } | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Bumped whenever the page moves to a project, so anything still in flight
  // for an earlier one is dropped.
  const visitRef = useRef(0);

  const readFromStore = storeLinks !== null;

  useEffect(() => {
    visitRef.current++;
    setDraft(EMPTY_DRAFT);
    setAddError(null);
    setEditing(null);
    setEditError(null);
    setRowError(null);
  }, [projectId]);

  useEffect(() => {
    if (readFromStore) return;
    const visit = visitRef.current;
    setLoadError(null);
    projectClient.getSettings(projectId).then(
      (settings) => {
        if (visitRef.current !== visit) return;
        setLoaded({ projectId, links: settings.portalLinks ?? [] });
      },
      (error: unknown) => {
        if (visitRef.current !== visit) return;
        logError("Failed to read the project's Portal links", error);
        setLoadError(formatErrorMessage(error, "The project's links couldn't be read."));
      }
    );
  }, [projectId, readFromStore, reloadCount]);

  const links = storeLinks ?? (loaded?.projectId === projectId ? loaded.links : NO_LINKS);

  const change = async (
    next: ProjectPortalLinkChange,
    onRefused: (message: string) => void
  ): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    const visit = visitRef.current;
    try {
      const result = await changeProjectPortalLinks({ projectId, actor: "user", change: next });
      if (visitRef.current !== visit) return false;
      if (!result.saved) {
        onRefused(result.message);
        return false;
      }
      setLoaded({ projectId, links: result.links });
      return true;
    } catch (error) {
      if (visitRef.current !== visit) return false;
      logError("Failed to change the project's Portal links", error);
      onRefused(formatErrorMessage(error, "The links are as they were."));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const add = async () => {
    setAddError(null);
    const saved = await change({ op: "add", title: draft.title, url: draft.url }, setAddError);
    if (!saved) return;
    setDraft(EMPTY_DRAFT);
    titleInputRef.current?.focus();
  };

  const startEdit = (link: ProjectPortalLink) => {
    setEditing({ id: link.id, draft: { title: link.title, url: link.url } });
    setEditError(null);
    setRowError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError(null);
    const saved = await change(
      { op: "update", id: editing.id, title: editing.draft.title, url: editing.draft.url },
      setEditError
    );
    if (saved) setEditing(null);
  };

  const remove = async (link: ProjectPortalLink) => {
    setRowError(null);
    await change({ op: "remove", id: link.id }, (message) =>
      setRowError({ id: link.id, message })
    );
  };

  const submitOnEnter = (action: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    action();
  };

  return (
    <SettingsSection
      id="project-portal-links"
      title="Portal links"
      description="Addresses offered in this project's Portal launchpad, above the chat services, such as its staging site or CI dashboard. Kept on this machine, never in the repo."
    >
      {loadError && (
        <SettingsLoadErrorBanner
          title="Couldn't load the links"
          message={loadError}
          onRetry={() => setReloadCount((count) => count + 1)}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          label="Add a link"
          description="https:// or http:// address, shown with its name"
          layout="stacked"
          error={addError}
          control={({ labelId, descriptionId }) => (
            <div className="flex flex-wrap gap-2">
              <Input
                ref={titleInputRef}
                type="text"
                value={draft.title}
                maxLength={MAX_PROJECT_PORTAL_LINK_TITLE_LENGTH}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={submitOnEnter(() => void add())}
                placeholder="Name, such as Staging…"
                className="w-auto min-w-32 flex-1"
                readOnly={pending}
              />
              <Input
                type="url"
                value={draft.url}
                maxLength={MAX_PROJECT_PORTAL_LINK_URL_LENGTH}
                aria-label="Link URL"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                onKeyDown={submitOnEnter(() => void add())}
                placeholder="https://…"
                className="w-auto min-w-48 flex-[2]"
                readOnly={pending}
              />
              <Button
                onClick={() => void add()}
                disabled={pending || !draft.title.trim() || !draft.url.trim()}
                size="sm"
                variant="outline"
              >
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>
          )}
        />
        {links.map((link) =>
          editing?.id === link.id ? (
            <SettingsRow
              key={link.id}
              label={`Edit ${link.title}`}
              layout="stacked"
              error={editError}
              control={({ labelId }) => (
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="text"
                    value={editing.draft.title}
                    maxLength={MAX_PROJECT_PORTAL_LINK_TITLE_LENGTH}
                    aria-labelledby={labelId}
                    onChange={(e) =>
                      setEditing({ ...editing, draft: { ...editing.draft, title: e.target.value } })
                    }
                    onKeyDown={submitOnEnter(() => void saveEdit())}
                    className="w-auto min-w-32 flex-1"
                    readOnly={pending}
                  />
                  <Input
                    type="url"
                    value={editing.draft.url}
                    maxLength={MAX_PROJECT_PORTAL_LINK_URL_LENGTH}
                    aria-label="Link URL"
                    onChange={(e) =>
                      setEditing({ ...editing, draft: { ...editing.draft, url: e.target.value } })
                    }
                    onKeyDown={submitOnEnter(() => void saveEdit())}
                    className="w-auto min-w-48 flex-[2]"
                    readOnly={pending}
                  />
                  <Button
                    onClick={() => setEditing(null)}
                    disabled={pending}
                    size="sm"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void saveEdit()}
                    disabled={pending}
                    size="sm"
                    variant="contrast"
                  >
                    Save
                  </Button>
                </div>
              )}
            />
          ) : (
            <SettingsRow
              key={link.id}
              label={link.title}
              description={portalLinkHost(link.url)}
              accessory={
                link.addedByAssistant ? (
                  <Badge size="xs" tone="neutral">
                    Added by Assistant
                  </Badge>
                ) : undefined
              }
              error={rowError?.id === link.id ? rowError.message : undefined}
              control={
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => startEdit(link)}
                    disabled={pending}
                    aria-label={`Edit ${link.title}`}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost-danger"
                    onClick={() => void remove(link)}
                    disabled={pending}
                    aria-label={`Remove ${link.title}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              }
            />
          )
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
