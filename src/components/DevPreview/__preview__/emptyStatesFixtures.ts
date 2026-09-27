import type { RunCommand } from "@shared/types";
import type { DevServerError } from "@shared/utils/devServerErrors";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

/**
 * One state of the dev preview's non-webview body. Fields left out take the
 * defaults of an unconfigured project with nothing detected.
 */
export interface EmptyStateFixture {
  status: DevPreviewStatus;
  currentUrl?: string;
  isUnconfigured?: boolean;
  candidates?: RunCommand[];
  isAutoDetecting?: boolean;
  autoDetectFailedCommand?: string | null;
  pickerOpen?: boolean;
  commandInput?: string;
  devCommand?: string;
  error?: DevServerError;
  hasBeenVisible?: boolean;
  isEvicted?: boolean;
  isRestarting?: boolean;
  /** Pane size in CSS px; a real grid pane, not the whole window. */
  width?: number;
  height?: number;
  /** What the harness does before shooting. */
  drive?: "focus-primary" | "type-command";
}

const RUNNERS: RunCommand[] = [
  { id: "npm-dev", name: "dev", command: "npm run dev", icon: "npm" },
  { id: "npm-dev-https", name: "dev:https", command: "npm run dev:https", icon: "npm" },
  { id: "npm-storybook", name: "storybook", command: "npm run storybook", icon: "npm" },
];

export const EMPTY_STATE_FIXTURES = {
  detected: { status: "stopped", isUnconfigured: true, candidates: RUNNERS },
  "detected-single": { status: "stopped", isUnconfigured: true, candidates: RUNNERS.slice(0, 1) },
  "detected-focus": {
    status: "stopped",
    isUnconfigured: true,
    candidates: RUNNERS,
    drive: "focus-primary",
  },
  "detected-busy": {
    status: "stopped",
    isUnconfigured: true,
    candidates: RUNNERS,
    isAutoDetecting: true,
  },
  "detected-failed": {
    status: "stopped",
    isUnconfigured: true,
    candidates: RUNNERS,
    autoDetectFailedCommand: "npm run dev",
  },
  "detected-picker-open": {
    status: "stopped",
    isUnconfigured: true,
    candidates: RUNNERS,
    pickerOpen: true,
  },
  "detected-narrow": {
    status: "stopped",
    isUnconfigured: true,
    candidates: RUNNERS,
    width: 340,
  },
  "manual-empty": { status: "stopped", isUnconfigured: true },
  "manual-typed": { status: "stopped", isUnconfigured: true, drive: "type-command" },
  "manual-invalid": {
    status: "stopped",
    isUnconfigured: true,
    commandInput: "npm run dev\nnpm run api",
  },
  "restored-stopped": { status: "restored-stopped", devCommand: "pnpm dev --port 5174" },
  waiting: { status: "stopped", devCommand: "npm run dev" },
  "error-port": {
    status: "error",
    devCommand: "npm run dev",
    currentUrl: "http://localhost:3000",
    error: {
      type: "port-conflict",
      port: "3000",
      message: "Port 3000 is already in use. Stop the other server or use a different port.",
    },
  },
  "error-deps": {
    status: "error",
    devCommand: "npm run dev",
    error: { type: "missing-dependencies", module: "vite", message: "Missing dependency: vite" },
  },
  starting: { status: "starting", devCommand: "npm run dev" },
  "not-visible": {
    status: "running",
    currentUrl: "http://localhost:5173",
    devCommand: "npm run dev",
    hasBeenVisible: false,
  },
  evicted: {
    status: "running",
    currentUrl: "http://localhost:5173",
    devCommand: "npm run dev",
    isEvicted: true,
  },
} satisfies Record<string, EmptyStateFixture>;

export type EmptyStateFixtureName = keyof typeof EMPTY_STATE_FIXTURES;

export function isEmptyStateFixtureName(name: string): name is EmptyStateFixtureName {
  return Object.prototype.hasOwnProperty.call(EMPTY_STATE_FIXTURES, name);
}

export const EMPTY_STATE_FIXTURE_NAMES =
  Object.keys(EMPTY_STATE_FIXTURES).filter(isEmptyStateFixtureName);
