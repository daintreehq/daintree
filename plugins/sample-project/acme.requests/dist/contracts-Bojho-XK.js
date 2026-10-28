/**
* What the worker and the views agree on. Imported by both sides and inlined
* into each bundle, so nothing here may touch the host or the DOM.
*/
var REQUEST_STATUSES = [
	"open",
	"in_progress",
	"done"
];
/** The channels the views call with `invoke`. */
var CHANNELS = {
	list: "requests.list",
	get: "requests.get",
	add: "requests.add",
	update: "requests.update",
	reports: "reports.list",
	startReport: "reports.start",
	retryReport: "reports.retry",
	reportArtifact: "reports.artifact",
	connection: "connection.get",
	connect: "connection.connect",
	testConnection: "connection.test",
	disconnect: "connection.disconnect"
};
/** Pushes from the worker, used only to invalidate what a view shows. */
var EVENTS = {
	requestsChanged: "requests-changed",
	reportsChanged: "reports-changed",
	connectionChanged: "connection-changed"
};
var MAX_NOTES_CHARS = 2e3;
export { REQUEST_STATUSES as i, EVENTS as n, MAX_NOTES_CHARS as r, CHANNELS as t };
