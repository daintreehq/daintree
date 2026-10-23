import { i as useRequests } from "./data-DYsOgj87.js";
import { n as StatusBadge } from "./status-s70aG09U.js";
import { Callout, EmptyState, ListRow, PaneState } from "@daintreehq/plugin-ui";
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
/**
* The sidebar list. Selecting a request moves the shared navigation and
* brings Home forward, where the request opens: the two views never talk to
* each other, they both follow `navigation.location`.
*/
function Sidebar({ pluginId, navigation }) {
	const requests = useRequests(pluginId);
	const [refused, setRefused] = useState(false);
	const location = navigation?.location;
	const selectedId = location?.sectionId === "request" ? String(location.params.requestId) : null;
	if (requests.error && !requests.data) return /* @__PURE__ */ jsx(PaneState, {
		kind: "error",
		title: "Couldn't open the requests",
		onRetry: () => void requests.revalidate()
	});
	if (!requests.data) return /* @__PURE__ */ jsx(PaneState, {
		kind: "loading",
		title: "Opening requests"
	});
	const open = (sectionId, requestId) => {
		if (!navigation) return;
		const result = navigation.navigate(requestId ? {
			sectionId,
			params: { requestId }
		} : { sectionId });
		setRefused(!result.ok && result.reason === "unsaved");
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full min-h-0 flex-col gap-1 p-2",
		children: [
			refused ? /* @__PURE__ */ jsx(Callout, {
				severity: "warning",
				size: "compact",
				children: "Save or discard the edit open in Request Desk first."
			}) : null,
			/* @__PURE__ */ jsx(ListRow, {
				title: "Reports",
				icon: "file-text",
				selected: location?.sectionId === "reports",
				onSelect: () => open("reports")
			}),
			/* @__PURE__ */ jsx("div", {
				className: "min-h-0 flex-1 overflow-y-auto",
				children: requests.data.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
					scale: "sidebar",
					title: "No requests yet"
				}) : requests.data.map((request) => /* @__PURE__ */ jsx(ListRow, {
					title: request.title,
					meta: /* @__PURE__ */ jsx(StatusBadge, { status: request.status }),
					selected: request.id === selectedId,
					onSelect: () => open("request", request.id)
				}, request.id))
			})
		]
	});
}
export { Sidebar as default };
