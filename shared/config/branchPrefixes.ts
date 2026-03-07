import { BRANCH_TYPE_COLOR_CLASSES } from "../theme/index.js";

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
  teal: BRANCH_TYPE_COLOR_CLASSES.feature,
  red: BRANCH_TYPE_COLOR_CLASSES.bugfix,
  gray: BRANCH_TYPE_COLOR_CLASSES.neutral,
  amber: BRANCH_TYPE_COLOR_CLASSES.warm,
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
  { id: "docs", displayName: "Docs", prefix: "docs", aliases: ["doc"], colors: COLORS.gray },
  {
    id: "refactor",
    displayName: "Refactor",
    prefix: "refactor",
    aliases: ["refact"],
    colors: COLORS.amber,
  },
  { id: "test", displayName: "Test", prefix: "test", aliases: ["tests"], colors: COLORS.amber },
  {
    id: "release",
    displayName: "Release",
    prefix: "release",
    aliases: ["rel"],
    colors: COLORS.amber,
  },
  { id: "ci", displayName: "CI", prefix: "ci", aliases: ["build"], colors: COLORS.gray },
  { id: "deps", displayName: "Deps", prefix: "deps", aliases: ["dependabot"], colors: COLORS.gray },
  { id: "perf", displayName: "Perf", prefix: "perf", aliases: [], colors: COLORS.teal },
  { id: "style", displayName: "Style", prefix: "style", aliases: [], colors: COLORS.gray },
  { id: "wip", displayName: "WIP", prefix: "wip", aliases: [], colors: COLORS.amber },
];

export const BRANCH_PREFIX_MAP: Record<string, BranchType> = {};

BRANCH_TYPES.forEach((type) => {
  BRANCH_PREFIX_MAP[type.prefix.toLowerCase()] = type;
  type.aliases.forEach((alias) => {
    BRANCH_PREFIX_MAP[alias.toLowerCase()] = type;
  });
});
