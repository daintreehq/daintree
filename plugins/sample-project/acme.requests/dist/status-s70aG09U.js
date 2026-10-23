import { Badge } from "@daintreehq/plugin-ui";
import { jsx } from "react/jsx-runtime";
var STATUS_LABELS = {
	open: "Open",
	in_progress: "In progress",
	done: "Done"
};
var STATUS_TONES = {
	open: "info",
	in_progress: "warning",
	done: "success"
};
function StatusBadge({ status }) {
	return /* @__PURE__ */ jsx(Badge, {
		tone: STATUS_TONES[status],
		size: "xs",
		children: STATUS_LABELS[status]
	});
}
export { StatusBadge as n, STATUS_LABELS as t };
