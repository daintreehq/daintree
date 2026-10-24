// Workflow pieces: attachments, record references, repeated structured fields,
// form completion, external connections, filter builders and saved views, and
// the agent-work vocabulary of operations, tool calls, sources, proposals and
// decisions. Each is presentational: the data and the work behind it are your
// worker's.

import type { ReactNode } from "react";
import type { PluginDataTableSort } from "./collections.js";
import type { PluginIconSource, PluginRootAttributes } from "./common.js";
import type {
  PluginAttachmentStatus,
  PluginComposerAttachment,
  PluginSelectOption,
} from "./inputs.js";

/** One attachment of an `AttachmentList`: the same shape the `Composer` takes. */
export type PluginAttachment = PluginComposerAttachment;

/**
 * Props of `AttachmentChip`: one attached file or reference, as the
 * `Composer` draws its own. `onOpen` makes the name a button; `onRemove` adds
 * an X that takes it off the draft (not a delete of the thing itself).
 */
export interface PluginAttachmentChipProps extends PluginRootAttributes {
  name: string;
  /** A quiet detail after the name ("12 KB", "L10–24", the failure's cause). */
  detail?: string;
  /** Defaults to `file`. */
  icon?: PluginIconSource;
  status?: PluginAttachmentStatus;
  onOpen?: () => void;
  onRemove?: () => void;
  /** Names the X. Defaults to "Remove {name}". */
  removeLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Props of `AttachmentList`: attachments as wrapping chips, or as rows with
 * the detail to the right. Removing one moves focus to its neighbour, so a
 * keyboard user keeps their place.
 */
export interface PluginAttachmentListProps extends PluginRootAttributes {
  attachments: readonly PluginAttachment[];
  /** `chips` (the default) wraps them in a line; `rows` stacks them as a list. */
  layout?: "chips" | "rows";
  onOpen?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Shown when there are none. Omitted, an empty list draws nothing. */
  empty?: ReactNode;
  disabled?: boolean;
  /** Names the list. Defaults to "Attachments". */
  "aria-label"?: string;
  className?: string;
}

/**
 * Whether a referenced record could be read. `loading` is still resolving;
 * `missing` was deleted or never existed; `forbidden` exists but this user
 * cannot see it. A reference that is not `available` keeps its place: it is
 * shown as what it is rather than dropped.
 */
export type PluginEntityAvailability = "available" | "loading" | "missing" | "forbidden";

/**
 * Props of `EntityChip`: a reference to one of your records (a customer, a
 * ticket, a document) drawn the way the kit draws branches and issues: a
 * glyph or avatar, the label, and an opening action. `preview` adds a card on
 * hover and focus.
 */
export interface PluginEntityChipProps extends PluginRootAttributes {
  label: string;
  /** The kind of record, read before the label ("Customer"). */
  type?: string;
  icon?: PluginIconSource;
  /** A picture in place of `icon`, for a person or an account. */
  avatar?: { src?: string; name: string };
  /** Defaults to `available`. */
  availability?: PluginEntityAvailability;
  onOpen?: () => void;
  /** The card shown on hover and focus. Not shown unless the record is `available`. */
  preview?: ReactNode;
  className?: string;
}

/** What `RepeaterField` hands `renderItem` for one item. */
export interface PluginRepeaterItemContext<T = unknown> {
  index: number;
  /** The item's stable key, from `getKey`. */
  key: string;
  /** Replaces this item. */
  update(next: T): void;
  remove(): void;
  /** The item's error, from `errors`. */
  error?: ReactNode;
  /** The field is disabled: disable this item's controls too. `update` does nothing meanwhile. */
  disabled: boolean;
}

/**
 * Props of `RepeaterField`: a list of structured items (line items, contact
 * methods, routing rules) edited in place. You render each item's fields;
 * the field adds, removes, duplicates and optionally reorders them, keeps
 * every item's error on that item by key, and moves focus sensibly after a
 * removal. `ListEditor` stays the field for a plain list of strings.
 */
export interface PluginRepeaterFieldProps<T = unknown> extends PluginRootAttributes {
  items: readonly T[];
  /**
   * A stable key per item. Keys, not positions, tie a draft and an error to
   * an item, so an insertion above it never moves them onto its neighbour.
   */
  getKey(item: T, index: number): string;
  renderItem(item: T, context: PluginRepeaterItemContext<T>): ReactNode;
  /** The whole list after any change. */
  onChange(items: T[]): void;
  /** Makes a new item for Add. Without it there is no Add button. */
  createItem?(): T;
  /** Copies an item for Duplicate, which then sits under it. Without it there is no Duplicate. */
  duplicateItem?(item: T): T;
  /** Names an item in its controls ("Remove Line 2"). Defaults to "Item {n}". */
  getItemLabel?(item: T, index: number): string;
  /** Add's label. Defaults to "Add item". */
  addLabel?: string;
  /** Remove is offered only while there are more than this many. Defaults to 0. */
  min?: number;
  /** Add and Duplicate stop at this many. */
  max?: number;
  /** Lets the items be dragged, or moved from the keyboard, into a new order. */
  reorderable?: boolean;
  /** Errors by item key, shown under that item. */
  errors?: Readonly<Record<string, ReactNode>>;
  /** Shown when there are no items. */
  empty?: ReactNode;
  disabled?: boolean;
  /** Required: names the list ("Line items"). */
  "aria-label": string;
  className?: string;
}

/** One problem a `FormErrorSummary` lists. */
export interface PluginFormErrorEntry {
  /** The `id` of the control at fault. Omitted, the error is about the form as a whole. */
  field?: string;
  message: string;
}

/**
 * Props of `FormErrorSummary`: every problem with a form in one place, above
 * it, each linked to its control. Choosing one focuses that control, after
 * `onSelect` has had the chance to open a closed section that holds it. Form
 * errors without a field come first, as plain text. Draws nothing when there
 * are no errors.
 */
export interface PluginFormErrorSummaryProps extends PluginRootAttributes {
  errors: readonly PluginFormErrorEntry[];
  /** Defaults to "Fix these to continue". */
  title?: string;
  /**
   * Called with the field's id before it is focused, so a closed section or
   * tab can open first. Focus follows on the next frame.
   */
  onSelect?: (field: string) => void;
  /** Moves focus to the summary when it appears, as after a refused submit. Defaults to `false`. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * Props of `UnsavedChangesBar`: the bar that says edits are not saved yet,
 * with Discard and Save. It shows while `changes` is above zero, or while a
 * save is out, and nowhere else (an `error` included). `onSave` may return a
 * promise: the bar holds Save in its loading state until it settles, and a
 * rejection stays on the bar as the error, the edits untouched, until the
 * next save, a Discard, or `changes` reaching zero.
 */
export interface PluginUnsavedChangesBarProps extends PluginRootAttributes {
  /** How many fields or records changed. */
  changes: number;
  onSave: () => void | Promise<unknown>;
  onDiscard: () => void;
  /** A save you are tracking yourself. */
  saving?: boolean;
  /** Why the last save failed. */
  error?: ReactNode;
  /** Defaults to "Save". */
  saveLabel?: string;
  /** Defaults to "Discard". */
  discardLabel?: string;
  /** Says what changed. Defaults to "{n} unsaved change(s)". */
  message?: ReactNode;
  className?: string;
}

/**
 * The state of a connection to an outside service, as your worker last
 * established it. `expired` needs the user to sign in again; `limited`
 * works but lacks something (a scope, a plan); `error` could not be checked.
 */
export type PluginConnectionStatus =
  "connected" | "connecting" | "disconnected" | "expired" | "limited" | "error";

/**
 * Props of `ConnectionCard`: one outside service your plugin talks to: who it
 * is, which account, whether it works and when that was last checked, with
 * your actions (Connect, Reconnect, Test, Disconnect). The card shows what
 * your worker reports; it never holds a credential.
 */
export interface PluginConnectionCardProps extends PluginRootAttributes {
  /** The service ("Linear"). */
  name: string;
  icon?: PluginIconSource;
  /** Which account or workspace ("acme.linear.app"). */
  account?: string;
  status: PluginConnectionStatus;
  /** What the status means here ("Missing the write:issues scope"). */
  detail?: ReactNode;
  /** When the connection was last checked: epoch ms, an ISO string or a `Date`. */
  checkedAt?: number | string | Date;
  /** Buttons for the card's footer. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Where a piece of work stands. Beyond a task's states: `waiting-input` and
 * `awaiting-approval` are held on the user; `cancelling` asked to stop but has
 * not confirmed it; `partial` finished with some of its work done and some
 * not; `unknown` cannot say whether it took effect (a timeout after a write),
 * which calls for a check rather than a retry.
 */
export type PluginOperationState =
  | "queued"
  | "running"
  | "waiting-input"
  | "awaiting-approval"
  | "cancelling"
  | "partial"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

/** Props of `OperationStatus`: a glyph and a word for where a piece of work stands. */
export interface PluginOperationStatusProps extends PluginRootAttributes {
  state: PluginOperationState;
  /** Replaces the state's word ("Uploading", "8 of 10 done"). */
  label?: string;
  /** A quiet detail after the word. */
  detail?: string;
  /** Only the glyph, with the word for assistive tech and as its tooltip. */
  compact?: boolean;
  className?: string;
}

/**
 * Props of `ToolCallCard`: one tool an agent or a run called, as a compact
 * row (state, name, what it was for, how long it took) that opens on its
 * input and result. Pass values already stripped of secrets: the card shows
 * what it is given.
 */
export interface PluginToolCallCardProps extends PluginRootAttributes {
  /** The tool's name ("search_issues"). */
  name: string;
  /** What the call was for, in words ("Find open bugs assigned to me"). */
  summary?: string;
  state: PluginOperationState;
  /** The arguments, shown in an `ObjectInspector`. */
  input?: unknown;
  /** What came back: a value is inspected, an element drawn as is. */
  result?: unknown;
  /** Why it failed. */
  error?: ReactNode;
  startedAt?: number | string | Date;
  finishedAt?: number | string | Date;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** One field change of a `StructuredDiff`. */
export interface PluginFieldChange {
  /** Unique within the diff; what `selected` holds. */
  id: string;
  /** The field's name ("Status"). */
  label: string;
  /** `changed` (the default) shows before and after; `added` only after; `removed` only before. */
  kind?: "added" | "changed" | "removed";
  before?: ReactNode;
  after?: ReactNode;
  /** Why, or from where: a short reason, a `SourceCitation`. */
  note?: ReactNode;
  /** A problem with the proposed value. A change with one cannot be selected. */
  error?: string;
}

/**
 * Props of `StructuredDiff`: proposed changes to a record's fields, before and
 * after, the review step before a change set is applied. With
 * `onSelectedChange`, each change takes a checkbox and the header one for
 * all, so a reviewer can apply some and leave the rest.
 */
export interface PluginStructuredDiffProps extends PluginRootAttributes {
  changes: readonly PluginFieldChange[];
  /** The ids chosen to apply, controlled. */
  selected?: readonly string[];
  onSelectedChange?: (selected: string[]) => void;
  /** A heading over the changes: the record they belong to. */
  title?: ReactNode;
  /** Shown when there are no changes. Defaults to "No changes". */
  empty?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Props of `SuggestedValue`: one proposed value for one field, beside the
 * current one, with Accept and Reject (and Edit when you can take it into
 * the field). `stale` marks a suggestion made from data that has since
 * changed: it can be rejected, not accepted.
 */
export interface PluginSuggestedValueProps extends PluginRootAttributes {
  /** The field's name. */
  label?: string;
  current?: ReactNode;
  suggested: ReactNode;
  /** Why, in a line. */
  reason?: ReactNode;
  /** Where it came from: a `SourceCitation`, a link. */
  source?: ReactNode;
  onAccept: () => void;
  onReject: () => void;
  onEdit?: () => void;
  stale?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Props of `SourceCitation`: an inline marker ("[2]") pointing at the source
 * a statement came from. `onOpen` makes it a button that opens the source;
 * `preview` adds a card with the excerpt on hover and focus.
 */
export interface PluginSourceCitationProps extends PluginRootAttributes {
  /** The source's number in its `SourceList`. */
  index: number;
  /** The source's title, for assistive tech and the tooltip. */
  title: string;
  /** Where in the source ("p. 3", "L10–24"). */
  locator?: string;
  onOpen?: () => void;
  preview?: ReactNode;
  className?: string;
}

/** One source of a `SourceList`. */
export interface PluginSource {
  /** Unique within the list. */
  id: string;
  title: string;
  /** Where in the source ("p. 3", "L10–24"), or what kind it is. */
  locator?: string;
  /** The passage relied on, quoted under the title. */
  excerpt?: string;
  icon?: PluginIconSource;
}

/**
 * Props of `SourceList`: the numbered sources behind an answer or a proposal,
 * in the order its `SourceCitation`s count them.
 */
export interface PluginSourceListProps extends PluginRootAttributes {
  sources: readonly PluginSource[];
  onOpen?: (id: string) => void;
  /** Names the list. Defaults to "Sources". */
  "aria-label"?: string;
  className?: string;
}

/** One answer a `DecisionRequest` offers. */
export interface PluginDecisionChoice {
  id: string;
  label: string;
  /**
   * `default` is the primary answer, accent-filled: give it to at most one.
   * Omitted, a choice is `secondary`.
   */
  variant?: "default" | "secondary" | "destructive";
}

/**
 * Where a decision stands. Anything but `pending` takes the answers away:
 * `answered` shows the answer given, the rest say why it can no longer be
 * answered.
 */
export type PluginDecisionStatus = "pending" | "answered" | "expired" | "cancelled" | "superseded";

/**
 * Props of `DecisionRequest`: a question a run is waiting on: what is asked,
 * what it affects, any fields to fill, and the answers. `onRespond` may return
 * a promise: the answers hold while it is out, so one press is one answer.
 * A change of `status` drops whatever was in flight. Give each request its
 * own React `key`, so a new question never inherits the last one's state. A
 * plugin's own decision authorises nothing in Daintree itself.
 */
export interface PluginDecisionRequestProps extends PluginRootAttributes {
  /** The question ("Merge 3 duplicate contacts?"). */
  title: string;
  description?: ReactNode;
  /** What answering changes, set apart from the description. */
  consequence?: ReactNode;
  /** Fields the answer needs, drawn between the question and the answers. */
  children?: ReactNode;
  choices: readonly PluginDecisionChoice[];
  onRespond: (choiceId: string) => void | Promise<unknown>;
  /** Defaults to `pending`. */
  status?: PluginDecisionStatus;
  /** The id of the answer given, for `answered`. */
  answer?: string;
  className?: string;
}

/**
 * The comparisons a filter condition can make. Which ones a field offers
 * depends on its type:
 *
 * - `text`: `eq`, `neq`, `contains`, `not_contains`, `empty`, `not_empty`
 * - `number`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `empty`, `not_empty`
 * - `date`: `eq` (on the day), `before`, `after`, `empty`, `not_empty`
 * - `select`: `eq`, `neq`, `empty`, `not_empty`
 * - `boolean`: `eq`, `empty`, `not_empty`
 *
 * `empty` and `not_empty` take no value. A later minor version may add
 * comparisons, so a translator should refuse one it does not know rather
 * than skip it.
 */
export type PluginFilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after"
  | "empty"
  | "not_empty";

/** The kinds of field a `FilterBuilder` can filter on. */
export type PluginFilterFieldType = "text" | "number" | "date" | "select" | "boolean";

/**
 * A condition's value: text for `text`, a finite number for `number`, a
 * `"YYYY-MM-DD"` day for `date`, an option's `value` for `select`, and
 * `true` or `false` for `boolean`.
 */
export type PluginFilterValue = string | number | boolean;

/**
 * One comparison in a filter: `field` is a schema field's `id`, never a
 * path. `value` is left out for `empty` and `not_empty`, and while the user
 * has yet to give one.
 */
export interface PluginFilterCondition {
  field: string;
  op: PluginFilterOperator;
  value?: PluginFilterValue;
}

/**
 * A filter as plain JSON, for your plugin to turn into a query or run with
 * `matchesFilter`: every condition must hold (`all`) or any one (`any`). No
 * conditions is no filter. Groups do not nest. Read one you did not just
 * receive from a `FilterBuilder` (a saved one, an agent's) with `readFilter`,
 * which refuses anything incomplete or outside the schema.
 */
export interface PluginFilter {
  match: "all" | "any";
  conditions: readonly PluginFilterCondition[];
}

/**
 * One field a `FilterBuilder` offers. Ids must be non-empty and unique.
 * "Owner is me" is a `select` with an option whose `value` your plugin
 * resolves to the current user when it runs the filter; the kit has no
 * notion of who that is.
 */
export interface PluginFilterField {
  id: string;
  label: string;
  type: PluginFilterFieldType;
  /** A `select` field's choices. A condition naming a value not listed here is invalid. */
  options?: readonly PluginSelectOption[];
  /**
   * Narrows the comparisons offered, from those the type allows. The kit's
   * order is kept. An empty list leaves the field out of the builder.
   */
  operators?: readonly PluginFilterOperator[];
  /** A `text` or `number` field's placeholder. */
  placeholder?: string;
}

/**
 * Props of `FilterBuilder`: rows of field, comparison and value that edit a
 * `PluginFilter`, with All or Any once there are two. The filter is
 * controlled. A condition the schema no longer allows (a field removed, a
 * comparison it does not offer, an option gone) keeps its row and its JSON,
 * marked with the reason, until the user changes or removes it. Unfinished
 * conditions are part of the value too: run it through `readFilter` before
 * querying with it.
 */
export interface PluginFilterBuilderProps extends PluginRootAttributes {
  fields: readonly PluginFilterField[];
  value: PluginFilter;
  /** The whole filter after any change. */
  onChange: (value: PluginFilter) => void;
  /** Add's label. Defaults to "Add condition". */
  addLabel?: string;
  disabled?: boolean;
  /** Required: names the group ("Issue filters"). */
  "aria-label": string;
  className?: string;
}

/**
 * The choices a saved view holds. All three are always present, so switching
 * views replaces every one of them, not only those the new view changed.
 * `sort` and `hiddenColumns` are `DataTable`'s controlled `sort` and
 * `hiddenColumns`; a view with no table keeps `null` and `[]`.
 */
export interface PluginSavedViewState {
  filter: PluginFilter;
  sort: PluginDataTableSort | null;
  hiddenColumns: readonly string[];
}

/** One named set of filter, sort and column choices. */
export interface PluginSavedView extends PluginSavedViewState {
  /** Non-empty and unique among the views. */
  id: string;
  name: string;
}

/**
 * Props of `SavedViews`: a compact menu of named views, with Save changes,
 * Save as new view, Rename, Revert and Remove. Pass what is on screen now as
 * `current`; choosing a view or reverting calls `onApply` with its choices,
 * for you to put on screen. The control marks `current` as modified when it
 * differs from the chosen view, and never applies a view on its own.
 *
 * The views and the chosen one are controlled when `views` and
 * `activeViewId` are passed. Otherwise `viewStateKey` remembers them with
 * `usePersistentViewState`; keep `current` there too, so a reload shows the
 * choices the chosen view is compared against. Controlled props still win.
 */
export interface PluginSavedViewsProps extends PluginRootAttributes {
  /** The filter, sort and hidden columns on screen now. */
  current: PluginSavedViewState;
  /** Put a view's choices on screen: called on choosing a view, and on Revert. */
  onApply: (state: PluginSavedViewState) => void;
  /** The views, controlled. */
  views?: readonly PluginSavedView[];
  /** The views to start from when uncontrolled and nothing is remembered. */
  defaultViews?: readonly PluginSavedView[];
  /** The whole list after a save, rename or removal. */
  onViewsChange?: (views: PluginSavedView[]) => void;
  /** The chosen view's id, controlled. `null` is none. */
  activeViewId?: string | null;
  defaultActiveViewId?: string | null;
  /** A view was chosen, saved as new, or removed while chosen (`null`). */
  onActiveViewChange?: (id: string | null) => void;
  /** Remembers the views and the chosen one under this key when they are not controlled. */
  viewStateKey?: string;
  /** The trigger's label while no view is chosen. Defaults to "Views". */
  placeholder?: string;
  disabled?: boolean;
  /** Defaults to "Saved views". */
  "aria-label"?: string;
  className?: string;
}
