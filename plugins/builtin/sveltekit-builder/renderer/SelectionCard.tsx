import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { AncestryEntry, EditCapability, SelectedNode } from "../shared/model.js";
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
import { WaitingRow } from "./WaitingRow.js";
import { TextEditor } from "./TextEditor.js";
import { ClassEditor } from "./ClassEditor.js";
import {
  STALE_COPY,
  SUPPORT_LABEL,
  TEXT_SHAPE_COPY,
  UNSUPPORTED_REASON_COPY,
  basename,
  plural,
} from "./copy.js";

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
  const nodes = selection.selection.nodes;
  const node = nodes[0];
  if (!node) return null;
  const definition = node.definition;
  const occurrences = definition?.renderedOccurrences ?? 1;
  const stale = selection.stale ? STALE_COPY[selection.stale] : null;

  return (
    <section aria-label="Selected element" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Badge size="sm" tone="neutral" className="font-mono">
            {definition?.tagName ?? tagFromLabel(node)}
          </Badge>
          {node.label ? (
            <span className="min-w-0 truncate text-sm text-text-primary" title={node.label}>
              {node.label}
            </span>
          ) : null}
        </div>
        {definition ? (
          <p
            className="truncate font-mono text-xs text-text-secondary"
            title={`${selection.file ?? definition.location.file}:${definition.location.line}`}
          >
            {`${selection.file ?? definition.location.file}:${definition.location.line}`}
          </p>
        ) : (
          <p className="text-xs text-text-secondary">Source unknown</p>
        )}
        <Breadcrumb node={node} />
      </header>

      {stale ? (
        <InspectorNotice tone="warning" title={stale.title} role="status">
          {stale.detail} Click it in the preview to select it again.
        </InspectorNotice>
      ) : null}

      {occurrences > 1 ? (
        <InspectorNotice
          tone="warning"
          title={`Affects ${plural(occurrences, "rendered copy", "rendered copies")}`}
        >
          {`This markup draws ${occurrences} elements on the page. A change here changes all of them, not just the one you clicked.`}
        </InspectorNotice>
      ) : null}

      <MappingNotice node={node} nodeCount={nodes.length} />

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

function MappingNotice({ node, nodeCount }: { node: SelectedNode; nodeCount: number }) {
  if (nodeCount > 1) {
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

function ancestryLabel(entry: AncestryEntry): string {
  if (entry.kind === "component") {
    return entry.componentTag ?? basename(entry.location.file).replace(/\.svelte$/, "");
  }
  return entry.kind === "unknown" ? "block" : entry.kind;
}

function Breadcrumb({ node }: { node: SelectedNode }) {
  // Innermost first on the wire; generated framework frames are real but never
  // something the user wrote, so they stay out of the trail.
  const trail = node.ancestry.filter((entry) => !entry.generated).reverse();
  if (trail.length === 0) return null;
  return (
    <ol aria-label="Ancestry" className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
      {trail.map((entry, index) => (
        <li
          key={`${entry.location.file}:${entry.location.line}:${entry.location.column}:${index}`}
          className="flex items-center gap-1 text-text-secondary"
          title={`${entry.location.file}:${entry.location.line}`}
        >
          <span>{ancestryLabel(entry)}</span>
          <span aria-hidden="true">›</span>
        </li>
      ))}
      <li className="text-text-primary">{node.definition?.tagName ?? tagFromLabel(node)}</li>
    </ol>
  );
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
    <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-text-secondary">{title}</h3>
        {support && support !== "direct" ? (
          <Badge size="xs" tone="neutral">
            {SUPPORT_LABEL[support]}
          </Badge>
        ) : null}
      </div>
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

function SourceGate({
  state,
  selection,
  children,
}: {
  state: InspectorState;
  selection: ReadySelection;
  children: ReactNode;
}) {
  const node = selection.selection.nodes[0];
  if (!node || !node.definition || !isEditableMapping(node)) {
    return <p className="text-xs text-text-secondary">No source location to edit</p>;
  }
  const source = state.source;
  const current =
    source.status !== "idle" && source.selectionId === selection.selection.selectionId;
  if (!current || source.status === "loading") {
    return <WaitingRow label="Reading the source" />;
  }
  if (source.status === "unavailable") {
    return <p className="text-xs text-text-secondary">Couldn't read this element's source</p>;
  }
  return children;
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

function TextSurface({
  state,
  selection,
  actions,
}: {
  state: InspectorState;
  selection: ReadySelection;
  actions: SelectionActions;
}) {
  const source = state.source;
  const shape = source.status === "ok" ? source.shape.text : null;
  const selectionId = selection.selection.selectionId;
  const editable = editTargetOf(state, "text", selectionId) !== null;
  const saving = state.edit.status === "applying" && state.edit.surface === "text";
  return (
    <SourceGate state={state} selection={selection}>
      {shape?.kind === "literal" ? (
        <TextEditor
          // A successful save spends the selection; start the next edit clean.
          key={`${selection.selection.selectionId}:${selection.stale === "edited" ? "saved" : "open"}`}
          text={shape.text}
          editable={editable}
          saving={saving}
          onSave={(next) => actions.setText(selectionId, next)}
        />
      ) : shape ? (
        <p className="text-xs text-text-secondary">{TEXT_SHAPE_COPY[shape.reason]}</p>
      ) : null}
      <EditOutcome state={state} surface="text" />
    </SourceGate>
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
  const source = state.source;
  const shape = source.status === "ok" ? source.shape.classes : null;
  const selectionId = selection.selection.selectionId;
  const editable = editTargetOf(state, "classes", selectionId) !== null;
  const saving = state.edit.status === "applying" && state.edit.surface === "classes";
  return (
    <SourceGate state={state} selection={selection}>
      {shape?.kind === "static" ? (
        <ClassEditor
          key={selection.selection.selectionId}
          tokens={shape.tokens}
          editable={editable}
          saving={saving}
          onAdd={(tokens) => actions.addClasses(selectionId, tokens)}
          onRemove={(token) => actions.removeClass(selectionId, token)}
          complete={actions.completeClasses}
        />
      ) : shape?.kind === "dynamic" ? (
        <p className="text-xs text-text-secondary">
          The class value includes an expression — edit it in source
        </p>
      ) : shape?.kind === "absent" ? (
        <p className="text-xs text-text-secondary">This element has no class attribute to edit</p>
      ) : null}
      <EditOutcome state={state} surface="classes" />
    </SourceGate>
  );
}
