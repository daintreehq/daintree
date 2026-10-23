import type { PanelViewProps, PluginArtifact } from "@daintreehq/plugin-sdk";
import {
  Button,
  Callout,
  EmptyState,
  Heading,
  Input,
  ListRow,
  MediaThumbnail,
  PaneState,
  Select,
  Text,
  Textarea,
} from "@daintreehq/plugin-ui";
import { useCachedHostChannel } from "@daintreehq/plugin-sdk/react";
import { useEffect, useState, type ReactElement } from "react";
import {
  CHANNELS,
  EVENTS,
  REQUEST_STATUSES,
  type ReportSummary,
  type RequestRecord,
  type RequestStatus,
  type UpdateRequestResult,
} from "../contracts";
import { call, useConnection, useReports, useRequests } from "./data";
import { StatusBadge, STATUS_LABELS } from "./status";
import { draftFrom, draftStanding, encodeDraft, readDraft, type RequestDraft } from "./draft";

/**
 * Request Desk's Home: the list, the request the shared navigation points at,
 * and the reports. Selection lives in `navigation`, so picking a request here
 * selects it in the sidebar too, and the host restores it after a restart.
 * Without `navigation` (the application isn't in force, or the preview) the
 * view keeps its own selection instead.
 */
export default function Home(props: PanelViewProps): ReactElement {
  const { pluginId, navigation } = props;
  const requests = useRequests(pluginId);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [draft, setDraftState] = useState<RequestDraft | null>(() => readDraft(props.initialArgs));
  const [blocked, setBlocked] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const location = navigation?.location;
  const selectedId = navigation
    ? location?.sectionId === "request"
      ? String(location.params.requestId)
      : null
    : localSelection;
  const showReports = location?.sectionId === "reports";

  // A draft, restored or new, is unsaved work the host must not navigate
  // away from; it refuses with `unsaved` until the draft is saved or dropped.
  const hasDraft = draft !== null;
  const { setHasUnsavedChanges, persistState } = props;
  useEffect(() => {
    setHasUnsavedChanges?.(hasDraft);
  }, [hasDraft, setHasUnsavedChanges]);

  const setDraft = (next: RequestDraft | null) => {
    setDraftState(next);
    persistState?.(encodeDraft(next));
    if (next === null) setBlocked(false);
  };

  const select = (id: string | null) => {
    if (!navigation) {
      if (draft && draft.requestId !== id) {
        setBlocked(true);
        return;
      }
      setLocalSelection(id);
      return;
    }
    const result = navigation.navigate(
      id
        ? { sectionId: "request", params: { requestId: id }, reveal: false }
        : { sectionId: "requests", reveal: false }
    );
    // The host refuses to move while a view reports unsaved work; it moved
    // nothing, so ask the user to save or discard and let them try again.
    setBlocked(!result.ok && result.reason === "unsaved");
  };

  const addRequest = async () => {
    const title = newTitle.trim();
    if (!title) return;
    const created = await call<RequestRecord>(pluginId, CHANNELS.add, { title });
    setNewTitle("");
    select(created.id);
  };

  if (requests.error && !requests.data) {
    return (
      <PaneState
        kind="error"
        title="Couldn't open the requests"
        description={requests.error.message}
        onRetry={() => void requests.revalidate()}
      />
    );
  }
  if (!requests.data) return <PaneState kind="loading" title="Opening requests" />;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col gap-2 border-r border-border-default p-3">
        <Heading level={3}>Requests</Heading>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void addRequest();
          }}
        >
          <Input
            value={newTitle}
            onValueChange={setNewTitle}
            placeholder="New request"
            aria-label="New request title"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!newTitle.trim()}>
            Add
          </Button>
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {requests.data.length === 0 ? (
            <EmptyState
              scale="sidebar"
              title="No requests yet"
              description="Add one here, or ask an agent to."
            />
          ) : (
            requests.data.map((request) => (
              <ListRow
                key={request.id}
                title={request.title}
                meta={<StatusBadge status={request.status} />}
                selected={request.id === selectedId}
                onSelect={() => select(request.id)}
              />
            ))
          )}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {blocked && draft ? (
          <Callout severity="warning" title="Unsaved edits">
            Save or discard your edits to “{draft.title}” before opening another request.
          </Callout>
        ) : null}
        {draft && draft.requestId !== selectedId ? (
          <Callout
            severity="info"
            title="You have an unsaved edit"
            action={
              <Button size="xs" variant="outline" onClick={() => setDraft(null)}>
                Discard
              </Button>
            }
          >
            “{draft.title}” was being edited when Request Desk last closed.
          </Callout>
        ) : null}
        {selectedId ? (
          <RequestDetail
            pluginId={pluginId}
            requestId={selectedId}
            draft={draft?.requestId === selectedId ? draft : null}
            onDraft={setDraft}
            onGone={() => select(null)}
          />
        ) : null}
        {showReports || !selectedId ? <Reports pluginId={pluginId} /> : null}
      </main>
    </div>
  );
}

function RequestDetail(props: {
  pluginId: string;
  requestId: string;
  draft: RequestDraft | null;
  onDraft: (draft: RequestDraft | null) => void;
  onGone: () => void;
}): ReactElement {
  const { pluginId, requestId, draft, onDraft } = props;
  const current = useCachedHostChannel<{ id: string }, RequestRecord | null>(
    pluginId,
    CHANNELS.get,
    { id: requestId },
    { invalidateOn: EVENTS.requestsChanged }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (current.data === undefined) return <PaneState kind="loading" title="Opening the request" />;
  const request = current.data;
  const standing = draftStanding(draft, request);

  if (request === null) {
    return (
      <Callout
        severity="warning"
        title="This request no longer exists"
        action={
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onDraft(null);
              props.onGone();
            }}
          >
            Back to requests
          </Button>
        }
      >
        {standing === "orphaned"
          ? "It was removed while you were editing it, so your edit has nowhere to go."
          : "It was removed, perhaps by an agent."}
      </Callout>
    );
  }

  const shown = draft ?? draftFrom(request);
  const edit = (patch: Partial<RequestDraft>) => onDraft({ ...shown, ...patch });

  const save = async (base = shown.baseRevision) => {
    setSaving(true);
    setError(null);
    try {
      const result = await call<UpdateRequestResult>(pluginId, CHANNELS.update, {
        id: shown.requestId,
        revision: base,
        title: shown.title,
        status: shown.status,
        notes: shown.notes,
      });
      if (result.ok) {
        onDraft(null);
      } else {
        // Keep the edit either way: a conflict is offered as keep-or-replace,
        // and a missing request is explained, once the fresh read lands.
        onDraft(shown);
        void current.revalidate();
      }
    } catch (err) {
      const message = (err as { message?: unknown } | null)?.message;
      setError(typeof message === "string" ? message : "The request couldn't be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Request">
      <Heading level={2}>{request.title}</Heading>
      {standing === "overtaken" ? (
        <Callout
          severity="warning"
          title="Changed while you were editing"
          action={
            <span className="flex gap-1.5">
              <Button size="xs" variant="outline" onClick={() => void save(request.revision)}>
                Keep my edit
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onDraft(null)}>
                Use theirs
              </Button>
            </span>
          }
        >
          Someone saved a newer version. Keeping yours replaces it.
        </Callout>
      ) : null}
      <Input value={shown.title} onValueChange={(title) => edit({ title })} aria-label="Title" />
      <Select
        aria-label="Status"
        value={shown.status}
        options={REQUEST_STATUSES.map((status) => ({
          value: status,
          label: STATUS_LABELS[status],
        }))}
        onValueChange={(status) => edit({ status: status as RequestStatus })}
      />
      <Textarea
        value={shown.notes}
        onValueChange={(notes) => edit({ notes })}
        rows={5}
        aria-label="Notes"
        placeholder="Notes"
      />
      {error ? <Text tone="danger">{error}</Text> : null}
      <div className="flex gap-2">
        <Button loading={saving} disabled={standing !== "pending"} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="ghost" disabled={!draft} onClick={() => onDraft(null)}>
          Discard
        </Button>
      </div>
    </section>
  );
}

const REPORT_STATE_LABELS: Record<ReportSummary["state"], string> = {
  pending: "Queued",
  submitting: "Sending",
  uncertain: "Checking with the provider",
  running: "Building",
  succeeded: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  abandoned: "Stopped tracking",
};

function Reports({ pluginId }: { pluginId: string }): ReactElement {
  const reports = useReports(pluginId);
  const connection = useConnection(pluginId);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      await call(pluginId, CHANNELS.startReport, {});
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Reports">
      <div className="flex items-center justify-between gap-2">
        <Heading level={2}>Reports</Heading>
        <Button
          size="sm"
          variant="secondary"
          loading={starting}
          disabled={!connection.data?.connected}
          onClick={() => void start()}
        >
          Build report
        </Button>
      </div>
      {connection.data && !connection.data.connected ? (
        <Callout severity="info" title="Connect the report provider">
          Reports are built by a synthetic provider. Connect it in Project settings → Request Desk.
        </Callout>
      ) : null}
      {reports.data?.length ? (
        reports.data.map((report) => (
          <ReportRow key={report.operationId} pluginId={pluginId} report={report} />
        ))
      ) : (
        <Text tone="muted" size="sm">
          No reports yet.
        </Text>
      )}
    </section>
  );
}

function ReportRow({
  pluginId,
  report,
}: {
  pluginId: string;
  report: ReportSummary;
}): ReactElement {
  const stalled = report.state === "abandoned" || report.state === "uncertain";
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-default p-2">
      {report.reportId ? <ReportPreview pluginId={pluginId} reportId={report.reportId} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <Text weight="medium">{REPORT_STATE_LABELS[report.state]}</Text>
        <Text tone="muted" size="xs">
          {report.requestCount !== null
            ? `${report.requestCount} requests`
            : report.fraction !== null
              ? `${Math.round(report.fraction * 100)}%`
              : (report.error ?? new Date(report.createdAt).toLocaleString())}
        </Text>
      </div>
      {stalled ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void call(pluginId, CHANNELS.retryReport, { operationId: report.operationId })
          }
        >
          Resume
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The report file is durable; its artifact is not. The worker re-imports it
 * when the session's handle has gone, and the kit mints the leased source, so
 * the view never holds a path, a URL or the bytes.
 */
function ReportPreview({
  pluginId,
  reportId,
}: {
  pluginId: string;
  reportId: string;
}): ReactElement | null {
  const artifact = useCachedHostChannel<{ reportId: string }, PluginArtifact | null>(
    pluginId,
    CHANNELS.reportArtifact,
    { reportId }
  );
  if (!artifact.data) return null;
  return <MediaThumbnail source={artifact.data} size="lg" alt="Report preview" />;
}
