import { OperationError, type OperationKind } from "@daintreehq/plugin-sdk/operations";
import { renderReportSvg } from "./report";
import type { RequestStore } from "./store";

export interface ReportInput {
  /** Who asked, for the task title only. */
  requestedBy: "view" | "agent";
}

export interface ReportResult {
  reportId: string;
  requestCount: number;
}

export interface SyntheticProviderDeps {
  openStore: () => Promise<RequestStore>;
  /** The connected workspace, or null when the user hasn't connected one. */
  workspace: () => Promise<string | null>;
  /** Write the finished report and return the path it was written to. */
  writeReport: (reportId: string, svg: string) => Promise<string>;
  now?: () => number;
  /** How long a job takes to "build", so the demo has time to show progress. */
  buildMs?: number;
  pollIntervalMs?: number;
}

interface JobRow {
  idempotency_key: string;
  provider_id: string;
  submitted_at: number;
  ready_at: number;
  cancelled: number;
  report_id: string | null;
}

const REPORT_REQUEST_LIMIT = 500;

/**
 * A stand-in for a remote report API, shaped like a real one: it accepts a
 * job, answers polls until the job is done, can be asked whether it already
 * has a job for an idempotency key, and can be asked to cancel. Its jobs live
 * in the project database rather than in memory, so a worker restart in the
 * middle of a build finds the job again exactly as a real provider would.
 * Swap this object for your provider's client; nothing else changes.
 */
export function syntheticReportKind(
  deps: SyntheticProviderDeps
): OperationKind<ReportInput, ReportResult> {
  const now = deps.now ?? Date.now;
  const buildMs = deps.buildMs ?? 6_000;

  async function jobBy(column: "idempotency_key" | "provider_id", value: string) {
    const store = await deps.openStore();
    return (await store.db.get(`SELECT * FROM provider_jobs WHERE ${column} = ?`, [value])) as
      JobRow | undefined;
  }

  return {
    title: (input) =>
      input.requestedBy === "agent" ? "Building a report for an agent" : "Building a report",
    pollIntervalMs: deps.pollIntervalMs ?? 1_000,
    deadlineMs: 10 * 60_000,
    provider: {
      async submit(_input, { idempotencyKey }) {
        // A credential check, as a real provider's 401 would be: final, not retried.
        if (!(await deps.workspace())) {
          throw new OperationError(
            "NOT_CONNECTED",
            "Connect the report provider in Request Desk's settings, then build the report again.",
            { retryable: false }
          );
        }
        const existing = await jobBy("idempotency_key", idempotencyKey);
        if (existing) return { providerId: existing.provider_id };
        const providerId = `job-${crypto.randomUUID()}`;
        const at = now();
        const store = await deps.openStore();
        await store.db.run(
          "INSERT INTO provider_jobs (idempotency_key, provider_id, submitted_at, ready_at) VALUES (?, ?, ?, ?)",
          [idempotencyKey, providerId, at, at + buildMs]
        );
        return { providerId };
      },

      async poll({ providerId }) {
        const job = await jobBy("provider_id", providerId);
        if (!job)
          return { status: "failed", message: "The provider has no record of this report." };
        if (job.cancelled) return { status: "cancelled" };
        const store = await deps.openStore();
        if (job.report_id) {
          const report = (await store.db.get("SELECT request_count FROM reports WHERE id = ?", [
            job.report_id,
          ])) as { request_count: number } | undefined;
          return {
            status: "succeeded",
            result: { reportId: job.report_id, requestCount: report?.request_count ?? 0 },
          };
        }
        const at = now();
        if (at < job.ready_at) {
          const span = Math.max(1, job.ready_at - job.submitted_at);
          return {
            status: "running",
            progress: { fraction: Math.min(0.95, (at - job.submitted_at) / span) },
          };
        }
        const requests = await store.snapshot(REPORT_REQUEST_LIMIT);
        const reportId = `report-${job.provider_id.slice(4, 12)}`;
        const path = await deps.writeReport(
          reportId,
          renderReportSvg(requests, new Date(job.ready_at).toISOString())
        );
        await store.db.transaction(async (tx) => {
          await tx.run(
            "INSERT OR REPLACE INTO reports (id, path, request_count, created_at) VALUES (?, ?, ?, ?)",
            [reportId, path, requests.length, new Date(at).toISOString()]
          );
          await tx.run("UPDATE provider_jobs SET report_id = ? WHERE provider_id = ?", [
            reportId,
            providerId,
          ]);
        });
        return { status: "succeeded", result: { reportId, requestCount: requests.length } };
      },

      async reconcile(_input, { idempotencyKey }) {
        const job = await jobBy("idempotency_key", idempotencyKey);
        return job ? { status: "found", providerId: job.provider_id } : { status: "not-found" };
      },

      async cancel({ providerId }) {
        const store = await deps.openStore();
        const { changes } = await store.db.run(
          "UPDATE provider_jobs SET cancelled = 1 WHERE provider_id = ? AND report_id IS NULL",
          [providerId]
        );
        // A finished job can't be cancelled; the next poll reports the success.
        return changes > 0 ? "cancelled" : "requested";
      },
    },
  };
}
