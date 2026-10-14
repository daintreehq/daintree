import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { LifecycleCommandReview } from "@shared/types/worktree";

/**
 * Imported FIRST by `lifecycleApprovalPreview.tsx`, so `window.electron` exists
 * before `worktreeClient` reads it. Answers the two worktree-port requests the
 * approval dialog makes; everything else on the bridge stays inert.
 */

const params = new URLSearchParams(window.location.search);
export const previewState = params.get("state") ?? "mixed";

const CONFIG = "/Users/you/Code/helios-dashboard/.daintree/config.json";
const SETTINGS = "/Users/you/Code/helios-dashboard/.daintree/settings.json";

const REVIEWS: Record<string, LifecycleCommandReview | null> = {
  single: {
    fingerprint: "a".repeat(64),
    sources: [{ path: CONFIG, groups: [{ label: "Setup", commands: ["npm ci"] }] }],
  },
  mixed: {
    fingerprint: "b".repeat(64),
    provisionAfterSetup: "Resource provision",
    sources: [
      {
        path: CONFIG,
        groups: [
          {
            label: "Setup",
            commands: ["npm ci", "cp .env.example .env.local", "npm run db:migrate"],
          },
          { label: "Teardown", commands: ["docker compose down --volumes"] },
          { label: "Resource provision", commands: ["./scripts/sandbox.sh up"] },
          { label: "Resource teardown", commands: ["./scripts/sandbox.sh down"] },
          { label: "Resource status", commands: ["./scripts/sandbox.sh status --json"] },
        ],
      },
    ],
  },
  long: {
    fingerprint: "c".repeat(64),
    sources: [
      {
        path: CONFIG,
        groups: [
          {
            label: "Setup",
            commands: [
              "pnpm install --frozen-lockfile --prefer-offline --reporter=append-only --config.node-linker=hoisted",
              'if [ ! -f .env.local ]; then\n  cp .env.example .env.local\n  echo "DATABASE_URL=postgres://localhost:5432/helios_$(git rev-parse --abbrev-ref HEAD | tr / _)" >> .env.local\nfi',
              "curl -fsSL https://raw.githubusercontent.com/helios-labs/dev-tooling/main/bootstrap/install-toolchain.sh | bash -s -- --channel=stable --with-node=22.23.2",
            ],
          },
          {
            label: "Teardown",
            commands: [
              'docker compose -p "helios-$(basename "$PWD")" down --volumes --remove-orphans && rm -rf .turbo node_modules/.cache',
            ],
          },
        ],
      },
      {
        path: SETTINGS,
        groups: [
          {
            label: 'Environment "staging" provision',
            commands: [
              "aws ecs run-task --cluster helios-preview --task-definition helios-api-preview:42 --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[subnet-0a1b2c3d4e5f60718],securityGroups=[sg-0123456789abcdef0],assignPublicIp=ENABLED}'",
            ],
          },
          {
            label: 'Environment "staging" teardown',
            commands: [
              'aws ecs stop-task --cluster helios-preview --task "$(cat .daintree/task-arn)"',
            ],
          },
        ],
      },
    ],
  },
  many: {
    fingerprint: "d".repeat(64),
    sources: [
      {
        path: CONFIG,
        groups: [
          {
            label: "Setup",
            commands: [
              "corepack enable",
              "pnpm install --frozen-lockfile",
              "pnpm -w run build:packages",
              "cp .env.example .env.local",
              "pnpm db:generate",
              "pnpm db:migrate",
              "pnpm db:seed --fixtures=dev",
              "git submodule update --init --recursive",
            ],
          },
          {
            label: "Teardown",
            commands: [
              "pnpm db:drop --force",
              "docker compose down --volumes",
              "rm -rf .next .turbo",
            ],
          },
          { label: "Resource provision", commands: ["./scripts/sandbox.sh up --size=large"] },
          { label: "Resource teardown", commands: ["./scripts/sandbox.sh down"] },
          { label: "Resource resume", commands: ["./scripts/sandbox.sh resume"] },
          { label: "Resource pause", commands: ["./scripts/sandbox.sh pause"] },
          { label: "Resource status", commands: ["./scripts/sandbox.sh status --json"] },
          { label: "Resource connect", commands: ["./scripts/sandbox.sh ssh"] },
          { label: "Resource provider", commands: ["fly"] },
          { label: 'Resource "gpu" provision', commands: ["modal deploy infra/gpu.py"] },
          { label: 'Resource "gpu" teardown', commands: ["modal app stop helios-gpu"] },
        ],
      },
      {
        path: SETTINGS,
        groups: [
          {
            label: 'Environment "staging" provision',
            commands: ["fly deploy --app helios-staging"],
          },
          {
            label: 'Environment "staging" teardown',
            commands: ["fly scale count 0 --app helios-staging"],
          },
        ],
      },
    ],
  },
  nothing: null,
};
REVIEWS["later"] = REVIEWS.mixed ?? null;
REVIEWS["approve-error"] = REVIEWS.mixed ?? null;

const never = <T>() => new Promise<T>(() => {});
const later = <T>(value: T, ms = 30) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const failLater = (message: string, ms = 30) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));

export const LOAD_ERROR =
  "Worktree not found: /Users/you/Code/helios-dashboard-worktrees/feature-auth-refresh";
export const APPROVE_ERROR = "These commands changed after you reviewed them. Review them again.";

installPreviewShims({
  worktreePort: new Proxy(
    {
      request: (op: string) => {
        if (op === "get-lifecycle-command-approval") {
          if (previewState === "loading") return never();
          if (previewState === "load-error") return failLater(LOAD_ERROR);
          return later({ review: previewState in REVIEWS ? REVIEWS[previewState] : REVIEWS.mixed });
        }
        if (op === "approve-lifecycle-commands") {
          return previewState === "approve-error" ? failLater(APPROVE_ERROR) : never();
        }
        return later(undefined);
      },
    },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => later(undefined)) }
  ),
});
