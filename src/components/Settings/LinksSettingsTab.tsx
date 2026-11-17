import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useGlobalLinksStore,
  type GlobalLink,
  type GlobalLinkUpdate,
} from "@/store/globalLinksStore";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { notify } from "@/lib/notify";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { latestUndoOnly, positionOf, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { linkHost } from "@shared/utils/projectLinks";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useRowFocus } from "./useRowFocus";
import { validateLink, type LinkError } from "./linkValidation";

interface Draft {
  title: string;
  url: string;
}

const EMPTY_DRAFT: Draft = { title: "", url: "" };

type Direction = "up" | "down";

/** The link being edited, with what it held when editing began. */
interface Editing {
  id: string;
  baseline: Draft;
  draft: Draft;
}

function linkName(link: GlobalLink): string {
  return link.title || linkHost(link.url);
}

/** An icon-only control repeated on every row, named for its link and titled by a tooltip. */
function RowAction({
  tooltip,
  ...props
}: { tooltip: string; "aria-label": string } & ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" {...props} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The person's own links, kept for every project on this machine. Each change
 * writes the global links store at once; the store merges it with what other
 * views wrote and brings their changes here.
 */
export function LinksSettingsTab() {
  const links = useGlobalLinksStore((s) => s.links);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [addError, setAddError] = useState<LinkError | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editError, setEditError] = useState<LinkError | null>(null);
  // Every submission that fails bumps this, and it keys the rendered message:
  // a fresh `role="alert"` node is announced even when the text repeats.
  const [errorSeq, setErrorSeq] = useState(0);
  // The control that takes focus once the list has re-rendered: the editor
  // replaced the row's Edit button, and a move can disable the arrow pressed.
  const [focusTarget, setFocusTarget] = useState<
    { kind: "edit"; id: string } | { kind: "move"; id: string; direction: Direction } | null
  >(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);
  const addUrlRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const editUrlRef = useRef<HTMLInputElement>(null);
  const addErrorId = useId();
  const editErrorId = useId();
  const { register: registerRemove, registerFallback, focusAfterDelete } = useRowFocus();

  useSettingsTabValidation("links", Boolean(addError || editError));

  // Another view removed the link being edited. Its draft goes with it, rather
  // than waiting hidden for an Undo there to bring the editor back.
  useEffect(() => {
    if (!editing || links.some((l) => l.id === editing.id)) return;
    setEditing(null);
    setEditError(null);
    focusAfterDelete([], 0);
  }, [editing, links, focusAfterDelete]);

  useEffect(() => {
    if (!focusTarget) return;
    setFocusTarget(null);
    const find = (selector: string) => {
      const el = listRef.current?.querySelector<HTMLElement>(selector);
      return el && !el.matches(":disabled") ? el : null;
    };
    const id = CSS.escape(focusTarget.id);
    const edit = `[data-global-link-edit="${id}"]`;
    const target =
      focusTarget.kind === "edit"
        ? find(edit)
        : (find(`[data-global-link-move="${id}:${focusTarget.direction}"]`) ??
          find(
            `[data-global-link-move="${id}:${focusTarget.direction === "up" ? "down" : "up"}"]`
          ) ??
          find(edit));
    if (!target) return;
    // Keeping focus in the list is not asking for that button's tooltip.
    armTooltipFocusSuppression();
    target.focus();
  }, [focusTarget]);

  const fail = (error: LinkError, setError: (error: LinkError) => void) => {
    setError(error);
    setErrorSeq((n) => n + 1);
  };

  const add = () => {
    const problem = validateLink(draft.title, draft.url);
    if (problem) {
      fail(problem, setAddError);
      (problem.field === "name" ? addNameRef : addUrlRef).current?.focus();
      return;
    }
    useGlobalLinksStore.getState().addLink({ title: draft.title.trim(), url: draft.url.trim() });
    setDraft(EMPTY_DRAFT);
    setAddError(null);
    addNameRef.current?.focus();
  };

  const startEdit = (link: GlobalLink) => {
    const baseline = { title: link.title, url: link.url };
    setEditing({ id: link.id, baseline, draft: baseline });
    setEditError(null);
  };

  const closeEditor = () => {
    if (editing) setFocusTarget({ kind: "edit", id: editing.id });
    setEditing(null);
    setEditError(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const { draft: next, baseline } = editing;
    const problem = validateLink(next.title, next.url);
    if (problem) {
      fail(problem, setEditError);
      (problem.field === "name" ? editNameRef : editUrlRef).current?.focus();
      return;
    }
    // Only what was edited here, so a field another view changed meanwhile stays theirs.
    const updates: GlobalLinkUpdate = {};
    if (next.title !== baseline.title) updates.title = next.title.trim();
    if (next.url !== baseline.url) updates.url = next.url.trim();
    if (updates.title !== undefined || updates.url !== undefined) {
      useGlobalLinksStore.getState().updateLink(editing.id, updates);
    }
    closeEditor();
  };

  // Removed at once and offered back, not confirmed: a link is a name and an
  // address, and Undo puts it back exactly where it was.
  const remove = (link: GlobalLink) => {
    const ids = links.map((l) => l.id);
    const position = positionOf(links, link.id);
    useGlobalLinksStore.getState().removeLink(link.id);
    // Focus moves to a neighbour's Remove once the row is gone, which is not
    // asking for that button's tooltip.
    armTooltipFocusSuppression();
    focusAfterDelete(ids, ids.indexOf(link.id));
    notify({
      type: "success",
      title: "Link removed",
      message: linkName(link),
      priority: "high",
      transient: true,
      duration: UNDO_TOAST_DURATION_MS,
      context: { eventKind: "uiFeedback" },
      action: {
        label: "Undo",
        onClick: latestUndoOnly(`global-link:${link.id}`, () =>
          useGlobalLinksStore.getState().restoreLink(link, position)
        ),
      },
    });
  };

  const move = (id: string, direction: Direction) => {
    // Positions from the store as it is now: another view may have moved links since this rendered.
    const current = useGlobalLinksStore.getState().links;
    const from = current.findIndex((l) => l.id === id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= current.length) return;
    useGlobalLinksStore.getState().reorderLinks(from, to);
    setFocusTarget({ kind: "move", id, direction });
  };

  const onFieldKeyDown =
    (submit: () => void, cancel?: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (isEnterToSubmit(event)) {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape" && cancel) {
        // Kept from the dialog either way: Settings closing would lose the draft.
        event.stopPropagation();
        // An IME's Escape dismisses its candidates, not the editor.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        cancel();
      }
    };

  const renderEditor = (link: GlobalLink, state: Editing) => (
    <div key={link.id} className="divide-y divide-border-subtle">
      <SettingsRow
        layout="stacked"
        label={`Edit ${linkName(link)}`}
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
              value={state.draft.title}
              onChange={(e) => {
                setEditing({ ...state, draft: { ...state.draft, title: e.target.value } });
                setEditError(null);
              }}
              onKeyDown={onFieldKeyDown(saveEdit, closeEditor)}
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
              value={state.draft.url}
              onChange={(e) => {
                setEditing({ ...state, draft: { ...state.draft, url: e.target.value } });
                setEditError(null);
              }}
              onKeyDown={onFieldKeyDown(saveEdit, closeEditor)}
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
        <Button type="button" variant="outline" size="sm" onClick={closeEditor}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="contrast"
          size="sm"
          onClick={saveEdit}
          disabled={
            state.draft.title === state.baseline.title && state.draft.url === state.baseline.url
          }
        >
          Save
        </Button>
      </SettingsActions>
    </div>
  );

  const renderRow = (link: GlobalLink, index: number) => {
    const name = linkName(link);
    return (
      <SettingsRow
        key={link.id}
        label={name}
        labelText={name}
        description={
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block font-mono truncate">{link.url}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{link.url}</TooltipContent>
          </Tooltip>
        }
        control={({ labelId, descriptionId }) => (
          <div className="flex items-center gap-1">
            {/* Reordering needs something to reorder against. */}
            {links.length > 1 && (
              <>
                <RowAction
                  tooltip="Move up"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => move(link.id, "up")}
                  data-global-link-move={`${link.id}:up`}
                >
                  <ArrowUp aria-hidden="true" />
                </RowAction>
                <RowAction
                  tooltip="Move down"
                  aria-label={`Move ${name} down`}
                  disabled={index === links.length - 1}
                  onClick={() => move(link.id, "down")}
                  data-global-link-move={`${link.id}:down`}
                >
                  <ArrowDown aria-hidden="true" />
                </RowAction>
              </>
            )}
            <RowAction
              tooltip="Edit"
              aria-label={`Edit ${name}`}
              onClick={() => startEdit(link)}
              data-global-link-edit={link.id}
            >
              <Pencil aria-hidden="true" />
            </RowAction>
            <RowAction
              tooltip="Remove"
              aria-label={`Remove ${name}`}
              variant="ghost-danger"
              // A Remove that can't be pressed can't take focus after a delete either.
              ref={link.alwaysEnabled ? undefined : registerRemove(link.id)}
              disabled={link.alwaysEnabled}
              onClick={() => remove(link)}
            >
              <Trash2 aria-hidden="true" />
            </RowAction>
            <SettingsSwitch
              className="ml-2"
              checked={link.enabled}
              onCheckedChange={(enabled) =>
                useGlobalLinksStore.getState().updateLink(link.id, { enabled })
              }
              disabled={link.alwaysEnabled}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            />
          </div>
        )}
      />
    );
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        id="global-links"
        title="Your links"
        description="Offered in every project on this machine. Turn one off to hide it without removing it."
      >
        <div ref={listRef}>
          <SettingsGroup>
            {links.map((link, index) =>
              editing?.id === link.id ? renderEditor(link, editing) : renderRow(link, index)
            )}
            <SettingsRow
              layout="stacked"
              label="Add a link"
              description="An http:// or https:// address, shown with its name"
              error={
                addError ? (
                  <span key={errorSeq} id={addErrorId} role="alert">
                    {addError.message}
                  </span>
                ) : undefined
              }
              control={
                <div className="flex items-center gap-2">
                  <Input
                    ref={(el) => {
                      addNameRef.current = el;
                      registerFallback(el);
                    }}
                    type="text"
                    placeholder="Name"
                    value={draft.title}
                    onChange={(e) => {
                      setDraft({ ...draft, title: e.target.value });
                      setAddError(null);
                    }}
                    onKeyDown={onFieldKeyDown(add)}
                    className="w-40"
                    aria-label="New link name"
                    invalid={addError?.field === "name"}
                    aria-invalid={addError?.field === "name" || undefined}
                    aria-describedby={addError ? addErrorId : undefined}
                  />
                  <Input
                    ref={addUrlRef}
                    type="text"
                    placeholder="https://…"
                    value={draft.url}
                    onChange={(e) => {
                      setDraft({ ...draft, url: e.target.value });
                      setAddError(null);
                    }}
                    onKeyDown={onFieldKeyDown(add)}
                    className="flex-1 min-w-0 font-mono"
                    aria-label="New link URL"
                    invalid={addError?.field === "url"}
                    aria-invalid={addError?.field === "url" || undefined}
                    aria-describedby={addError ? addErrorId : undefined}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={add}
                    disabled={!draft.title.trim() || !draft.url.trim()}
                  >
                    <Plus aria-hidden="true" />
                    Add
                  </Button>
                </div>
              }
            />
          </SettingsGroup>
        </div>
      </SettingsSection>
    </div>
  );
}
