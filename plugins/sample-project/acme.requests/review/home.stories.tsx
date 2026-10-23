import {
  hostResponses,
  type PanelStoriesMeta,
  type PanelStory,
} from "@daintreehq/plugin-sdk/testing/preview";
import type { ReportSummary, RequestRecord } from "../src/contracts";
import { encodeDraft } from "../src/views/draft";
import Home from "../src/views/home";

/**
 * Request Desk's Home in each state it can be in, against a mock host. The
 * preview hands the view no `navigation`, so Home keeps its own selection
 * here, the way it does whenever the application isn't in force. Nothing in
 * review/ ships: the build reads src/ only.
 */

const REQUESTS: RequestRecord[] = [
  {
    id: "demo-1",
    title: "Add dark mode to the invoice page",
    status: "open",
    notes: "Synthetic demo record.",
    revision: 1,
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
  },
  {
    id: "demo-2",
    title: "Export customers as CSV",
    status: "in_progress",
    notes: "Synthetic demo record.",
    revision: 3,
    createdAt: "2026-01-06T10:30:00.000Z",
    updatedAt: "2026-01-07T14:00:00.000Z",
  },
];

const REPORTS: ReportSummary[] = [
  {
    operationId: "op-2",
    state: "running",
    reportId: null,
    requestCount: null,
    fraction: 0.4,
    error: null,
    createdAt: Date.UTC(2026, 0, 8, 9),
  },
  {
    operationId: "op-1",
    state: "abandoned",
    reportId: null,
    requestCount: null,
    fraction: null,
    error: "The provider stopped answering.",
    createdAt: Date.UTC(2026, 0, 7, 9),
  },
];

const getRequest = (args: unknown) =>
  REQUESTS.find((request) => request.id === (args as { id?: string }).id) ?? null;

export default {
  title: "Request Desk / Home",
  component: Home,
  args: { pluginId: "acme.requests", panelId: "home-1" },
  fixtures: {
    channels: {
      "requests.list": REQUESTS,
      "requests.get": getRequest,
      "reports.list": REPORTS,
      "reports.artifact": null,
      "connection.get": { connected: true, workspace: "Demo workspace" },
    },
  },
} satisfies PanelStoriesMeta;

/** The list and the reports, nothing selected. */
export const Populated: PanelStory = {};

/** A fresh project before any request exists, provider not yet connected. */
export const Empty: PanelStory = {
  fixtures: {
    channels: {
      "requests.list": [],
      "reports.list": [],
      "connection.get": { connected: false, workspace: null },
    },
  },
};

/** The store has not answered yet (the first open may be waiting on consent). */
export const Loading: PanelStory = {
  fixtures: { channels: { "requests.list": hostResponses.pending() } },
};

/** The store could not be opened. */
export const OpenFailed: PanelStory = {
  fixtures: {
    channels: {
      "requests.list": hostResponses.permissionRequired("fs:project-write was declined"),
    },
  },
};

/**
 * Reopened with an edit that was never saved: the view restores it from its
 * durable state and offers to discard it.
 */
export const RestoredDraft: PanelStory = {
  args: {
    initialArgs: encodeDraft({
      requestId: "demo-2",
      baseRevision: 3,
      title: "Export customers as CSV and XLSX",
      status: "in_progress",
      notes: "Started on the XLSX writer.",
    }),
  },
};
