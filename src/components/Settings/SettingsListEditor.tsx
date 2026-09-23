import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsEmptyRow, SettingsRow } from "./SettingsGroup";
import { useRowFocus } from "./useRowFocus";

/**
 * One editor for every "list of short strings" on the settings pages — excluded
 * paths, include/exclude globs, a resource environment's lifecycle commands. They
 * had grown four row shapes between them: full-width rows with the add button in a
 * footer, stacked rows with it on the right, numbered rows with 16px reorder arrows
 * and a left-aligned extra-small add, and an × in one place and a red trash in the
 * next.
 */

interface ListItemsProps {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  /** Names one item for assistive tech: "Include pattern", "Provision command". */
  itemNoun: string;
  addLabel: string;
  reorderable?: boolean;
}

function ListItems({
  items,
  onChange,
  placeholder,
  itemNoun,
  addLabel,
  reorderable = false,
  autoFocusFirst,
  onAutoFocused,
  onEmptied,
}: ListItemsProps & {
  autoFocusFirst: boolean;
  onAutoFocused: () => void;
  onEmptied: () => void;
}) {
  const focus = useRowFocus();
  const firstField = useRef<HTMLInputElement | null>(null);

  // The empty state is a different row, so the first add mounts this list fresh:
  // the parent flags the request and the new list honours it once.
  useEffect(() => {
    if (!autoFocusFirst) return;
    firstField.current?.focus();
    onAutoFocused();
  }, [autoFocusFirst, onAutoFocused]);

  const describe = (index: number) => {
    const value = items[index]?.trim();
    return value ? `${itemNoun} ${value}` : `${itemNoun} ${index + 1}`;
  };

  // Items are bare strings keyed by position, so after a delete the row that took
  // the deleted one's place is simply the same index.
  const remove = (index: number) => {
    if (items.length === 1) onEmptied();
    else focus.focusRow(String(index < items.length - 1 ? index : index - 1));
    onChange(items.filter((_, i) => i !== index));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            ref={(el) => {
              focus.register(String(index))(el);
              if (index === 0) firstField.current = el;
            }}
            type="text"
            value={item}
            onChange={(e) => onChange(items.map((v, i) => (i === index ? e.target.value : v)))}
            className="flex-1 min-w-0 font-mono"
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label={`${itemNoun} ${index + 1}`}
          />
          {reorderable && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${describe(index)} up`}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                aria-label={`Move ${describe(index)} down`}
              >
                <ChevronDown />
              </Button>
            </>
          )}
          <Button
            variant="ghost-danger"
            size="icon-sm"
            onClick={() => remove(index)}
            aria-label={`Delete ${describe(index)}`}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          ref={focus.registerFallback}
          onClick={() => {
            focus.focusRow(String(items.length));
            onChange([...items, ""]);
          }}
        >
          <Plus />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The empty state and the filled list are different rows, so crossing between them
 * remounts the list and unmounts its own focus bookkeeping. The parent carries the
 * intent across: the first add focuses the new item, and deleting the last item
 * focuses the empty state's add button.
 */
function useEmptyStateFocus() {
  const [focusFirst, setFocusFirst] = useState(false);
  const [focusAdd, setFocusAdd] = useState(false);
  const clearFocusFirst = useCallback(() => setFocusFirst(false), []);
  return {
    listFocus: {
      autoFocusFirst: focusFirst,
      onAutoFocused: clearFocusFirst,
      onEmptied: () => setFocusAdd(true),
    },
    addProps: {
      autoFocus: focusAdd,
      onFocus: () => setFocusAdd(false),
    },
    requestFirstFocus: () => setFocusFirst(true),
  };
}

interface SettingsListRowProps extends ListItemsProps {
  label: string;
  description: string;
}

/**
 * A labelled list inside a group. Empty, it is an ordinary row with the add action
 * on the rail; filled, it stacks the items under the label with the add action
 * where the last item's controls end.
 */
export function SettingsListRow({ label, description, ...list }: SettingsListRowProps) {
  const { listFocus, addProps, requestFirstFocus } = useEmptyStateFocus();

  if (list.items.length === 0) {
    return (
      <SettingsRow
        label={label}
        description={description}
        control={
          <Button
            variant="outline"
            size="sm"
            {...addProps}
            onClick={() => {
              requestFirstFocus();
              list.onChange([""]);
            }}
          >
            <Plus />
            {list.addLabel}
          </Button>
        }
      />
    );
  }

  return (
    <SettingsRow
      label={label}
      description={description}
      layout="stacked"
      control={({ labelId }) => (
        <div role="group" aria-labelledby={labelId}>
          <ListItems {...list} {...listFocus} />
        </div>
      )}
    />
  );
}

interface SettingsListGroupProps extends ListItemsProps {
  /** What to add, as the empty group's one line. */
  emptyText: string;
}

/**
 * A list that is the whole of its section's group — the section already names it,
 * so the items need no row label of their own.
 */
export function SettingsListGroup({ emptyText, ...list }: SettingsListGroupProps) {
  const { listFocus, addProps, requestFirstFocus } = useEmptyStateFocus();

  if (list.items.length === 0) {
    return (
      <SettingsEmptyRow
        action={
          <Button
            variant="outline"
            size="sm"
            {...addProps}
            onClick={() => {
              requestFirstFocus();
              list.onChange([""]);
            }}
          >
            <Plus />
            {list.addLabel}
          </Button>
        }
      >
        {emptyText}
      </SettingsEmptyRow>
    );
  }

  return (
    <div className="px-4 py-3">
      <ListItems {...list} {...listFocus} />
    </div>
  );
}
