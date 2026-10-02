import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  AtSign,
  Banknote,
  Bell,
  BellDot,
  Bookmark,
  BookOpen,
  Bot,
  Braces,
  Bug,
  CalendarDays,
  Car,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clipboard,
  Clock,
  Cloud,
  CloudOff,
  Code,
  Coins,
  Copy,
  CreditCard,
  Database,
  Download,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileCode,
  FileDiff,
  FileExclamationPoint,
  FilePlus,
  FileText,
  Flame,
  FlaskConical,
  Folder,
  FolderCode,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  FolderTree,
  FolderX,
  Gauge,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompare,
  GitFork,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Globe,
  GripVertical,
  Hash,
  Heart,
  History,
  Hourglass,
  House,
  Icon as LucideFrame,
  Image,
  Import,
  Inbox,
  Info,
  KeyRound,
  Landmark,
  Layers,
  LayoutGrid,
  LayoutPanelTop,
  Lightbulb,
  Link,
  Link2Off,
  List,
  ListChecks,
  ListFilter,
  ListTodo,
  LoaderCircle,
  Lock,
  LockOpen,
  Mail,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  Monitor,
  MonitorPlay,
  MousePointer2,
  NotebookPen,
  OctagonAlert,
  Package,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Percent,
  PiggyBank,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  Puzzle,
  Receipt,
  Redo2,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  Scale,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheckBig,
  SquareDashedMousePointer,
  SquareTerminal,
  Star,
  StickyNote,
  Table,
  Tag,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Undo2,
  Unplug,
  Upload,
  User,
  UserPlus,
  Users,
  Wallet,
  WifiOff,
  Workflow,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  isValidElement,
  use,
  useEffect,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { PluginIconName, PluginIconProps } from "@shared/types/plugin-sdk-react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { cn } from "@/lib/utils";
import { pickRootProps } from "./kitProps";
import { warnPluginAuthor } from "./kitDiagnostics";

export type PluginKitGlyph = LucideIcon;

// Lucide's shape for the app mark, so every kit slot that hands an icon to a
// host component (SpinningIcon, Callout) takes it like any other glyph. The mark
// sizes itself from `size` and is always aria-hidden, so a named one is wrapped.
const DaintreeGlyph: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(function DaintreeGlyph(
  { width, className, "aria-label": ariaLabel, role },
  _ref
) {
  const mark = (
    <DaintreeIcon size={typeof width === "number" ? width : undefined} className={className} />
  );
  if (!ariaLabel) return mark;
  return (
    <span role={role ?? "img"} aria-label={ariaLabel} className="inline-flex">
      {mark}
    </span>
  );
});

// Typed against the public union so a name the SDK advertises without a glyph,
// or a glyph with no public name, is a typecheck failure.
const ICONS: Record<PluginIconName, PluginKitGlyph> = {
  activity: Activity,
  "alert-octagon": OctagonAlert,
  "alert-triangle": TriangleAlert,
  "arrow-down": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  "arrow-up-right": ArrowUpRight,
  "at-sign": AtSign,
  banknote: Banknote,
  bell: Bell,
  "bell-dot": BellDot,
  "book-open": BookOpen,
  bookmark: Bookmark,
  bot: Bot,
  braces: Braces,
  bug: Bug,
  calendar: CalendarDays,
  car: Car,
  "chart-column": ChartColumn,
  "chart-line": ChartLine,
  "chart-pie": ChartPie,
  check: Check,
  "check-square": SquareCheckBig,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "chevrons-up-down": ChevronsUpDown,
  "circle-check": CircleCheck,
  "circle-dashed": CircleDashed,
  "circle-dot": CircleDot,
  "circle-slash": CircleSlash,
  "circle-x": CircleX,
  clipboard: Clipboard,
  clock: Clock,
  cloud: Cloud,
  "cloud-off": CloudOff,
  code: Code,
  coins: Coins,
  copy: Copy,
  "credit-card": CreditCard,
  daintree: DaintreeGlyph,
  database: Database,
  download: Download,
  "external-link": ExternalLink,
  eye: Eye,
  "eye-off": EyeOff,
  file: File,
  "file-code": FileCode,
  "file-diff": FileDiff,
  "file-plus": FilePlus,
  "file-text": FileText,
  "file-warning": FileExclamationPoint,
  filter: ListFilter,
  flame: Flame,
  flask: FlaskConical,
  folder: Folder,
  "folder-code": FolderCode,
  "folder-open": FolderOpen,
  "folder-search": FolderSearch,
  "folder-tree": FolderTree,
  "folder-x": FolderX,
  gauge: Gauge,
  "git-branch": GitBranch,
  "git-branch-plus": GitBranchPlus,
  "git-commit": GitCommitHorizontal,
  "git-compare": GitCompare,
  "git-fork": GitFork,
  "git-merge": GitMerge,
  "git-merge-conflict": GitMergeConflict,
  "git-pull-request": GitPullRequest,
  "git-pull-request-closed": GitPullRequestClosed,
  "git-pull-request-draft": GitPullRequestDraft,
  globe: Globe,
  "grip-vertical": GripVertical,
  hash: Hash,
  heart: Heart,
  help: CircleHelp,
  history: History,
  home: House,
  hourglass: Hourglass,
  image: Image,
  import: Import,
  inbox: Inbox,
  info: Info,
  key: KeyRound,
  landmark: Landmark,
  layers: Layers,
  "layout-grid": LayoutGrid,
  "layout-panel-top": LayoutPanelTop,
  lightbulb: Lightbulb,
  link: Link,
  list: List,
  "list-checks": ListChecks,
  "list-todo": ListTodo,
  loader: LoaderCircle,
  lock: Lock,
  mail: Mail,
  maximize: Maximize2,
  menu: Menu,
  "message-square": MessageSquare,
  minimize: Minimize2,
  minus: Minus,
  monitor: Monitor,
  "monitor-play": MonitorPlay,
  "more-horizontal": Ellipsis,
  "more-vertical": EllipsisVertical,
  "mouse-pointer": MousePointer2,
  notebook: NotebookPen,
  package: Package,
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  "panel-right-close": PanelRightClose,
  "panel-right-open": PanelRightOpen,
  paperclip: Paperclip,
  pause: Pause,
  pencil: Pencil,
  percent: Percent,
  "piggy-bank": PiggyBank,
  pin: Pin,
  "pin-off": PinOff,
  play: Play,
  plug: Plug,
  plus: Plus,
  puzzle: Puzzle,
  receipt: Receipt,
  redo: Redo2,
  refresh: RefreshCw,
  rocket: Rocket,
  "rotate-ccw": RotateCcw,
  "rotate-cw": RotateCw,
  save: Save,
  scale: Scale,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  share: Share2,
  shield: Shield,
  sliders: SlidersHorizontal,
  sort: ArrowUpDown,
  sparkles: Sparkles,
  square: Square,
  "square-dashed-mouse-pointer": SquareDashedMousePointer,
  star: Star,
  "sticky-note": StickyNote,
  table: Table,
  tag: Tag,
  target: Target,
  terminal: SquareTerminal,
  trash: Trash2,
  "trending-down": TrendingDown,
  "trending-up": TrendingUp,
  undo: Undo2,
  unlink: Link2Off,
  unlock: LockOpen,
  unplug: Unplug,
  upload: Upload,
  user: User,
  "user-plus": UserPlus,
  users: Users,
  wallet: Wallet,
  "wifi-off": WifiOff,
  workflow: Workflow,
  worktree: FolderGit2,
  wrench: Wrench,
  x: X,
  zap: Zap,
};

export function isPluginKitIconName(name: unknown): name is PluginIconName {
  return typeof name === "string" && Object.hasOwn(ICONS, name);
}

export const PLUGIN_KIT_ICON_NAMES: PluginIconName[] =
  Object.keys(ICONS).filter(isPluginKitIconName);

const warnedNames = new Set<string>();

function warnUnknownIcon(name: unknown): void {
  if (!import.meta.env.DEV) return;
  const key = String(name);
  if (warnedNames.has(key)) return;
  warnedNames.add(key);
  warnPluginAuthor(`Unknown icon name ${JSON.stringify(key)}; rendering nothing.`);
}

// Lucide's own names: kebab-case words and digits ("grid-2x2", "arrow-down-0-1").
// Anything else cannot be in the map, so it is refused without loading it.
const LUCIDE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type LucideImports = Record<string, () => Promise<{ default: PluginKitGlyph }>>;

// The name-to-module map is itself ~2,000 entries, so it is fetched on the
// first name outside the curated set rather than with the kit; each icon is
// then its own chunk, fetched once and kept for the life of the view. A glyph
// is `null` once the map says the name is not Lucide's, and absent until then.
let lucideImports: LucideImports | undefined;
let lucideImportsLoad: Promise<LucideImports> | undefined;
const lucideGlyphs = new Map<string, PluginKitGlyph | null>();
const lucideLoads = new Map<string, Promise<void>>();
const lucideListeners = new Set<() => void>();

function loadLucideImports(): Promise<LucideImports> {
  lucideImportsLoad ??= import("lucide-react/dynamicIconImports").then(
    (module) => {
      const imports: LucideImports = module.default;
      lucideImports = imports;
      return imports;
    },
    (error: unknown) => {
      // A failed fetch is not a verdict on the name: the next use tries again.
      lucideImportsLoad = undefined;
      throw error;
    }
  );
  return lucideImportsLoad;
}

function loadLucideGlyph(name: string): void {
  if (lucideGlyphs.has(name) || lucideLoads.has(name)) return;
  const load = loadLucideImports()
    .then(async (imports) => {
      const importGlyph = Object.hasOwn(imports, name) ? imports[name] : undefined;
      const glyph = importGlyph ? (await importGlyph()).default : null;
      lucideGlyphs.set(name, glyph);
      if (!glyph) warnUnknownIcon(name);
      for (const listener of lucideListeners) listener();
    })
    .catch(() => {
      // Offline or a chunk that failed: the frame stays, and the next frame
      // drawn for this name tries again; every drawn one then fills in.
    })
    .finally(() => {
      lucideLoads.delete(name);
    });
  lucideLoads.set(name, load);
}

function subscribeLucideGlyphs(listener: () => void): () => void {
  lucideListeners.add(listener);
  return () => {
    lucideListeners.delete(listener);
  };
}

const LucideGlyphByName = forwardRef<SVGSVGElement, LucideProps & { lucideName: string }>(
  function LucideGlyphByName({ lucideName, ...props }, ref) {
    const Glyph = useSyncExternalStore(subscribeLucideGlyphs, () => lucideGlyphs.get(lucideName));
    useEffect(() => {
      if (Glyph === undefined) loadLucideGlyph(lucideName);
    }, [Glyph, lucideName]);
    if (Glyph === null) return null;
    if (Glyph) return <Glyph {...props} ref={ref} />;
    // Lucide's own frame with nothing in it: the same box, classes and sizing
    // as the glyph that replaces it, so nothing moves when it lands.
    return <LucideFrame {...props} ref={ref} iconNode={[]} data-kit-icon-loading="" />;
  }
);

const lazyGlyphs = new Map<string, PluginKitGlyph>();

// One component per name, in the shape every glyph slot takes, so a glyph
// that is still loading keeps its identity when it arrives.
function lazyLucideGlyph(name: string): PluginKitGlyph {
  let glyph = lazyGlyphs.get(name);
  if (!glyph) {
    glyph = forwardRef<SVGSVGElement, LucideProps>(function LucideGlyph(props, ref) {
      return <LucideGlyphByName {...props} ref={ref} lucideName={name} />;
    });
    lazyGlyphs.set(name, glyph);
  }
  return glyph;
}

const ICON_BOX_CLASS = "inline-flex shrink-0 [&>svg]:size-full";

// A host slot that takes a glyph (SpinningIcon, Callout) takes a component,
// not an element, so a plugin's element reaches it through context: one
// stable glyph component reads it, and a new element each render updates the
// icon in place rather than remounting it.
const IconElementContext = createContext<ReactElement | null>(null);

const ElementGlyph = forwardRef<SVGSVGElement, LucideProps>(function ElementGlyph(
  { width, height, size, className, "aria-label": ariaLabel, role, ...rest },
  _ref
) {
  const element = use(IconElementContext);
  if (!element) return null;
  const side = (value: unknown) =>
    typeof value === "number" || typeof value === "string" ? value : undefined;
  const w = side(width) ?? side(size);
  const h = side(height) ?? side(size);
  return (
    <span
      {...pickRootProps(rest)}
      {...(ariaLabel ? { role: role ?? "img", "aria-label": ariaLabel } : { "aria-hidden": true })}
      className={cn(ICON_BOX_CLASS, className)}
      style={w === undefined && h === undefined ? undefined : { width: w, height: h }}
    >
      {element}
    </span>
  );
});

/**
 * Wraps a host component that draws the glyph `resolvePluginKitIcon(source)`
 * gave it, so a plugin's own element reaches that glyph.
 */
export function PluginKitIconScope({ source, children }: { source: unknown; children: ReactNode }) {
  if (!isValidElement(source)) return children;
  return <IconElementContext value={source}>{children}</IconElementContext>;
}

/**
 * The glyph for an icon source, or `undefined` when there is none: a curated
 * name draws at once, any other Lucide name loads on first use (an empty frame
 * of the same size until then), and the plugin's own element is boxed to the
 * slot's size, drawn inside a {@link PluginKitIconScope} for that source.
 * `Object.hasOwn` because the name is plugin input: a bare index would resolve
 * `"toString"`.
 */
export function resolvePluginKitIcon(source: unknown): PluginKitGlyph | undefined {
  if (typeof source === "string") {
    if (isPluginKitIconName(source)) return ICONS[source];
    // Once the map is in hand a name it lacks is refused without a render.
    const listed = lucideImports === undefined || Object.hasOwn(lucideImports, source);
    if (lucideGlyphs.get(source) !== null && listed && LUCIDE_NAME.test(source)) {
      return lazyLucideGlyph(source);
    }
    warnUnknownIcon(source);
    return undefined;
  }
  if (isValidElement(source)) return ElementGlyph;
  if (source !== undefined && source !== null) warnUnknownIcon(source);
  return undefined;
}

function sanitizeSize(size: unknown, fallback: number): number {
  return typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 512
    ? size
    : fallback;
}

export function PluginKitIcon({
  name,
  size,
  className,
  "aria-label": ariaLabel,
  ...rest
}: PluginIconProps) {
  // A name only: an element here is a misuse the type already refuses.
  const Glyph = isValidElement(name) ? undefined : resolvePluginKitIcon(name);
  if (!Glyph) return null;
  const px = sanitizeSize(size, 16);
  const label = typeof ariaLabel === "string" && ariaLabel ? ariaLabel : undefined;
  return (
    <Glyph
      {...pickRootProps(rest)}
      width={px}
      height={px}
      className={typeof className === "string" ? className : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

/**
 * An icon prop that is either a name or the plugin's own element. Strings are
 * always read as names, so a typo renders nothing rather than stray text.
 * With `className` a name's glyph takes it, and an element is boxed in it and
 * fills it; without, an element renders as given. Typed `unknown` because
 * untyped JS can send anything here.
 */
export function renderIconSource(source: unknown, className?: string): ReactNode {
  if (typeof source === "string") {
    const Glyph = resolvePluginKitIcon(source);
    return Glyph ? <Glyph className={className} aria-hidden="true" /> : null;
  }
  // Anything else (a plain object, a number) is not a node React can render
  // safely, so only a real element passes.
  if (!isValidElement(source)) return null;
  if (className === undefined) return source;
  return (
    <span aria-hidden="true" className={cn(ICON_BOX_CLASS, className)}>
      {source}
    </span>
  );
}
