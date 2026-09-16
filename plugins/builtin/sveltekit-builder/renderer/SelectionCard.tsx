import type { ReactNode } from "react";
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
import { STALE_COPY, SUPPORT_LABEL, UNSUPPORTED_REASON_COPY, plural } from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";
import { SectionHeader } from "./InspectorSection.js";

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
export function SelectionIdentity({ selection }: { selection: ReadySelection }) {
  const nodes = selection.selection.nodes;
  const node = nodes[0];
  if (!node) return null;
  const definition = node.definition;
  const stale = selection.stale ? STALE_COPY[selection.stale] : null;
  // A component picked on the page is named as the component, with the element
  // it was reached through left to the trail below.
  const picked =
    selection.scope === "component"
      ? scopesFor(selection.selection, selection.component, selection.definitions)
      : null;
  const pickedScope = picked ? picked.scopes[picked.pickedIndex] : null;
  const component = pickedScope?.kind === "component" ? pickedScope.label : null;
  const source = component
    ? pickedScope?.kind === "component"
      ? pickedScope.file
      : null
    : definition
      ? `${selection.file ?? definition.location.file}:${definition.location.line}`
      : null;

  return (
    <section aria-label="Selected element" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
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

      {source ? (
        <p className="truncate font-mono text-2xs text-text-secondary" title={source}>
          {middleTruncatePath(source)}
        </p>
      ) : (
        <p className="text-2xs text-text-secondary">
          {component
            ? selection.definitions === null
              ? "Finding where it's written"
              : "Couldn't find where it's written"
            : "Source unknown"}
        </p>
      )}

      {/* The header above names what is selected, so the trail shows only the
          route to it — but it still carries that identity as `current`, or the
          accessibility tree would announce the parent component as the
          selection. */}
      <SelectionTrail
        crumbs={trailFor(node, { includeSelf: false })}
        current={component ?? displayLabel(node)}
        className="text-2xs text-text-secondary"
      />

      {stale ? (
        <InspectorNotice tone="warning" title={stale.title} role="status" density="compact">
          {stale.detail}
        </InspectorNotice>
      ) : null}

      <MappingNotice node={node} nodeCount={nodes.length} scope={selection.scope} />
    </section>
  );
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
    <section aria-label="Edit directly" className="flex flex-col gap-3">
      {occurrences > 1 ? (
        <InspectorNotice
          tone="warning"
          title={`Affects ${plural(occurrences, "rendered copy", "rendered copies")}`}
        >
          {`This markup draws ${occurrences} elements on the page. A change here changes all of them, not just the one you clicked.`}
        </InspectorNotice>
      ) : null}
      <Surface title="Text" capability={capabilityFor(node, "text")}>
        <TextSurface state={state} selection={selection} actions={actions} />
      </Surface>
      <Surface title="Classes" capability={capabilityFor(node, "classes")}>
        <ClassSurface state={state} selection={selection} actions={actions} />
      </Surface>
    </section>
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
  children,
}: {
  title: string;
  capability: EditCapability | undefined;
  children: ReactNode;
}) {
  const support = capability?.support;
  return (
    <div className="flex flex-col">
      <SectionHeader
        title={title}
        action={
          support && support !== "direct" ? (
            <Badge size="xs" tone="neutral">
              {SUPPORT_LABEL[support]}
            </Badge>
          ) : null
        }
      />
      {!capability ? (
        <p className="text-xs text-text-secondary">Not available for this element</p>
      ) : support !== "direct" ? (
        <p className="text-xs text-text-secondary">
          {capability.reason
            ? UNSUPPORTED_REASON_COPY[capability.reason]
            : support === "agent-assisted"
              ? "Changing this safely needs an agent"
              : "This can be inspected but not edited here"}
        </p>
      ) : (
        children
      )}
    </div>
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
          key={`${selectionId}:${selection.stale === "edited" ? "saved" : "open"}`}
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
          key={selectionId}
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
