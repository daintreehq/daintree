import type { PluginDataTableProps, UseSelectionResult } from "@shared/types/plugin-sdk-react";
import { useSelection } from "@/pluginUi/selection";
import { fn } from "./kitProps";
import {
  selectionOrder,
  type DrawnGroup,
  type DrawnItem,
  type DrawnRow,
  type RowKey,
} from "./kitDataTableModel";
import { attempt, isRowKey, keyList } from "./kitDataTableShared";

export interface DataTableSelection {
  canSelect: boolean;
  selectableRow: (row: unknown) => boolean;
  selection: UseSelectionResult<RowKey>;
  /** Multi-selected, or the plugin's single `selectedRowKey`. */
  isSelected: (row: DrawnRow) => boolean;
  groupKeys: (group: DrawnGroup) => RowKey[];
  groupState: (group: DrawnGroup) => boolean | "indeterminate";
  toggleGroupSelection: (group: DrawnGroup) => void;
  /** The selectable keys in drawn order, folded groups' rows included. */
  selectionIds: RowKey[];
  headerChecked: boolean | "indeterminate";
}

type SelectionProps = Pick<
  PluginDataTableProps,
  | "selectable"
  | "selectedRowKeys"
  | "defaultSelectedRowKeys"
  | "onSelectedRowKeysChange"
  | "selectedRowKey"
>;

/** Rows picked by checkbox, range or group, controlled or the table's own. */
export function useDataTableSelection(
  items: readonly DrawnItem[],
  {
    selectable,
    selectedRowKeys,
    defaultSelectedRowKeys,
    onSelectedRowKeysChange,
    selectedRowKey,
  }: SelectionProps
): DataTableSelection {
  const singleKey = isRowKey(selectedRowKey) ? selectedRowKey : undefined;
  // Selection.
  const selectFn = typeof selectable === "function" ? selectable : undefined;
  const canSelect = selectable === true || selectFn !== undefined;
  const selectableRow = (row: unknown) =>
    canSelect && (!selectFn || attempt(() => selectFn(row) === true, false));
  const selectionIds = canSelect ? selectionOrder(items, selectableRow) : [];
  const controlledKeys = keyList(selectedRowKeys);
  const selection = useSelection<RowKey>({
    ids: selectionIds,
    mode: "multiple",
    ...(controlledKeys
      ? { selected: controlledKeys }
      : { defaultSelected: keyList(defaultSelectedRowKeys) ?? [] }),
    onSelectedChange: fn(onSelectedRowKeysChange),
  });
  const isSelected = (row: DrawnRow) =>
    (canSelect && selection.isSelected(row.key)) ||
    (singleKey !== undefined && row.key === singleKey);

  // A group's selectable rows, whether it is folded or not.
  const groupKeys = (group: DrawnGroup): RowKey[] =>
    canSelect ? group.keys.filter((_key, index) => selectableRow(group.rows[index])) : [];
  const groupState = (group: DrawnGroup): boolean | "indeterminate" => {
    const keys = groupKeys(group);
    const on = keys.filter((key) => selection.isSelected(key)).length;
    return on === 0 ? false : on === keys.length ? true : "indeterminate";
  };
  const toggleGroupSelection = (group: DrawnGroup) => {
    const keys = groupKeys(group);
    if (keys.length === 0) return;
    const allOn = groupState(group) === true;
    const next = new Set(selection.selected);
    for (const key of keys) {
      if (allOn) next.delete(key);
      else next.add(key);
    }
    selection.select([...next]);
  };

  const shownSelected = selectionIds.filter((key) => selection.isSelected(key)).length;
  const headerChecked: boolean | "indeterminate" =
    shownSelected === 0 ? false : shownSelected === selectionIds.length ? true : "indeterminate";
  return {
    canSelect,
    selectableRow,
    selection,
    isSelected,
    groupKeys,
    groupState,
    toggleGroupSelection,
    selectionIds,
    headerChecked,
  };
}
