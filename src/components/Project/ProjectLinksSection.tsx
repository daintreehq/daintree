import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useRowFocus } from "@/components/Settings/useRowFocus";
import { projectClient } from "@/clients";
import { changeProjectLinks, useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { ProjectLink, ProjectLinkChange, ProjectLinkRefusal } from "@shared/types";
import {
  MAX_PROJECT_LINK_TITLE_LENGTH,
  MAX_PROJECT_LINK_URL_LENGTH,
  linkHost,
} from "@shared/utils/projectLinks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { isEnterToSubmit } from "@/lib/enterToSubmit";

const NO_LINKS: ProjectLink[] = [];

interface Draft {
  title: string;
  url: string;
}

const EMPTY_DRAFT: Draft = { title: "", url: "" };

// A row's Edit and Remove buttons are registered side by side. A saved id is any
// non-empty string, so each button's key is prefixed to keep one link's id from
// reading as another button's.
const editButtonKey = (id: string) => `edit:${id}`;
const removeButtonKey = (id: string) => `remove:${id}`;

type ChangeOutcome = "saved" | "dropped" | "failed" | ProjectLinkRefusal;

/**
 * The project's own links, added here by hand or by the Assistant (#17091).
 * Main owns the list, so every change is one operation and the page shows the
 * list main returns. A change made here takes an Assistant-added link over:
 * from then on only the user can change it.
 */
export function ProjectLinksSection({ projectId }: { projectId: string }) {
  // The project on screen keeps its links in the settings store, where an
  // Assistant change also lands; another project's are read for this page.
  const storeLinks = useProjectSettingsStore((s) =>
    s.projectId === projectId && s.settings ? (s.settings.links ?? NO_LINKS) : null
  );
  const [loaded, setLoaded] = useState<{ projectId: string; links: ProjectLink[] } | null>(null);
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
  const urlInputRef = useRef<HTMLInputElement>(null);
  const editTitleRef = useRef<HTMLInputElement>(null);
  const editUrlRef = useRef<HTMLInputElement>(null);
  const { register: registerRow, registerFallback, focusRow, focusAfterDelete } = useRowFocus();
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
    setLoadError(null);
  }, [projectId]);

  useEffect(() => {
    // A read that failed for the page's earlier source says nothing about this one.
    setLoadError(null);
    if (readFromStore) return;
    const visit = visitRef.current;
    // Through a promise, so a client that throws as it is called lands on the
    // page's error rather than escaping the effect.
    Promise.resolve()
      .then(() => projectClient.getSettings(projectId))
      .then(
        (settings) => {
          if (visitRef.current !== visit) return;
          setLoaded({ projectId, links: settings.links ?? [] });
        },
        (error: unknown) => {
          if (visitRef.current !== visit) return;
          logError("Failed to read the project's links", error);
          setLoadError(formatErrorMessage(error, "The project's links couldn't be read."));
        }
      );
  }, [projectId, readFromStore, reloadCount]);

  const links = storeLinks ?? (loaded?.projectId === projectId ? loaded.links : NO_LINKS);

  /**
   * One change through main. Resolves to "saved", to why main refused it, to
   * "failed" when it never got an answer, or to "dropped" when the page moved
   * to another project while it was out.
   */
  const change = async (
    next: ProjectLinkChange,
    onRefused: (message: string) => void
  ): Promise<ChangeOutcome> => {
    if (pendingRef.current) return "dropped";
    pendingRef.current = true;
    setPending(true);
    const visit = visitRef.current;
    try {
      const result = await changeProjectLinks({ projectId, actor: "user", change: next });
      if (visitRef.current !== visit) return "dropped";
      if (!result.saved) {
        onRefused(result.message);
        return result.code;
      }
      setLoaded({ projectId, links: result.links });
      return "saved";
    } catch (error) {
      if (visitRef.current !== visit) return "dropped";
      logError("Failed to change the project's links", error);
      onRefused(formatErrorMessage(error, "The links are as they were."));
      return "failed";
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const add = async () => {
    setAddError(null);
    const outcome = await change({ op: "add", title: draft.title, url: draft.url }, setAddError);
    if (outcome === "dropped") return;
    if (outcome === "saved") {
      setDraft(EMPTY_DRAFT);
      titleInputRef.current?.focus();
      return;
    }
    // On the field to fix, so the problem it now carries is read out.
    (outcome === "invalid-title" ? titleInputRef : urlInputRef).current?.focus();
  };

  const startEdit = (link: ProjectLink) => {
    setEditing({ id: link.id, draft: { title: link.title, url: link.url } });
    setEditError(null);
    setRowError(null);
  };

  // The editor replaced the row's Edit button, so closing it hands focus back to
  // that button instead of letting it fall to the page.
  const cancelEdit = () => {
    if (!editing) return;
    focusRow(editButtonKey(editing.id));
    setEditing(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError(null);
    const outcome = await change(
      { op: "update", id: editing.id, title: editing.draft.title, url: editing.draft.url },
      setEditError
    );
    if (outcome === "saved") {
      // Only while focus is stranded: the save was out for a while, and the user
      // may have moved on to another field.
      focusRow(editButtonKey(editing.id), { onlyIfStranded: true });
      setEditing(null);
    } else if (outcome !== "dropped") {
      (outcome === "invalid-title" ? editTitleRef : editUrlRef).current?.focus();
    }
  };

  const remove = async (link: ProjectLink) => {
    setRowError(null);
    const keys = links.map((l) => removeButtonKey(l.id));
    const index = links.findIndex((l) => l.id === link.id);
    const outcome = await change({ op: "remove", id: link.id }, (message) =>
      setRowError({ id: link.id, message })
    );
    // The removed row's button is gone, so focus goes to a neighbour's, or to the add field.
    if (outcome === "saved") focusAfterDelete(keys, index);
  };

  const submitOnEnter = (action: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isEnterToSubmit(event)) return;
    event.preventDefault();
    action();
  };

  return (
    <SettingsSection
      id="project-links"
      title="Project links"
      description="Addresses offered in the toolbar's links launcher for this project, such as its staging site or CI dashboard. Kept in your local project settings, never in the repo."
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
                ref={(el) => {
                  titleInputRef.current = el;
                  registerFallback(el);
                }}
                type="text"
                value={draft.title}
                maxLength={MAX_PROJECT_LINK_TITLE_LENGTH}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={addError ? true : undefined}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={submitOnEnter(() => void add())}
                placeholder="Name, such as Staging…"
                className="w-auto min-w-32 flex-1"
                readOnly={pending}
              />
              <Input
                ref={urlInputRef}
                type="url"
                value={draft.url}
                maxLength={MAX_PROJECT_LINK_URL_LENGTH}
                aria-label="Link URL"
                aria-describedby={descriptionId}
                aria-invalid={addError ? true : undefined}
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
              control={({ labelId, descriptionId }) => (
                <div className="flex flex-wrap gap-2">
                  <Input
                    ref={editTitleRef}
                    // The Edit button that opened the editor has just unmounted.
                    autoFocus
                    type="text"
                    value={editing.draft.title}
                    maxLength={MAX_PROJECT_LINK_TITLE_LENGTH}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    aria-invalid={editError ? true : undefined}
                    onChange={(e) =>
                      setEditing({ ...editing, draft: { ...editing.draft, title: e.target.value } })
                    }
                    onKeyDown={submitOnEnter(() => void saveEdit())}
                    className="w-auto min-w-32 flex-1"
                    readOnly={pending}
                  />
                  <Input
                    ref={editUrlRef}
                    type="url"
                    value={editing.draft.url}
                    maxLength={MAX_PROJECT_LINK_URL_LENGTH}
                    aria-label="Link URL"
                    aria-describedby={descriptionId}
                    aria-invalid={editError ? true : undefined}
                    onChange={(e) =>
                      setEditing({ ...editing, draft: { ...editing.draft, url: e.target.value } })
                    }
                    onKeyDown={submitOnEnter(() => void saveEdit())}
                    className="w-auto min-w-48 flex-[2]"
                    readOnly={pending}
                  />
                  <Button onClick={cancelEdit} disabled={pending} size="sm" variant="outline">
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
              description={linkHost(link.url)}
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
                    ref={registerRow(editButtonKey(link.id))}
                    onClick={() => startEdit(link)}
                    disabled={pending}
                    aria-label={`Edit ${link.title}`}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost-danger"
                    ref={registerRow(removeButtonKey(link.id))}
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
