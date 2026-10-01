import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { Folder, FolderOpen } from "lucide-react";
import type { PluginFileTreeItem, PluginFileTreeProps } from "@shared/types/plugin-sdk-react";
import type { FileTreeNode } from "@shared/types/ipc/copyTree";
import {
  flattenTree,
  resolveTreeKey,
  resolveTypeahead,
  TYPEAHEAD_RESET_MS,
  type FlatTreeRow,
} from "@/panels/file-browser/fileBrowserTree";
import {
  FILE_TREE_ICON_CLASS,
  FILE_TREE_ICON_COLOR_CLASS,
  getFileTypeIcon,
} from "@/panels/file-browser/fileTypeIcons";
import { cn } from "@/lib/utils";
import { field, fn, hasContent, node, nonEmpty, pickRootProps, str } from "./kitProps";
import {
  TREE_ROW_CLASS,
  TREE_ROW_HEIGHT_PX,
  TreeChevron,
  TreeGutter,
  treeRowPadding,
} from "./kitTreeRow";

/**
 * Natural order: numeric-aware and case-insensitive, so `churn-2` precedes
 * `churn-10` and `Readme` sits with `readme`. Base sensitivity leaves true
 * ties, which fall through to code units so the order is total and stable.
 */
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then natural name order. Exported for tests. */
export function compareTreeNames(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean }
): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const collated = NATURAL.compare(a.name, b.name);
  if (collated !== 0) return collated;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

type Listings = Map<string, FileTreeNode[]>;

function isDirType(type: unknown): boolean {
  return type === "dir" || type === "directory";
}

/** `./a//b/` → `a/b`; empty when nothing is left. */
function cleanPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * One listing per folder, keyed by its path ("" for the root), from either
 * input shape. Parents a flat list only implies are filled in, and a path
 * that is a folder anywhere is a folder everywhere.
 */
function buildListings(entries: unknown, nodes: unknown): Listings {
  const kinds = new Map<string, boolean>();
  const order: string[] = [];
  const add = (path: string, isDirectory: boolean) => {
    const known = kinds.get(path);
    if (known === undefined) {
      kinds.set(path, isDirectory);
      order.push(path);
    } else if (isDirectory && !known) {
      kinds.set(path, true);
    }
    for (let parent = parentOf(path); parent !== ""; parent = parentOf(parent)) {
      const was = kinds.get(parent);
      if (was === true) break;
      if (was === undefined) order.push(parent);
      kinds.set(parent, true);
    }
  };

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const path = cleanPath(field(entry, "path"));
      if (path !== "") add(path, isDirType(field(entry, "type")));
    }
  } else if (Array.isArray(nodes)) {
    const visit = (list: readonly unknown[], prefix: string, depth: number) => {
      if (depth > 64) return;
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const name = cleanPath(field(item, "name"));
        if (name === "" || name.includes("/")) continue;
        const path = prefix === "" ? name : `${prefix}/${name}`;
        const children = field(item, "children");
        add(path, isDirType(field(item, "type")) || Array.isArray(children));
        if (Array.isArray(children)) visit(children, path, depth + 1);
      }
    };
    visit(nodes, "", 0);
  }

  const listings: Listings = new Map([["", []]]);
  for (const path of order) {
    const isDirectory = kinds.get(path) === true;
    if (isDirectory && !listings.has(path)) listings.set(path, []);
    const parent = parentOf(path);
    let siblings = listings.get(parent);
    if (!siblings) {
      siblings = [];
      listings.set(parent, siblings);
    }
    siblings.push({ name: baseName(path), path, isDirectory });
  }
  return listings;
}

function sortListings(listings: Listings): void {
  for (const siblings of listings.values()) siblings.sort(compareTreeNames);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(cleanPath).filter((path) => path !== "");
}

function itemOf(row: FlatTreeRow): PluginFileTreeItem {
  return {
    path: row.path,
    name: row.name,
    type: row.isDirectory ? "directory" : "file",
    depth: row.depth,
  };
}

interface TreeContext {
  cursorPath: string | null;
  hasDirectories: boolean;
  rowId: (path: string) => string;
  select: (row: FlatTreeRow) => void;
  toggle: (row: FlatTreeRow, expand: boolean) => void;
  activate: ((row: FlatTreeRow) => void) | undefined;
}

function TreeRow({ row, context }: { row: FlatTreeRow; context: TreeContext }) {
  const selected = context.cursorPath === row.path;
  const RowIcon = row.isDirectory
    ? row.isExpanded
      ? FolderOpen
      : Folder
    : getFileTypeIcon(row.name).Icon;
  const activate = context.activate;
  return (
    <div
      id={context.rowId(row.path)}
      role="treeitem"
      aria-label={row.name}
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      onClick={() => {
        context.select(row);
        if (row.isDirectory) context.toggle(row, !row.isExpanded);
      }}
      onDoubleClick={activate ? () => activate(row) : undefined}
      style={{ paddingLeft: treeRowPadding(row.depth) }}
      className={cn(TREE_ROW_CLASS, selected ? "text-text-primary" : "text-text-secondary")}
    >
      {row.isDirectory ? (
        <TreeChevron
          expanded={row.isExpanded}
          onToggle={() => context.toggle(row, !row.isExpanded)}
        />
      ) : context.hasDirectories ? (
        <TreeGutter />
      ) : null}
      <RowIcon
        className={cn(FILE_TREE_ICON_CLASS, "h-3.5 w-3.5 shrink-0", FILE_TREE_ICON_COLOR_CLASS)}
        aria-hidden="true"
      />
      <span className={cn("min-w-0 truncate", selected && "font-medium")}>{row.name}</span>
    </div>
  );
}

function renderRow(_index: number, row: FlatTreeRow, context: TreeContext): ReactNode {
  return <TreeRow row={row} context={context} />;
}

function rowKey(_index: number, row: FlatTreeRow): string {
  return row.path;
}

const NO_LOADING: ReadonlySet<string> = new Set();

function KitFileTree(props: PluginFileTreeProps) {
  const {
    entries,
    nodes,
    "aria-label": ariaLabel,
    defaultSelectedPath,
    onSelect,
    defaultExpandedPaths,
    onExpandedPathsChange,
    onActivate,
    sort,
    empty,
    className,
  } = props;
  const selectionControlled = Object.hasOwn(props, "selectedPath");
  const expansionControlled = Object.hasOwn(props, "expandedPaths");
  const [ownSelected, setOwnSelected] = useState<string | null>(
    () => nonEmpty(cleanPath(defaultSelectedPath)) ?? null
  );
  const [ownExpanded, setOwnExpanded] = useState<string[]>(
    () => stringList(defaultExpandedPaths) ?? []
  );
  const cursorPath = selectionControlled
    ? (nonEmpty(cleanPath(props.selectedPath)) ?? null)
    : ownSelected;
  const expandedSource: unknown = expansionControlled ? props.expandedPaths : ownExpanded;
  const expanded = useMemo(() => new Set(stringList(expandedSource) ?? []), [expandedSource]);

  // Built once per input, not per render: a walk of ten thousand entries is
  // sorted here, and a keystroke or an expand must not pay for it again.
  const natural = sort !== "none";
  const listings = useMemo(() => {
    const built = buildListings(entries, nodes);
    if (natural) sortListings(built);
    return built;
  }, [entries, nodes, natural]);
  // Also memoised: the scroll range is state, and a scroll must not re-walk
  // the expanded tree.
  const rows = useMemo(() => flattenTree(listings, expanded, NO_LOADING, ""), [listings, expanded]);
  const hasDirectories = useMemo(() => rows.some((row) => row.isDirectory), [rows]);
  const cursorIndex = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);

  const handleSelect = fn(onSelect);
  const handleExpanded = fn(onExpandedPathsChange);
  const handleActivate = fn(onActivate);

  const select = (row: FlatTreeRow) => {
    if (!selectionControlled) setOwnSelected(row.path);
    handleSelect?.(row.path, itemOf(row));
  };
  const toggle = (row: FlatTreeRow, expand: boolean) => {
    if (!row.isDirectory || expanded.has(row.path) === expand) return;
    const next = new Set(expanded);
    if (expand) next.add(row.path);
    else next.delete(row.path);
    const list = [...next];
    if (!expansionControlled) setOwnExpanded(list);
    handleExpanded?.(list);
  };
  const activate = handleActivate
    ? (row: FlatTreeRow) => handleActivate(row.path, itemOf(row))
    : undefined;

  const baseId = useId();
  const rowId = (path: string) => `${baseId}ft-${encodeURIComponent(path)}`;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });
  const [range, setRange] = useState<ListRange | null>(null);

  // Reveal only a cursor that moved or newly resolved: expanding a folder
  // shifts the index of every row below it, and scrolling for that would drag
  // the view off the folder just opened.
  const previous = useRef<{ path: string | null; found: boolean }>({ path: null, found: false });
  useEffect(() => {
    const before = previous.current;
    const found = cursorIndex >= 0;
    previous.current = { path: cursorPath, found };
    if (!found || (before.path === cursorPath && before.found)) return;
    virtuoso.current?.scrollIntoView({ index: cursorIndex, behavior: "auto" });
  }, [cursorIndex, cursorPath]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Node) || !container.current?.contains(target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const state = typeahead.current;
      const buffer = now - state.at > TYPEAHEAD_RESET_MS ? event.key : state.buffer + event.key;
      typeahead.current = { buffer, at: now };
      const match = resolveTypeahead(buffer, rows, cursorPath);
      const row = match === null ? undefined : rows.find((candidate) => candidate.path === match);
      if (row) {
        event.preventDefault();
        select(row);
      }
      return;
    }
    const intent = resolveTreeKey(event.key, rows, cursorPath);
    if (!intent) return;
    event.preventDefault();
    const row = rows.find((candidate) => candidate.path === intent.path);
    if (!row) return;
    if (intent.type === "select") select(row);
    else if (intent.type === "expand") toggle(row, true);
    else if (intent.type === "collapse") toggle(row, false);
    else activate?.(row);
  };

  const label = str(ariaLabel) ?? "";
  const rootAttributes = pickRootProps(props, { aria: true });
  if (rows.length === 0 && hasContent(empty)) {
    return (
      <div {...pickRootProps(props)} className={cn("h-full", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const mounted =
    cursorIndex >= 0 &&
    range !== null &&
    cursorIndex >= range.startIndex &&
    cursorIndex <= range.endIndex;
  const context: TreeContext = { cursorPath, hasDirectories, rowId, select, toggle, activate };

  return (
    <div
      {...rootAttributes}
      ref={container}
      role="tree"
      aria-label={label}
      aria-activedescendant={mounted && cursorPath !== null ? rowId(cursorPath) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Rows never take focus (they unmount as they scroll away), so a click
      // pulls it to the one focus target and the arrow keys keep working.
      onPointerDown={() => container.current?.focus({ preventScroll: true })}
      // The global ring, drawn inset: the tree fills a clipped pane edge to edge.
      className={cn(
        "h-full min-h-0 w-full overflow-hidden focus-visible:-outline-offset-2",
        str(className)
      )}
    >
      <Virtuoso<FlatTreeRow, TreeContext>
        ref={virtuoso}
        data={rows}
        context={context}
        computeItemKey={rowKey}
        itemContent={renderRow}
        fixedItemHeight={TREE_ROW_HEIGHT_PX}
        rangeChanged={(next) =>
          setRange((current) =>
            current?.startIndex === next.startIndex && current.endIndex === next.endIndex
              ? current
              : next
          )
        }
        className="h-full w-full overflow-y-auto"
      />
    </div>
  );
}

export const pluginKitFileTree = { FileTree: KitFileTree };
