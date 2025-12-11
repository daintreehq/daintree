export interface BranchTypeColors {
  bg: string;
  border: string;
  text: string;
}

export interface BranchType {
  id: string;
  displayName: string;
  prefix: string;
  aliases: string[];
  colors: BranchTypeColors;
}

const COLORS = {
  teal: { bg: "bg-teal-500/10", border: "border-teal-500/30", text: "text-teal-400" },
  red: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400" },
  gray: { bg: "bg-canopy-border/20", border: "border-canopy-border", text: "text-canopy-text/60" },
  blue: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400" },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/30", text: "text-purple-400" },
  yellow: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-400" },
  orange: { bg: "bg-orange-500/10", border: "border-orange-500/30", text: "text-orange-400" },
} as const;

export const DEFAULT_BRANCH_TYPE: BranchType = {
  id: "other",
  displayName: "Other",
  prefix: "other",
  aliases: [],
  colors: COLORS.gray,
};

export const BRANCH_TYPES: BranchType[] = [
  {
    id: "feature",
    displayName: "Feature",
    prefix: "feature",
    aliases: ["feat"],
    colors: COLORS.teal,
  },
  {
    id: "bugfix",
    displayName: "Bugfix",
    prefix: "bugfix",
    aliases: ["fix", "hotfix"],
    colors: COLORS.red,
  },
  { id: "chore", displayName: "Chore", prefix: "chore", aliases: [], colors: COLORS.gray },
  { id: "docs", displayName: "Docs", prefix: "docs", aliases: ["doc"], colors: COLORS.blue },
  {
    id: "refactor",
    displayName: "Refactor",
    prefix: "refactor",
    aliases: ["refact"],
    colors: COLORS.purple,
  },
  { id: "test", displayName: "Test", prefix: "test", aliases: ["tests"], colors: COLORS.yellow },
  {
    id: "release",
    displayName: "Release",
    prefix: "release",
    aliases: ["rel"],
    colors: COLORS.orange,
  },
  { id: "ci", displayName: "CI", prefix: "ci", aliases: ["build"], colors: COLORS.blue },
  { id: "deps", displayName: "Deps", prefix: "deps", aliases: ["dependabot"], colors: COLORS.gray },
  { id: "perf", displayName: "Perf", prefix: "perf", aliases: [], colors: COLORS.purple },
  { id: "style", displayName: "Style", prefix: "style", aliases: [], colors: COLORS.blue },
  { id: "wip", displayName: "WIP", prefix: "wip", aliases: [], colors: COLORS.yellow },
];

export const BRANCH_PREFIX_MAP: Record<string, BranchType> = {};

BRANCH_TYPES.forEach((type) => {
  BRANCH_PREFIX_MAP[type.prefix.toLowerCase()] = type;
  type.aliases.forEach((alias) => {
    BRANCH_PREFIX_MAP[alias.toLowerCase()] = type;
  });
});
