import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import type {
  PluginDataTableSort,
  PluginFilter,
  PluginFilterBuilderProps,
  PluginFilterCondition,
  PluginFilterFieldType,
  PluginFilterOperator,
  PluginFilterValue,
  PluginSavedView,
  PluginSavedViewState,
  PluginSavedViewsProps,
  PluginSelectOption,
} from "@shared/types/plugin-sdk-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel, InlineError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toIsoDate } from "@/pluginUi/dateMath";
import {
  isFilterValueFor,
  isNullaryOperator,
  readFilterFields,
  type FilterFieldModel,
} from "@/pluginUi/filters";
import { usePersistentViewState } from "@/pluginUi/viewState";
import { pluginKitDates } from "./PluginKitDates";
import { pluginKitInputs } from "./PluginKitInputs";
import { runPluginAction, warnPluginAuthor } from "./kitDiagnostics";
import { field, fn, nonEmpty, pickRootProps, str, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

const KitDatePicker = pluginKitDates.DatePicker;
const KitNumberInput = pluginKitInputs.NumberInput;

// ---------------------------------------------------------------------------
// FilterBuilder

const OPERATOR_LABELS: Record<PluginFilterOperator, string> = {
  eq: "is",
  neq: "isn't",
  contains: "contains",
  not_contains: "doesn't contain",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  before: "is before",
  after: "is after",
  empty: "is empty",
  not_empty: "isn't empty",
};

function operatorLabel(type: PluginFilterFieldType, op: PluginFilterOperator): string {
  return type === "date" && op === "eq" ? "is on" : OPERATOR_LABELS[op];
}

const BOOLEAN_OPTIONS: readonly PluginSelectOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

const MATCH_OPTIONS: readonly PluginSelectOption[] = [
  { value: "all", label: "All conditions" },
  { value: "any", label: "Any condition" },
];

/** One row as the builder draws it: what the condition says, read without trusting it. */
interface RowModel {
  fieldId: string | undefined;
  op: string | undefined;
  value: unknown;
  field: FilterFieldModel | undefined;
  /** The condition's comparison when its field offers it. */
  allowedOp: PluginFilterOperator | undefined;
  problem: string | undefined;
}

function readRow(entry: unknown, fields: ReadonlyMap<string, FilterFieldModel>): RowModel {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {
      fieldId: undefined,
      op: undefined,
      value: undefined,
      field: undefined,
      allowedOp: undefined,
      problem: "This condition can't be read",
    };
  }
  const fieldId = str(field(entry, "field"));
  const op = str(field(entry, "op"));
  const value = Object.hasOwn(entry, "value") ? field(entry, "value") : undefined;
  const model = fieldId === undefined ? undefined : fields.get(fieldId);
  const allowedOp = model?.operators.find((candidate) => candidate === op);
  let problem: string | undefined;
  if (!model) problem = "This field isn't available";
  else if (!allowedOp) problem = `This comparison isn't available for ${model.label}`;
  else if (
    !isNullaryOperator(allowedOp) &&
    value !== undefined &&
    !isFilterValueFor(model, value)
  ) {
    problem =
      model.type === "select"
        ? `This value isn't available for ${model.label}`
        : `This value isn't valid for ${model.label}`;
  }
  return { fieldId, op, value, field: model, allowedOp, problem };
}

function readRoot(value: unknown): {
  match: "all" | "any";
  conditions: readonly PluginFilterCondition[];
  readable: boolean;
} {
  if (typeof value !== "object" || value === null) {
    return { match: "all", conditions: [], readable: false };
  }
  const conditions = field(value, "conditions");
  return {
    match: field(value, "match") === "any" ? "any" : "all",
    conditions: Array.isArray(conditions) ? conditions : [],
    readable: Array.isArray(conditions),
  };
}

const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

let rowKeySeed = 0;
const newRowKey = () => `row-${++rowKeySeed}`;
let warnedFilterValue = false;

function warnUnreadableFilter() {
  if (warnedFilterValue) return;
  warnedFilterValue = true;
  warnPluginAuthor(
    'FilterBuilder: value must be a filter ({ match: "all", conditions: [] } for none).'
  );
}

function PickerSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  invalid,
  describedBy,
  className,
  ...aria
}: {
  value: string;
  options: readonly PluginSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        {...aria}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy}
        density="compact"
        className={cn("w-auto min-w-0 max-w-full", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent {...owner} className={overlayZ}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            description={option.description}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ValueControl({
  row,
  disabled,
  describedBy,
  onValue,
}: {
  row: RowModel & { field: FilterFieldModel };
  disabled: boolean;
  describedBy: string | undefined;
  onValue: (value: PluginFilterValue | undefined) => void;
}) {
  const { field: model, value } = row;
  const invalid = row.problem !== undefined;
  const common = { "aria-label": "Value", "aria-describedby": describedBy, disabled, invalid };
  switch (model.type) {
    case "text":
      return (
        <Input
          {...common}
          density="compact"
          className="w-40 min-w-0"
          value={typeof value === "string" ? value : ""}
          placeholder={model.placeholder ?? "Value"}
          onChange={(event) => onValue(event.target.value === "" ? undefined : event.target.value)}
        />
      );
    case "number":
      return (
        <KitNumberInput
          {...common}
          density="compact"
          className="w-32"
          step="any"
          stepper={false}
          placeholder={model.placeholder ?? "Value"}
          value={typeof value === "number" && Number.isFinite(value) ? value : null}
          onValueChange={(next) => onValue(next ?? undefined)}
        />
      );
    case "date":
      return (
        <KitDatePicker
          {...common}
          density="compact"
          value={toIsoDate(value)}
          onValueChange={(next) => onValue(next ?? undefined)}
        />
      );
    case "select":
    case "boolean": {
      const boolean = model.type === "boolean";
      const options = boolean ? BOOLEAN_OPTIONS : model.options;
      const current =
        boolean && typeof value === "boolean"
          ? String(value)
          : typeof value === "string" && options.some((option) => option.value === value)
            ? value
            : "";
      return (
        <PickerSelect
          aria-label="Value"
          describedBy={describedBy}
          disabled={disabled}
          invalid={invalid}
          options={options}
          value={current}
          // An option that is gone keeps its id on view, so the row says what it held.
          placeholder={current === "" && typeof value === "string" ? value : "Choose…"}
          onChange={(next) => onValue(boolean ? next === "true" : next)}
        />
      );
    }
  }
}

function KitFilterBuilder({
  fields,
  value,
  onChange,
  addLabel,
  disabled,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginFilterBuilderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const schema = readFilterFields(fields);
  const usable = [...schema.values()];
  const root = readRoot(value);
  if (!root.readable) warnUnreadableFilter();
  const { match, conditions } = root;
  const change = fn(onChange);
  const inert = disabled === true;

  // Keys stay with their rows across an edit, so a number or date field's
  // draft never lands on a neighbour. An edit made here hands its keys over;
  // a list from anywhere else keeps them by position.
  const [keyed, setKeyed] = useState(() => ({
    list: conditions,
    keys: conditions.map(() => newRowKey()),
  }));
  let keys = keyed.keys;
  if (keyed.list !== conditions) {
    keys = conditions.map((_, index) => keyed.keys[index] ?? newRowKey());
    setKeyed({ list: conditions, keys });
  }

  const [focusTarget, setFocusTarget] = useState<
    { key: string; part: "field" | "remove" } | "add" | null
  >(null);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (focusTarget === null || !node) return;
    setFocusTarget(null);
    const row =
      focusTarget === "add"
        ? undefined
        : [...node.querySelectorAll<HTMLElement>("[data-filter-row]")].find(
            (element) => element.getAttribute("data-filter-row") === focusTarget.key
          );
    // The row's first control is its field picker.
    const fieldPicker = row?.querySelector<HTMLElement>(FOCUSABLE);
    const remove = row?.querySelector<HTMLElement>("[data-filter-remove]:not(:disabled)");
    const add = node.querySelector<HTMLElement>("[data-filter-add]:not(:disabled)");
    const order =
      focusTarget === "add"
        ? [add]
        : focusTarget.part === "remove"
          ? [remove, fieldPicker, add]
          : [fieldPicker, remove];
    (order.find((element) => element != null) ?? node).focus();
  }, [focusTarget]);

  const emit = (
    nextConditions: PluginFilterCondition[],
    nextKeys: string[],
    nextMatch: "all" | "any" = match
  ) => {
    if (inert || !change) return;
    setKeyed({ list: nextConditions, keys: nextKeys });
    const next: PluginFilter = { match: nextMatch, conditions: nextConditions };
    runPluginAction("FilterBuilder onChange", () => change(next));
  };
  // Only the edited row is rebuilt: every other condition, a broken one
  // included, goes back exactly as it came.
  const replaceAt = (index: number, condition: PluginFilterCondition) => {
    const next = [...conditions];
    next[index] = condition;
    emit(next, keys);
  };
  const add = () => {
    const first = usable[0];
    const op = first?.operators[0];
    if (!first || op === undefined || inert) return;
    const key = newRowKey();
    emit([...conditions, { field: first.id, op }], [...keys, key]);
    setFocusTarget({ key, part: "field" });
  };
  const removeAt = (index: number) => {
    if (inert) return;
    const remainingKeys = keys.filter((_, at) => at !== index);
    emit(
      conditions.filter((_, at) => at !== index),
      remainingKeys
    );
    const neighbour = remainingKeys[index] ?? remainingKeys[index - 1];
    setFocusTarget(neighbour ? { key: neighbour, part: "remove" } : "add");
  };
  const setField = (index: number, id: string) => {
    const model = schema.get(id);
    const op = model?.operators[0];
    if (!model || op === undefined) return;
    replaceAt(index, { field: model.id, op });
  };
  const setOperator = (index: number, row: RowModel, op: PluginFilterOperator) => {
    if (!row.field) return;
    const { value: kept } = row;
    // A value carries over between comparisons that take one, never into or
    // out of `empty`.
    const carries =
      !isNullaryOperator(op) && row.allowedOp !== undefined && !isNullaryOperator(row.allowedOp);
    replaceAt(
      index,
      carries && isFilterValueFor(row.field, kept)
        ? { field: row.field.id, op, value: kept }
        : { field: row.field.id, op }
    );
  };
  const setValue = (index: number, row: RowModel, next: PluginFilterValue | undefined) => {
    if (!row.field || row.allowedOp === undefined) return;
    replaceAt(
      index,
      next === undefined
        ? { field: row.field.id, op: row.allowedOp }
        : { field: row.field.id, op: row.allowedOp, value: next }
    );
  };

  const fieldOptions: PluginSelectOption[] = usable.map((model) => ({
    value: model.id,
    label: model.label,
  }));

  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      // Focus's last resort after a removal leaves nothing else to take it.
      tabIndex={-1}
      role="group"
      aria-label={nonEmpty(ariaLabel) ?? ""}
      className={cn(
        "flex min-w-0 flex-col gap-2 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      {conditions.length > 1 ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
          <span id={`${baseId}match`}>Match</span>
          <PickerSelect
            aria-labelledby={`${baseId}match`}
            disabled={inert}
            options={MATCH_OPTIONS}
            value={match}
            onChange={(next) => {
              if (next === "all" || next === "any") emit([...conditions], keys, next);
            }}
          />
        </div>
      ) : null}
      {conditions.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-2">
          {conditions.map((entry, index) => {
            const key = keys[index] ?? `#${index}`;
            const row = readRow(entry, schema);
            const errorId = row.problem === undefined ? undefined : `${baseId}${key}-error`;
            const ordinal = index + 1;
            const model = row.field;
            return (
              <li
                key={key}
                data-filter-row={key}
                data-invalid={row.problem === undefined ? undefined : ""}
                role="group"
                aria-label={`Condition ${ordinal}`}
                className="flex min-w-0 flex-col gap-1"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <PickerSelect
                    aria-label="Field"
                    describedBy={model ? undefined : errorId}
                    disabled={inert || fieldOptions.length === 0}
                    invalid={!model}
                    options={fieldOptions}
                    value={model?.id ?? ""}
                    // A field the schema dropped keeps its id on view.
                    placeholder={row.fieldId ?? "Field"}
                    onChange={(id) => setField(index, id)}
                  />
                  {model ? (
                    <PickerSelect
                      aria-label="Comparison"
                      describedBy={row.allowedOp ? undefined : errorId}
                      disabled={inert}
                      invalid={!row.allowedOp}
                      options={model.operators.map((op) => ({
                        value: op,
                        label: operatorLabel(model.type, op),
                      }))}
                      value={row.allowedOp ?? ""}
                      placeholder={row.op ?? "Comparison"}
                      onChange={(op) => {
                        const known = model.operators.find((candidate) => candidate === op);
                        if (known) setOperator(index, row, known);
                      }}
                    />
                  ) : null}
                  {model && row.allowedOp && !isNullaryOperator(row.allowedOp) ? (
                    <ValueControl
                      row={{ ...row, field: model }}
                      disabled={inert}
                      describedBy={errorId}
                      onValue={(next) => setValue(index, row, next)}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove condition ${ordinal}`}
                    data-filter-remove=""
                    disabled={inert}
                    onClick={() => removeAt(index)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {row.problem === undefined ? null : (
                  <InlineError id={errorId}>{row.problem}</InlineError>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div>
        <Button
          variant="ghost"
          size="sm"
          data-filter-add=""
          disabled={inert || usable.length === 0 || !change}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {nonEmpty(addLabel) ?? "Add condition"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SavedViews

const MAX_VIEW_NAME = 80;

function isScalar(value: unknown): value is PluginFilterValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * A condition's shape: a field and a comparison named, a scalar value or
 * none. Whether the schema still allows it is the builder's to say, so a
 * comparison this kit does not know is kept rather than lost on the next save.
 */
function isConditionShape(value: unknown): value is PluginFilterCondition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const given = field(value, "value");
  return (
    typeof field(value, "field") === "string" &&
    typeof field(value, "op") === "string" &&
    (given === undefined || isScalar(given))
  );
}

function copyCondition(condition: PluginFilterCondition): PluginFilterCondition {
  const { field: id, op, value } = condition;
  return value === undefined ? { field: id, op } : { field: id, op, value };
}

function readFilterShape(value: unknown): PluginFilter | null {
  if (typeof value !== "object" || value === null) return null;
  const match = field(value, "match");
  const conditions = field(value, "conditions");
  if ((match !== "all" && match !== "any") || !Array.isArray(conditions)) return null;
  if (!conditions.every(isConditionShape)) return null;
  return { match, conditions: conditions.map(copyCondition) };
}

/** A sort as `DataTable` takes it, `null` for none, `undefined` when it cannot be read. */
function readSort(value: unknown): PluginDataTableSort | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const columnId = nonEmpty(field(value, "columnId"));
  const direction = field(value, "direction");
  if (columnId === undefined || (direction !== "asc" && direction !== "desc")) return undefined;
  return { columnId, direction };
}

function readColumns(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) return undefined;
  return [...new Set(value)];
}

/** Filter, sort and hidden columns as a copy, or `null` when any of them cannot be read. */
export function readSavedViewState(value: unknown): PluginSavedViewState | null {
  if (typeof value !== "object" || value === null) return null;
  const filter = readFilterShape(field(value, "filter"));
  const sort = readSort(field(value, "sort"));
  const hiddenColumns = readColumns(field(value, "hiddenColumns"));
  if (!filter || sort === undefined || !hiddenColumns) return null;
  return { filter, sort, hiddenColumns };
}

/**
 * Views as copies. One that cannot be read whole, or repeats an earlier id,
 * is left out: shown in part, it would save back as something it never was.
 */
export function readSavedViews(value: unknown): PluginSavedView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginSavedView[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const name = nonEmpty(str(field(entry, "name"))?.trim());
    const state = readSavedViewState(entry);
    if (id === undefined || name === undefined || !state || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, ...state });
  }
  return out;
}

function copyState(state: PluginSavedViewState): PluginSavedViewState {
  return {
    filter: { match: state.filter.match, conditions: state.filter.conditions.map(copyCondition) },
    sort: state.sort ? { ...state.sort } : null,
    hiddenColumns: [...state.hiddenColumns],
  };
}

function copyView(view: PluginSavedView): PluginSavedView {
  return { id: view.id, name: view.name, ...copyState(view) };
}

/** The same choices: conditions in order, hidden columns in any order. */
export function sameSavedViewState(a: PluginSavedViewState, b: PluginSavedViewState): boolean {
  const left = a.filter.conditions;
  const right = b.filter.conditions;
  if (a.filter.match !== b.filter.match || left.length !== right.length) return false;
  const sameConditions = left.every((condition, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      condition.field === other.field &&
      condition.op === other.op &&
      Object.is(condition.value, other.value)
    );
  });
  if (!sameConditions) return false;
  if ((a.sort === null) !== (b.sort === null)) return false;
  if (a.sort && b.sort) {
    if (a.sort.columnId !== b.sort.columnId || a.sort.direction !== b.sort.direction) return false;
  }
  const hidden = new Set(a.hiddenColumns);
  const other = new Set(b.hiddenColumns);
  return hidden.size === other.size && [...hidden].every((id) => other.has(id));
}

let viewIdSeed = 0;

/** Unique among `views`, and never handed out twice in a session, so a removed view's id is not reused. */
function newViewId(views: readonly PluginSavedView[]): string {
  const taken = new Set(views.map((view) => view.id));
  for (;;) {
    const id = `view-${Date.now().toString(36)}-${++viewIdSeed}`;
    if (!taken.has(id)) return id;
  }
}

function nameProblem(
  name: string,
  views: readonly PluginSavedView[],
  except: string | null
): string | null {
  if (name === "") return "Enter a view name";
  if (name.length > MAX_VIEW_NAME) return `Use ${MAX_VIEW_NAME} characters or fewer`;
  const folded = name.toLocaleLowerCase();
  const clash = views.some(
    (view) => view.id !== except && view.name.toLocaleLowerCase() === folded
  );
  return clash ? "A view with this name already exists" : null;
}

interface SavedViewsStore {
  views: PluginSavedView[];
  activeId: string | null;
  setViews: (views: PluginSavedView[]) => void;
  setActiveId: (id: string | null) => void;
}

interface StoredViews {
  views: PluginSavedView[];
  /** `""` for none: a string default, so a restored value must be one too. */
  active: string;
}

function initialStoredViews(props: PluginSavedViewsProps): StoredViews {
  return {
    views: readSavedViews(props.defaultViews),
    active: nonEmpty(props.defaultActiveViewId) ?? "",
  };
}

function PersistedSavedViews(props: PluginSavedViewsProps & { viewStateKey: string }) {
  const [saved, setSaved] = usePersistentViewState<StoredViews>(
    `savedViews:${props.viewStateKey}`,
    () => initialStoredViews(props)
  );
  return (
    <SavedViewsControl
      props={props}
      store={{
        views: readSavedViews(saved.views),
        activeId: nonEmpty(saved.active) ?? null,
        setViews: (views) => setSaved((state) => ({ ...state, views })),
        setActiveId: (id) => setSaved((state) => ({ ...state, active: id ?? "" })),
      }}
    />
  );
}

function LocalSavedViews(props: PluginSavedViewsProps) {
  const [state, setState] = useState(() => initialStoredViews(props));
  return (
    <SavedViewsControl
      props={props}
      store={{
        views: state.views,
        activeId: nonEmpty(state.active) ?? null,
        setViews: (views) => setState((current) => ({ ...current, views })),
        setActiveId: (id) => setState((current) => ({ ...current, active: id ?? "" })),
      }}
    />
  );
}

function SavedViewsControl({
  props,
  store,
}: {
  props: PluginSavedViewsProps;
  store: SavedViewsStore;
}) {
  const {
    current,
    onApply,
    onViewsChange,
    onActiveViewChange,
    placeholder,
    disabled,
    "aria-label": ariaLabel,
    className,
  } = props;
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nameInputId = useId();
  // Controlled props win over what the control keeps itself.
  const views = Object.hasOwn(props, "views") ? readSavedViews(props.views) : store.views;
  const activeId = Object.hasOwn(props, "activeViewId")
    ? (nonEmpty(props.activeViewId) ?? null)
    : store.activeId;
  const active = views.find((view) => view.id === activeId) ?? null;
  const now = readSavedViewState(current);
  const modified = active !== null && now !== null && !sameSavedViewState(active, now);
  const inert = disabled === true;
  const apply = fn(onApply);
  const label = nonEmpty(ariaLabel) ?? "Saved views";
  const shownName = active?.name ?? nonEmpty(placeholder) ?? "Views";

  // A rename holds the view it opened on, so a change of view meanwhile cannot redirect it.
  const [naming, setNaming] = useState<{ mode: "new" | "rename"; target: string; open: boolean }>({
    mode: "new",
    target: "",
    open: false,
  });
  const [draft, setDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string; open: boolean }>({
    id: "",
    name: "",
    open: false,
  });

  const commitViews = (next: PluginSavedView[]) => {
    store.setViews(next);
    const notify = fn(onViewsChange);
    if (notify) runPluginAction("SavedViews onViewsChange", () => notify(next.map(copyView)));
  };
  const commitActive = (id: string | null) => {
    store.setActiveId(id);
    const notify = fn(onActiveViewChange);
    if (notify) runPluginAction("SavedViews onActiveViewChange", () => notify(id));
  };
  const applyView = (view: PluginSavedView) => {
    if (apply) runPluginAction("SavedViews onApply", () => apply(copyState(view)));
  };

  const choose = (id: string) => {
    const view = views.find((candidate) => candidate.id === id);
    if (!view || inert) return;
    // Choosing the view already chosen with nothing changed is a no-op;
    // with changes it puts the saved choices back, as Revert does.
    if (view.id === activeId && !modified) return;
    applyView(view);
    if (view.id !== activeId) commitActive(view.id);
  };
  const saveChanges = () => {
    if (!active || !now || inert) return;
    commitViews(
      views.map((view) =>
        view.id === active.id ? { id: view.id, name: view.name, ...copyState(now) } : view
      )
    );
  };
  const openNaming = (mode: "new" | "rename") => {
    setDraft(mode === "rename" && active ? active.name : "");
    setNameError(null);
    setNaming({ mode, target: mode === "rename" ? (active?.id ?? "") : "", open: true });
  };
  const closeNaming = () => setNaming((state) => ({ ...state, open: false }));
  const submitName = () => {
    const name = draft.trim();
    const renaming = naming.mode === "rename";
    const problem = nameProblem(name, views, renaming ? naming.target : null);
    if (problem) {
      setNameError(problem);
      return;
    }
    if (renaming) {
      if (!views.some((view) => view.id === naming.target)) return closeNaming();
      commitViews(views.map((view) => (view.id === naming.target ? { ...view, name } : view)));
    } else {
      if (!now) return closeNaming();
      const id = newViewId(views);
      commitViews([...views, { id, name, ...copyState(now) }]);
      commitActive(id);
    }
    closeNaming();
  };
  const remove = () => {
    const id = removing.id;
    setRemoving((state) => ({ ...state, open: false }));
    if (!views.some((view) => view.id === id)) return;
    commitViews(views.filter((view) => view.id !== id));
    // What is on screen stays: removing a view never applies another.
    if (id === activeId) commitActive(null);
  };

  return (
    <div {...pickRootProps(props)} className={cn("inline-flex min-w-0", str(className))}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            disabled={inert}
            aria-label={`${label}: ${shownName}${modified ? ", modified" : ""}`}
            className="min-w-0 max-w-full"
          >
            <span className="min-w-0 truncate">{shownName}</span>
            {modified ? (
              <span data-saved-view-modified="" className="shrink-0 text-xs text-text-secondary">
                Modified
              </span>
            ) : null}
            <ChevronDown aria-hidden="true" className="shrink-0 text-text-secondary" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent {...owner} className={overlayZ} align="start" aria-label={label}>
          {views.length > 0 ? (
            <>
              <DropdownMenuRadioGroup value={activeId ?? ""} onValueChange={choose}>
                {views.map((view) => (
                  <DropdownMenuRadioItem key={view.id} value={view.id}>
                    <span className="min-w-0 truncate">{view.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {active && modified ? (
            <DropdownMenuItem onSelect={saveChanges}>Save changes</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={!now} onSelect={() => openNaming("new")}>
            {active ? "Save as new view…" : "Save view…"}
          </DropdownMenuItem>
          {active && modified ? (
            <DropdownMenuItem onSelect={() => applyView(active)}>Revert changes</DropdownMenuItem>
          ) : null}
          {active ? (
            <>
              <DropdownMenuItem onSelect={() => openNaming("rename")}>
                Rename view…
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                onSelect={() => setRemoving({ id: active.id, name: active.name, open: true })}
              >
                Remove view…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AppDialog isOpen={naming.open} onClose={closeNaming} size="sm" restoreFocusTo={triggerRef}>
        <AppDialog.Header>
          <AppDialog.Title>
            {naming.mode === "rename" ? "Rename view" : "Save view"}
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              submitName();
            }}
          >
            <Field controlId={nameInputId} invalid={nameError !== null}>
              <FieldLabel>View name</FieldLabel>
              <Input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setNameError(null);
                }}
              />
              {nameError === null ? null : <FieldError role="alert">{nameError}</FieldError>}
            </Field>
          </form>
        </AppDialog.Body>
        <AppDialog.Footer
          secondaryAction={{ label: "Cancel", onClick: closeNaming }}
          primaryAction={{
            label: naming.mode === "rename" ? "Rename view" : "Save view",
            onClick: submitName,
          }}
        />
      </AppDialog>
      <ConfirmDialog
        isOpen={removing.open}
        onClose={() => setRemoving((state) => ({ ...state, open: false }))}
        title={`Remove '${removing.name}'?`}
        description="Its saved filter, sort and columns are removed. What's on screen now stays as it is."
        confirmLabel="Remove view"
        variant="destructive"
        restoreFocusTo={triggerRef}
        onConfirm={remove}
      />
    </div>
  );
}

/**
 * The kit's SavedViews: remembered under `viewStateKey` when the plugin does
 * not control them, keyed so a different key starts from that key's views.
 */
function KitSavedViews(props: PluginSavedViewsProps) {
  const key = nonEmpty(props.viewStateKey);
  if (key) return <PersistedSavedViews key={key} {...props} viewStateKey={key} />;
  return <LocalSavedViews {...props} />;
}

export const pluginKitFilters = {
  FilterBuilder: KitFilterBuilder,
  SavedViews: KitSavedViews,
};
