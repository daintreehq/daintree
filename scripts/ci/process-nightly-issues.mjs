const METADATA_MARKER = /<!-- METADATA:\s*(\{[\s\S]*?\})\s*-->/;
const SIGNATURE_LENGTH = 12;
const ESCALATION_THRESHOLD = 3;
const STALE_DAYS = 14;
const BUCKET_LABELS = [
  "core",
  "full-terminal",
  "full-worktree",
  "full-presets",
  "full-platform",
  "full-panels",
  "full-resilience",
  "online",
  "nightly",
];

export function parseMetadata(body) {
  if (!body) return null;
  const match = body.match(METADATA_MARKER);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed?.signature !== "string" || parsed.signature.length !== SIGNATURE_LENGTH) {
      return null;
    }
    return {
      signature: parsed.signature,
      consecutive_failures:
        typeof parsed.consecutive_failures === "number" ? parsed.consecutive_failures : 1,
      first_seen: parsed.first_seen ?? null,
      last_seen: parsed.last_seen ?? null,
      last_seen_run_id:
        typeof parsed.last_seen_run_id === "number" ? parsed.last_seen_run_id : null,
      last_green_run_url: parsed.last_green_run_url ?? null,
    };
  } catch {
    return null;
  }
}

export function buildMetadataBlock(metadata) {
  const json = JSON.stringify(metadata, null, 2);
  return `<!-- METADATA:\n${json}\n-->`;
}

export function buildIssueTitle(report) {
  const context = report.titlePath.slice(1).join(" › ");
  const display = context.length > 60 ? context.slice(0, 57) + "..." : context;
  return `[Nightly] ${report.projectName}: ${display}`;
}

export function buildIssueBody(report, metadata, runUrl) {
  const titlePathDisplay = report.titlePath.join(" › ");
  const osLabel = report.os ?? "unknown";
  const lines = [
    `**Suite:** ${report.projectName}`,
    `**Test:** ${titlePathDisplay}`,
    `**File:** ${report.file}`,
    `**OS:** ${osLabel}`,
    ``,
    `**Run:** ${runUrl}`,
    ``,
    "```",
    report.rawError?.trim() || report.normalizedError,
    "```",
    "",
    `First seen: ${metadata.first_seen ?? "now"} | Consecutive failures: ${metadata.consecutive_failures}`,
    "",
    report.rawError
      ? `<details><summary>Normalized error (for dedup)</summary>\n\n\`\`\`\n${report.normalizedError}\n\`\`\`\n</details>`
      : "",
    "",
    buildMetadataBlock(metadata),
  ];
  return lines.join("\n");
}

export function buildRecoveredComment(runUrl) {
  return [
    "This failure did not recur in the latest nightly run. Closing as resolved.",
    "",
    `**Run:** ${runUrl}`,
  ].join("\n");
}

export function buildEscalationComment() {
  return "This failure has occurred 3 or more consecutive times. Adding `human-review` label — it needs manual investigation.";
}

export function nextMetadata(existing, report, runId, runUrl, today) {
  if (existing && existing.last_seen_run_id === runId) {
    return existing;
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const wasConsecutive = existing?.last_seen && existing.last_seen.startsWith(yesterdayStr);

  return {
    signature: report.signature,
    consecutive_failures: wasConsecutive ? existing.consecutive_failures + 1 : 1,
    first_seen: existing?.first_seen ?? today,
    last_seen: today,
    last_seen_run_id: runId,
    last_green_run_url: existing?.last_green_run_url ?? null,
  };
}

export function shouldEscalateToHumanReview(metadata) {
  return metadata.consecutive_failures >= ESCALATION_THRESHOLD;
}

export function shouldCloseOnGreen(issueMeta, today) {
  if (!issueMeta?.last_seen) return false;
  return issueMeta.last_seen < today;
}

export function shouldStaleClose(issueMeta, today) {
  if (!issueMeta?.last_seen) return false;
  const lastSeen = new Date(issueMeta.last_seen);
  const now = new Date(today);
  const diffDays = (now - lastSeen) / (1000 * 60 * 60 * 24);
  return diffDays > STALE_DAYS;
}

export function findIssueBySignature(parsedIssues, signature) {
  return parsedIssues.find((i) => i.metadata?.signature === signature);
}

export function deduplicateReports(reports) {
  const seen = new Map();
  const merged = [];
  for (const report of reports) {
    const existing = seen.get(report.signature);
    if (existing) {
      if (!existing.oses) existing.oses = [existing.os ?? "unknown"];
      existing.oses.push(report.os ?? "unknown");
    } else {
      seen.set(report.signature, { ...report });
      merged.push(report);
    }
  }
  return merged;
}

export function bucketLabelForSuite(suite) {
  return BUCKET_LABELS.includes(suite) ? [suite] : [];
}

const BASE_LABEL = "nightly-failure";
const HUMAN_REVIEW_LABEL = "human-review";

export function labelsForIssue(report) {
  const labels = [BASE_LABEL, ...bucketLabelForSuite(report.projectName)];
  return labels;
}

export function labelsForEscalation(metadata) {
  return shouldEscalateToHumanReview(metadata) ? [HUMAN_REVIEW_LABEL] : [];
}
