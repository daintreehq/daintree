import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { EditCapability, SelectedNode } from "../shared/model.js";
import {
  capabilityFor,
  editTargetOf,
  isEditableMapping,
  type ClassCompletion,
  type EditSurface,
  type InspectorState,
  type SelectionState,
} from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { scopesFor } from "./agentTask.js";
import { TextEditor } from "./TextEditor.js";
import { ClassEditor } from "./ClassEditor.js";
import { STALE_COPY, SUPPORT_LABEL, UNSUPPORTED_REASON_COPY } from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";
import { PropertyRow } from "./InspectorSection.js";

export interface SelectionActions {
  setText: (selectionId: string, text: string) => void;
  addClasses: (selectionId: string, tokens: string[]) => Promise<boolean>;
  removeClass: (selectionId: string, token: string) => void;
  completeClasses: (query: string) => Promise<ClassCompletion>;
}

type ReadySelection = Extract<SelectionState, { status: "ready" }>;

export function SelectionCard({
  state,
  selection,
  actions,
}: {
  state: InspectorState;
  selection: ReadySelection;
  actions: SelectionActions;
}) {
  return (
    <>
      <SelectionIdentity selection={selection} />
      <SelectionEdits state={state} selection={selection} actions={actions} />
    </>
  );
}

/**
 * What was selected and where it comes from.
 *
 * The one identity in the drawer. It used to be said three times — a mono
 * `button` badge beside the label `button "Start Pro"`, then the path, then the
 * composer's own `About button "Start Pro" · +page.svelte:6` sixty pixels
 * below — so the densest text in the panel was a repeat, and under a component
 * request scope the two disagreed outright. The composer now labels its scope
 * control instead of restating the subject, and this block is the only place
 * the selection is named.
 */
export function SelectionIdentity({
  selection,
  worktreePath = null,
  reselecting = false,
}: {
  selection: ReadySelection;
  /** Needed only for Open in editor, which wants an absolute path. */
  worktreePath?: string | null;
  /** The page is re-observing the element; the stale notice waits for its answer. */
  reselecting?: boolean;
}) {
  const nodes = selection.selection.nodes;
  const node = nodes[0];
  const { copy, copiedText } = useCopyWithFeedback({ announcement: "Path copied" });
  if (!node) return null;
  const definition = node.definition;
  const stale = selection.stale && !reselecting ? STALE_COPY[selection.stale] : null;
  // A component picked on the page is named as the component, with the element
  // it was reached through left to the trail below.
  const picked =
    selection.scope === "component"
      ? scopesFor(selection.selection, selection.component, selection.definitions)
      : null;
  const pickedScope = picked ? picked.scopes[picked.pickedIndex] : null;
  const component = pickedScope?.kind === "component" ? pickedScope.label : null;
  const file = component
    ? pickedScope?.kind === "component"
      ? pickedScope.file
      : null
    : definition
      ? (selection.file ?? definition.location.file)
      : null;
  const line = component ? null : (definition?.location.line ?? null);
  const source = file ? `${file}${line === null ? "" : `:${line}`}` : null;
  const absolute = file ? absolutePath(worktreePath, file) : null;
  const crumbs = trailFor(node, { includeSelf: false });

  return (
    <section aria-label="Selected element" className="flex flex-col gap-1">
      {/* Row 1, 28px: what it is. */}
      <div className="flex h-7 min-w-0 items-center gap-2">
        <Badge size="sm" tone="neutral" className={component ? undefined : "font-mono"}>
          {component ? "Component" : (definition?.tagName ?? tagFromLabel(node))}
        </Badge>
        <span
          className="min-w-0 truncate text-sm font-medium text-text-primary"
          title={component ?? node.label}
        >
          {component ?? displayLabel(node)}
        </span>
      </div>

      {/* Row 2, 24px: where it lives — and two things to do about that. The
          path used to be inert text with a title. The filename and line are
          a non-shrinking suffix so a narrow drawer contracts the directories,
          never the one part the reader came for. */}
      <div className="flex h-6 min-w-0 items-center gap-1">
        {source && file ? (
          <>
            <SourcePath file={file} line={line} className="min-w-0 flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={copiedText === source ? "Path copied" : "Copy path"}
              title="Copy path"
              onClick={() => void copy(source)}
            >
              {copiedText === source ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
            {absolute ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open in editor"
                title="Open in editor"
                onClick={() =>
                  void actionService.dispatch(
                    "file.openInEditor",
                    line === null ? { path: absolute } : { path: absolute, line },
                    { source: "user" }
                  )
                }
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-2xs text-text-secondary">
            {component
              ? selection.definitions === null
                ? "Finding where it's written"
                : "Couldn't find where it's written"
              : "Source unknown"}
          </p>
        )}
      </div>

      {/* Row 3, 20px: how it was reached. The header names the selection, so
          the trail shows the route and carries the identity for assistive
          technology rather than repeating it visibly. */}
      <div className="flex h-5 min-w-0 items-center gap-1 text-2xs text-text-secondary">
        {crumbs.length > 0 ? (
          <>
            <span className="shrink-0">in</span>
            <SelectionTrail
              crumbs={crumbs}
              currentIndex={crumbs.length}
              currentLabel={component ?? displayLabel(node)}
              className="min-w-0"
            />
          </>
        ) : (
          <span>at the top level</span>
        )}
      </div>

      {stale ? (
        <InspectorNotice
          tone="warning"
          title={stale.title}
          role="status"
          density="compact"
          className="mt-1"
        >
          {stale.detail}
        </InspectorNotice>
      ) : null}

      <MappingNotice node={node} nodeCount={nodes.length} scope={selection.scope} />
    </section>
  );
}

/**
 * A source location whose filename and line cannot be truncated away. The
 * directories are one flex child that shrinks and middle-truncates; the tail
 * is another that does not shrink at all.
 */
export function SourcePath({
  file,
  line,
  className,
}: {
  file: string;
  line: number | null;
  className?: string;
}) {
  const slash = file.lastIndexOf("/");
  const dir = slash === -1 ? "" : file.slice(0, slash + 1);
  const name = slash === -1 ? file : file.slice(slash + 1);
  const full = `${file}${line === null ? "" : `:${line}`}`;
  return (
    <span
      className={cn(
        "flex min-w-0 items-baseline font-mono text-2xs text-text-secondary",
        className
      )}
      title={full}
    >
      {dir ? <span className="min-w-0 shrink truncate">{middleTruncatePath(dir, 40)}</span> : null}
      <span className="shrink-0">
        {name}
        {/* Same tone as the path: `text-muted` has no dark-theme floor and the
            line number vanished on namib. */}
        {line === null ? null : <span>{`:${line}`}</span>}
      </span>
    </span>
  );
}

function absolutePath(worktreePath: string | null, file: string): string | null {
  if (file.startsWith("/")) return file;
  if (!worktreePath) return null;
  return `${worktreePath.replace(/\/+$/, "")}/${file}`;
}

/**
 * The element's own name without its tag prefix: the badge beside it already
 * carries the tag, and `button` `button "Start Pro"` said it twice.
 */
function displayLabel(node: SelectedNode): string {
  const tag = node.definition?.tagName;
  const label = node.label || tag || "element";
  if (!tag) return label;
  const prefix = `${tag} `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/** Direct source edits for the selected element's literal text and classes. */
export function SelectionEdits({
  state,
  selection,
  actions,
}: {
  state: InspectorState;
  selection: ReadySelection;
  actions: SelectionActions;
}) {
  const node = selection.selection.nodes[0];
  if (!node) return null;
  const occurrences = node.definition?.renderedOccurrences ?? 1;
  return (
    <section aria-label="Edit directly" className="flex flex-col gap-2">
      {occurrences > 1 ? <SharedMarkupRow count={occurrences} /> : null}
      <Surface title="Text" capability={capabilityFor(node, "text")}>
        <TextSurface state={state} selection={selection} actions={actions} />
      </Surface>
      <Surface title="Classes" capability={capabilityFor(node, "classes")} align="start">
        <ClassSurface state={state} selection={selection} actions={actions} />
      </Surface>
    </section>
  );
}

/**
 * The shared-markup warning as one row rather than an 86px card. It is routine
 * — an `{#each}` draws copies — and the user meets it on most list items, so
 * it says the one fact in a line and keeps the explanation behind a disclosure.
 */
function SharedMarkupRow({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1 flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-1 text-left text-xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-text-primary">
          {`Applies to all ${count} rendered copies`}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
            open && "rotate-90"
          )}
        />
      </button>
      {open ? (
        <p id={bodyId} className="px-1 text-xs text-text-secondary">
          {`This markup draws ${count} elements on the page. A change here changes all of them, not just the one you clicked.`}
        </p>
      ) : null}
    </div>
  );
}

function tagFromLabel(node: SelectedNode): string {
  return node.label.split(/\s/)[0] || "element";
}

function MappingNotice({
  node,
  nodeCount,
  scope,
}: {
  node: SelectedNode;
  nodeCount: number;
  scope: "element" | "component";
}) {
  // A component with several root elements is one thing, not a multi-selection.
  if (nodeCount > 1 && scope !== "component") {
    return (
      <InspectorNotice tone="info" title={`${nodeCount} elements selected`}>
        Editing works on one element at a time. Select a single element to change it.
      </InspectorNotice>
    );
  }
  if (node.mapping === "ambiguous") {
    return (
      <InspectorNotice tone="warning" title="More than one source could own this element">
        Editing is off so a change can't land in the wrong place.
      </InspectorNotice>
    );
  }
  if (node.mapping === "visual-only" || !node.definition) {
    return (
      <InspectorNotice tone="info" title="Not traced to source">
        This content is drawn at runtime — by {"{@html}"}, a canvas or a shadow root — so it has no
        source location to edit.
      </InspectorNotice>
    );
  }
  return null;
}

function Surface({
  title,
  capability,
  align = "center",
  children,
}: {
  title: string;
  capability: EditCapability | undefined;
  align?: "center" | "start";
  children: ReactNode;
}) {
  const support = capability?.support;
  // The capability badge sits with its explanation in the control column: in
  // the 64px label column it took the label's room and could run into the
  // control beside it.
  return (
    <PropertyRow label={title} align={align}>
      {!capability ? (
        <p className="text-xs leading-7 text-text-secondary">Not available for this element</p>
      ) : capability.support !== "direct" ? (
        <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          <Badge size="xs" tone="neutral">
            {SUPPORT_LABEL[capability.support]}
          </Badge>
          <span>
            {capability.reason
              ? UNSUPPORTED_REASON_COPY[capability.reason]
              : support === "agent-assisted"
                ? "Changing this safely needs an agent"
                : "This can be inspected but not edited here"}
          </span>
        </div>
      ) : (
        children
      )}
    </PropertyRow>
  );
}

function EditOutcome({ state, surface }: { state: InspectorState; surface: EditSurface }) {
  const edit = state.edit;
  if (edit.status === "failed" && edit.surface === surface) {
    return (
      <InspectorNotice tone="error" title={edit.title} role="alert">
        {edit.detail}
      </InspectorNotice>
    );
  }
  if (edit.status === "no-op" && edit.surface === surface) {
    return <p className="text-xs text-text-secondary">No change — the source already matches</p>;
  }
  return null;
}

/**
 * The current value comes from main, decoded from the compiler's AST — never
 * re-read here. A direct surface without one has nothing trustworthy to edit.
 */
function NoDecodedValue({ node }: { node: SelectedNode }) {
  if (!node.definition || !isEditableMapping(node)) {
    return <p className="text-xs text-text-secondary">No source location to edit</p>;
  }
  return (
    <p className="text-xs text-text-secondary">
      No literal value here to edit — change it in source
    </p>
  );
}

function TextSurface({
  state,
  selection,
  actions,
}: {
  state: InspectorState;
  selection: ReadySelection;
  actions: SelectionActions;
}) {
  const node = selection.selection.nodes[0]!;
  const text = node.surfaces.text;
  const selectionId = selection.selection.selectionId;
  const editable = editTargetOf(state, "text", selectionId) !== null;
  const saving = state.edit.status === "applying" && state.edit.surface === "text";
  return (
    <>
      {text ? (
        <TextEditor
          // A successful save spends the selection; start the next edit clean.
          // The generation, not the selection id: a re-proof after a write mints
          // a new id, and keying on it unmounted the editor mid-loop. The
          // "saved" suffix still starts the next text edit clean.
          key={`${state.selectionGeneration}:${selection.stale === "edited" ? "saved" : "open"}`}
          text={text.text}
          editable={editable}
          saving={saving}
          onSave={(next) => actions.setText(selectionId, next)}
        />
      ) : (
        <NoDecodedValue node={node} />
      )}
      <EditOutcome state={state} surface="text" />
    </>
  );
}

function ClassSurface({
  state,
  selection,
  actions,
}: {
  state: InspectorState;
  selection: ReadySelection;
  actions: SelectionActions;
}) {
  const node = selection.selection.nodes[0]!;
  const classes = node.surfaces.classes;
  const selectionId = selection.selection.selectionId;
  const editable = editTargetOf(state, "classes", selectionId) !== null;
  const saving = state.edit.status === "applying" && state.edit.surface === "classes";
  return (
    <>
      {classes ? (
        <ClassEditor
          key={state.selectionGeneration}
          tokens={classes.tokens}
          editable={editable}
          saving={saving}
          onAdd={(tokens) => actions.addClasses(selectionId, tokens)}
          onRemove={(token) => actions.removeClass(selectionId, token)}
          complete={actions.completeClasses}
        />
      ) : (
        <NoDecodedValue node={node} />
      )}
      <EditOutcome state={state} surface="classes" />
    </>
  );
}
