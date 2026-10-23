import { i as REQUEST_STATUSES, n as EVENTS, t as CHANNELS } from "./contracts-Bojho-XK.js";
import { a as useCachedHostChannel, i as useRequests, n as useConnection, r as useReports, t as call } from "./data-DYsOgj87.js";
import { n as StatusBadge, t as STATUS_LABELS } from "./status-s70aG09U.js";
import { Button, Callout, EmptyState, Heading, Input, ListRow, MediaThumbnail, PaneState, Select, Text, Textarea } from "@daintreehq/plugin-ui";
import { useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function encodeDraft(draft) {
	return { draft: draft ? {
		v: 1,
		...draft
	} : null };
}
function readDraft(state) {
	const raw = state?.draft;
	if (!raw || typeof raw !== "object") return null;
	const d = raw;
	if (d.v !== 1 || typeof d.requestId !== "string" || typeof d.baseRevision !== "number" || typeof d.title !== "string" || typeof d.notes !== "string" || !REQUEST_STATUSES.includes(d.status)) return null;
	return {
		requestId: d.requestId,
		baseRevision: d.baseRevision,
		title: d.title,
		status: d.status,
		notes: d.notes
	};
}
function draftFrom(request) {
	return {
		requestId: request.id,
		baseRevision: request.revision,
		title: request.title,
		status: request.status,
		notes: request.notes
	};
}
function isDirty(draft, request) {
	return draft.title !== request.title || draft.status !== request.status || draft.notes !== request.notes;
}
function draftStanding(draft, request) {
	if (!draft) return "clean";
	if (request === null) return "orphaned";
	if (request === void 0) return "pending";
	if (!isDirty(draft, request)) return "clean";
	return request.revision === draft.baseRevision ? "pending" : "overtaken";
}
/**
* Request Desk's Home: the list, the request the shared navigation points at,
* and the reports. Selection lives in `navigation`, so picking a request here
* selects it in the sidebar too, and the host restores it after a restart.
* Without `navigation` (the application isn't in force, or the preview) the
* view keeps its own selection instead.
*/
function Home(props) {
	const { pluginId, navigation } = props;
	const requests = useRequests(pluginId);
	const [localSelection, setLocalSelection] = useState(null);
	const [draft, setDraftState] = useState(() => readDraft(props.initialArgs));
	const [blocked, setBlocked] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const location = navigation?.location;
	const selectedId = navigation ? location?.sectionId === "request" ? String(location.params.requestId) : null : localSelection;
	const showReports = location?.sectionId === "reports";
	const hasDraft = draft !== null;
	const { setHasUnsavedChanges, persistState } = props;
	useEffect(() => {
		setHasUnsavedChanges?.(hasDraft);
	}, [hasDraft, setHasUnsavedChanges]);
	const setDraft = (next) => {
		setDraftState(next);
		persistState?.(encodeDraft(next));
		if (next === null) {
			setBlocked(false);
			setHasUnsavedChanges?.(false);
		}
	};
	const editingId = draft?.requestId ?? selectedId;
	const select = (id, { dropped = false } = {}) => {
		if (!navigation) {
			if (!dropped && draft && draft.requestId !== id) {
				setBlocked(true);
				return;
			}
			setLocalSelection(id);
			return;
		}
		const result = navigation.navigate(id ? {
			sectionId: "request",
			params: { requestId: id },
			reveal: false
		} : {
			sectionId: "requests",
			reveal: false
		});
		setBlocked(!result.ok && result.reason === "unsaved");
	};
	const addRequest = async () => {
		const title = newTitle.trim();
		if (!title) return;
		const created = await call(pluginId, CHANNELS.add, { title });
		setNewTitle("");
		select(created.id);
	};
	if (requests.error && !requests.data) return /* @__PURE__ */ jsx(PaneState, {
		kind: "error",
		title: "Couldn't open the requests",
		description: requests.error.message,
		onRetry: () => void requests.revalidate()
	});
	if (!requests.data) return /* @__PURE__ */ jsx(PaneState, {
		kind: "loading",
		title: "Opening requests"
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full min-h-0",
		children: [/* @__PURE__ */ jsxs("aside", {
			className: "flex w-72 shrink-0 flex-col gap-2 border-r border-border-default p-3",
			children: [
				/* @__PURE__ */ jsx(Heading, {
					level: 3,
					children: "Requests"
				}),
				/* @__PURE__ */ jsxs("form", {
					className: "flex gap-1.5",
					onSubmit: (event) => {
						event.preventDefault();
						addRequest();
					},
					children: [/* @__PURE__ */ jsx(Input, {
						value: newTitle,
						onValueChange: setNewTitle,
						placeholder: "New request",
						"aria-label": "New request title"
					}), /* @__PURE__ */ jsx(Button, {
						type: "submit",
						size: "sm",
						variant: "secondary",
						disabled: !newTitle.trim(),
						children: "Add"
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "min-h-0 flex-1 overflow-y-auto",
					children: [requests.data.length >= 100 ? /* @__PURE__ */ jsxs(Text, {
						tone: "muted",
						size: "xs",
						children: [
							"The ",
							100,
							" most recently changed. Ask an agent for older ones."
						]
					}) : null, requests.data.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
						scale: "sidebar",
						title: "No requests yet",
						description: "Add one here, or ask an agent to."
					}) : requests.data.map((request) => /* @__PURE__ */ jsx(ListRow, {
						title: request.title,
						meta: /* @__PURE__ */ jsx(StatusBadge, { status: request.status }),
						selected: request.id === editingId,
						onSelect: () => select(request.id)
					}, request.id))]
				})
			]
		}), /* @__PURE__ */ jsxs("main", {
			className: "flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
			children: [
				blocked && draft ? /* @__PURE__ */ jsxs(Callout, {
					severity: "warning",
					title: "Unsaved edits",
					children: [
						"Save or discard your edits to “",
						draft.title,
						"” before opening another request."
					]
				}) : null,
				draft && draft.requestId !== selectedId ? /* @__PURE__ */ jsxs(Callout, {
					severity: "info",
					title: "You have an unsaved edit",
					children: [
						"Finish or discard your edit to “",
						draft.title,
						"” below, then the request you picked opens."
					]
				}) : null,
				editingId ? /* @__PURE__ */ jsx(RequestDetail, {
					pluginId,
					requestId: editingId,
					draft,
					onDraft: setDraft,
					onGone: () => select(null, { dropped: true })
				}) : null,
				showReports || !editingId ? /* @__PURE__ */ jsx(Reports, { pluginId }) : null
			]
		})]
	});
}
function RequestDetail(props) {
	const { pluginId, requestId, draft, onDraft } = props;
	const current = useCachedHostChannel(pluginId, CHANNELS.get, { id: requestId }, { invalidateOn: EVENTS.requestsChanged });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(null);
	if (current.data === void 0) return /* @__PURE__ */ jsx(PaneState, {
		kind: "loading",
		title: "Opening the request"
	});
	const request = current.data;
	const standing = draftStanding(draft, request);
	if (request === null) return /* @__PURE__ */ jsx(Callout, {
		severity: "warning",
		title: "This request no longer exists",
		action: /* @__PURE__ */ jsx(Button, {
			size: "xs",
			variant: "outline",
			onClick: () => {
				onDraft(null);
				props.onGone();
			},
			children: "Back to requests"
		}),
		children: standing === "orphaned" ? "It was removed while you were editing it, so your edit has nowhere to go." : "It was removed, perhaps by an agent."
	});
	const shown = draft ?? draftFrom(request);
	const edit = (patch) => onDraft({
		...shown,
		...patch
	});
	const save = async (base = shown.baseRevision) => {
		setSaving(true);
		setError(null);
		try {
			if ((await call(pluginId, CHANNELS.update, {
				id: shown.requestId,
				revision: base,
				title: shown.title,
				status: shown.status,
				notes: shown.notes
			})).ok) onDraft(null);
			else {
				onDraft(shown);
				current.revalidate();
			}
		} catch (err) {
			const message = err?.message;
			setError(typeof message === "string" ? message : "The request couldn't be saved.");
		} finally {
			setSaving(false);
		}
	};
	return /* @__PURE__ */ jsxs("section", {
		className: "flex flex-col gap-3",
		"aria-label": "Request",
		children: [
			/* @__PURE__ */ jsx(Heading, {
				level: 2,
				children: request.title
			}),
			standing === "overtaken" ? /* @__PURE__ */ jsx(Callout, {
				severity: "warning",
				title: "Changed while you were editing",
				action: /* @__PURE__ */ jsxs("span", {
					className: "flex gap-1.5",
					children: [/* @__PURE__ */ jsx(Button, {
						size: "xs",
						variant: "outline",
						onClick: () => void save(request.revision),
						children: "Keep my edit"
					}), /* @__PURE__ */ jsx(Button, {
						size: "xs",
						variant: "ghost",
						onClick: () => onDraft(null),
						children: "Use theirs"
					})]
				}),
				children: "Someone saved a newer version. Keeping yours replaces it."
			}) : null,
			/* @__PURE__ */ jsx(Input, {
				value: shown.title,
				onValueChange: (title) => edit({ title }),
				"aria-label": "Title",
				disabled: saving
			}),
			/* @__PURE__ */ jsx(Select, {
				"aria-label": "Status",
				value: shown.status,
				options: REQUEST_STATUSES.map((status) => ({
					value: status,
					label: STATUS_LABELS[status]
				})),
				onValueChange: (status) => edit({ status }),
				disabled: saving
			}),
			/* @__PURE__ */ jsx(Textarea, {
				value: shown.notes,
				onValueChange: (notes) => edit({ notes }),
				rows: 5,
				"aria-label": "Notes",
				placeholder: "Notes",
				disabled: saving
			}),
			error ? /* @__PURE__ */ jsx(Text, {
				tone: "danger",
				children: error
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "flex gap-2",
				children: [/* @__PURE__ */ jsx(Button, {
					loading: saving,
					disabled: standing !== "pending",
					onClick: () => void save(),
					children: "Save"
				}), /* @__PURE__ */ jsx(Button, {
					variant: "ghost",
					disabled: !draft || saving,
					onClick: () => onDraft(null),
					children: "Discard"
				})]
			})
		]
	});
}
var REPORT_STATE_LABELS = {
	pending: "Queued",
	submitting: "Sending",
	uncertain: "Checking with the provider",
	running: "Building",
	succeeded: "Ready",
	failed: "Failed",
	cancelled: "Cancelled",
	abandoned: "Stopped tracking"
};
function Reports({ pluginId }) {
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
	return /* @__PURE__ */ jsxs("section", {
		className: "flex flex-col gap-3",
		"aria-label": "Reports",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-2",
				children: [/* @__PURE__ */ jsx(Heading, {
					level: 2,
					children: "Reports"
				}), /* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "secondary",
					loading: starting,
					disabled: !connection.data?.connected,
					onClick: () => void start(),
					children: "Build report"
				})]
			}),
			connection.data && !connection.data.connected ? /* @__PURE__ */ jsx(Callout, {
				severity: "info",
				title: "Connect the report provider",
				children: "Reports are built by a synthetic provider. Connect it in Project settings → Request Desk."
			}) : null,
			reports.data?.length ? reports.data.map((report) => /* @__PURE__ */ jsx(ReportRow, {
				pluginId,
				report
			}, report.operationId)) : /* @__PURE__ */ jsx(Text, {
				tone: "muted",
				size: "sm",
				children: "No reports yet."
			})
		]
	});
}
function ReportRow({ pluginId, report }) {
	const stalled = report.state === "abandoned" || report.state === "uncertain";
	return /* @__PURE__ */ jsxs("div", {
		className: "flex items-center gap-3 rounded-md border border-border-default p-2",
		children: [
			report.reportId ? /* @__PURE__ */ jsx(ReportPreview, {
				pluginId,
				reportId: report.reportId
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-1 flex-col",
				children: [/* @__PURE__ */ jsx(Text, {
					weight: "medium",
					children: REPORT_STATE_LABELS[report.state]
				}), /* @__PURE__ */ jsx(Text, {
					tone: "muted",
					size: "xs",
					children: report.requestCount !== null ? `${report.requestCount} requests` : report.fraction !== null ? `${Math.round(report.fraction * 100)}%` : report.error ?? new Date(report.createdAt).toLocaleString()
				})]
			}),
			stalled ? /* @__PURE__ */ jsx(Button, {
				size: "xs",
				variant: "outline",
				onClick: () => void call(pluginId, CHANNELS.retryReport, { operationId: report.operationId }),
				children: "Resume"
			}) : null
		]
	});
}
/**
* The report file is durable; its artifact is not. The worker re-imports it
* when the session's handle has gone, and the kit mints the leased source, so
* the view never holds a path, a URL or the bytes.
*/
function ReportPreview({ pluginId, reportId }) {
	const artifact = useCachedHostChannel(pluginId, CHANNELS.reportArtifact, { reportId }, { invalidateOn: EVENTS.reportsChanged });
	if (!artifact.data) return null;
	return /* @__PURE__ */ jsx(MediaThumbnail, {
		source: artifact.data,
		size: "lg",
		alt: "Report preview"
	});
}
export { Home as default };
