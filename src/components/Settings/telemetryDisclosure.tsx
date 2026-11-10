import { cn } from "@/lib/utils";

interface CrashReportGroup {
  label: string;
  /** Frames a group whose fields only make sense together. */
  lead?: string;
  fields: readonly string[];
}

/**
 * What a crash report contains, worded once for both places that disclose it:
 * Settings → Privacy & data, and the first-run wizard's crash-reporting step.
 */
export const CRASH_REPORT_CONTENTS: readonly CrashReportGroup[] = [
  {
    label: "Error details",
    fields: [
      "Exception type and message (home directory redacted)",
      "Stack frames with sanitized file paths, line and column numbers",
    ],
  },
  {
    label: "App and device",
    fields: [
      "App version, Node.js version, and build environment (production or development)",
      "Operating system name, version, and architecture",
      "Default runtime metadata provided by the Sentry Electron SDK (CPU, memory, GPU, locale, timezone, and similar vendor-supplied fields)",
    ],
  },
  {
    label: "Location",
    fields: [
      "Approximate location (city and country), which Sentry looks up from your connection's IP address when a report arrives; the IP address itself isn't stored with the report",
    ],
  },
  {
    label: "Recent activity",
    lead: "Breadcrumbs from the main and renderer processes leading up to the crash:",
    fields: [
      "App, window, screen, power and update lifecycle events",
      "Console logs, network requests and app actions",
      "Page navigation, and clicks and key presses on page elements",
      "Child-process and utility-process exits and errors",
      "Earlier error reports",
    ],
  },
  {
    label: "Redacted",
    fields: [
      "Network request and navigation URLs reduced to their origin, with paths, query strings and fragments removed",
      "Email addresses, home-directory usernames and repository names in SSH remotes redacted from messages, breadcrumbs, and error details",
    ],
  },
];

/** Left out of a crash report, as Settings states for every level and for Errors only. */
const CRASH_REPORT_NOT_SENT: CrashReportGroup = {
  label: "Not sent",
  fields: ["File contents, prompts and credentials", "Usage analytics"],
};

export function CrashReportContents({
  showNotSent = false,
  className,
}: {
  /** The wizard states what stays behind here; Settings already says it above the levels. */
  showNotSent?: boolean;
  className?: string;
}) {
  const groups = showNotSent
    ? [...CRASH_REPORT_CONTENTS, CRASH_REPORT_NOT_SENT]
    : CRASH_REPORT_CONTENTS;
  return (
    <dl
      className={cn(
        "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-xs select-text",
        className
      )}
    >
      {groups.map((group) => (
        <div key={group.label} className="contents">
          <dt className="font-medium text-text-primary">{group.label}</dt>
          <dd className="space-y-1 text-text-secondary">
            {group.lead && <p>{group.lead}</p>}
            {/* Markers hang in the column gap, so a lead line, the bullets and
                their wrapped lines all share one text edge. */}
            <ul className="list-disc space-y-1">
              {group.fields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}
