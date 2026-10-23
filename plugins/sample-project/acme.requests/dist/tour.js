import { jsx, jsxs } from "react/jsx-runtime";
import { MockLines, MockSpotlight, reveal } from "@daintreehq/tour/kit";
import { MockApp, MockGrid, MockPane, MockWorktreeCard } from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";
/**
* The welcome tour's scenes, one per chapter in tours/welcome.narration.json.
* Every beat waits on a cue from the narration, never a timer, so the scene
* keeps pace with the voice or, until the tour is voiced, the silent clock.
*/
var ROWS = [
	{
		title: "Add dark mode to the invoice page",
		status: "Open"
	},
	{
		title: "Export customers as CSV",
		status: "In progress"
	},
	{
		title: "Write the onboarding checklist",
		status: "Open"
	}
];
function Worktrees() {
	return /* @__PURE__ */ jsx(MockWorktreeCard, {
		name: "request-desk",
		branch: "main",
		selected: true
	});
}
function RequestList({ added }) {
	const rows = added ? ROWS : ROWS.slice(0, 2);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex h-full flex-col gap-1.5 rounded-lg border border-border-default bg-surface-panel p-2.5",
		"data-tour-anchor": "requests-list",
		children: [/* @__PURE__ */ jsx("div", {
			className: "text-2xs font-semibold text-text-primary",
			children: "Request Desk"
		}), /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col gap-1",
			children: rows.map((row, index) => /* @__PURE__ */ jsxs("li", {
				className: `flex justify-between rounded-md px-1.5 py-1 text-2xs text-text-secondary ${index === 2 ? reveal(added) : ""}`,
				children: [/* @__PURE__ */ jsx("span", { children: row.title }), /* @__PURE__ */ jsx("span", {
					className: "text-text-muted",
					children: row.status
				})]
			}, row.title))
		})]
	});
}
function Requests() {
	const list = useCue("list");
	const tools = useCue("tools");
	return /* @__PURE__ */ jsx(MockApp, {
		focus: list ? ["grid"] : void 0,
		worktrees: /* @__PURE__ */ jsx(Worktrees, {}),
		grid: /* @__PURE__ */ jsxs(MockGrid, {
			columns: 2,
			children: [/* @__PURE__ */ jsx(RequestList, { added: tools }), /* @__PURE__ */ jsx(MockPane, {
				agent: {
					id: "claude",
					name: "Claude",
					Icon: null
				},
				children: /* @__PURE__ */ jsx(MockLines, { widths: tools ? [
					80,
					64,
					72
				] : [80, 40] })
			})]
		}),
		children: /* @__PURE__ */ jsx(MockSpotlight, {
			targets: ["requests-list"],
			visible: list && !tools
		})
	});
}
function Reports() {
	const report = useCue("report");
	const preview = useCue("preview");
	return /* @__PURE__ */ jsx(MockApp, {
		focus: ["grid"],
		worktrees: /* @__PURE__ */ jsx(Worktrees, {}),
		grid: /* @__PURE__ */ jsx(MockGrid, {
			columns: 1,
			children: /* @__PURE__ */ jsxs("div", {
				className: "flex h-full flex-col justify-center gap-2 rounded-lg border border-border-default bg-surface-panel p-4",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "text-2xs font-semibold text-text-primary",
						children: "Reports"
					}),
					/* @__PURE__ */ jsx("div", {
						className: `text-2xs text-text-secondary ${reveal(report)}`,
						children: preview ? "Ready · 3 requests" : "Building…"
					}),
					/* @__PURE__ */ jsx("div", {
						"data-tour-anchor": "report-preview",
						className: `h-16 w-28 rounded-md border border-border-default bg-surface-panel-elevated ${reveal(preview)}`
					})
				]
			})
		}),
		children: /* @__PURE__ */ jsx(MockSpotlight, {
			targets: ["report-preview"],
			visible: preview
		})
	});
}
var tour_default = {
	scenes: {
		requests: Requests,
		reports: Reports
	},
	chapterTitles: {
		requests: "Requests beside your agents",
		reports: "Reports in the background"
	}
};
export { tour_default as default };
