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
import { forwardRef, isValidElement, type ReactNode } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { PluginIconName, PluginIconProps } from "@shared/types/plugin-sdk-react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
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

/**
 * The glyph for `name`, or `undefined` for anything else. `Object.hasOwn`
 * because the name is plugin input: a bare index would resolve `"toString"`.
 */
export function resolvePluginKitIcon(name: unknown): PluginKitGlyph | undefined {
  if (isPluginKitIconName(name)) return ICONS[name];
  if (name !== undefined && name !== null) warnUnknownIcon(name);
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
  const Glyph = resolvePluginKitIcon(name);
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
 * Typed `unknown` because untyped JS can send anything here.
 */
export function renderIconSource(source: unknown): ReactNode {
  if (typeof source === "string") {
    const Glyph = resolvePluginKitIcon(source);
    return Glyph ? <Glyph aria-hidden="true" /> : null;
  }
  // Anything else (a plain object, a number) is not a node React can render
  // safely, so only a real element passes.
  return isValidElement(source) ? source : null;
}
