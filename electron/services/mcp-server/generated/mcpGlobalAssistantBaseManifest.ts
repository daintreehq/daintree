// GENERATED FILE — do not edit by hand.
//
// The whole tool surface of the global assistant (#14453), which has no
// project and no view: its root tools, and nothing it would be refused.
// Regenerate with:
//
//   UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts
//
// The generator drives the real `ActionService` over the real action registry,
// so this is a projection of production code rather than a second source of
// truth. The same test fails when this file drifts from it.

import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

export const MCP_GLOBAL_ASSISTANT_BASE_MANIFEST: readonly ActionManifestEntry[] = [
  {
    band: "reversible",
    category: "help",
    danger: "safe",
    description:
      "Run a host's own Daintree tool in one of its projects (local reaches another project here) and get its result, such as starting its assistant. Changes are refused while another machine drives that project. ambiguous: resend under its callId, which never runs twice.",
    enabled: true,
    id: "host.call",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        hostId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "A host id from the host list.",
        },
        projectId: {
          description: "A projectId from the host list. The call runs there.",
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        throwaway: {
          description:
            "Instead of projectId: a short-lived agent this session owns, in a host folder. Tools: throwaway.launch, status, output, sendCommand, sendKeys, close.",
          type: "boolean",
          const: true,
        },
        tool: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "A Daintree tool on the host, by id. Search the host's own tools through this.",
        },
        args: {
          description: "The tool's own arguments.",
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {},
        },
        callId: {
          description: "Resend an ambiguous call under its callId. It never runs twice.",
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        newCallId: {
          description:
            "Your own fresh UUID for a write; with no answer back, resend under it as callId. Never both.",
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ["hostId", "tool"],
    },
    keywords: ["host", "remote", "call", "tool", "relay", "control"],
    kind: "command",
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    name: "host.call",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "ok",
            "ambiguous",
            "opted_out",
            "disconnected",
            "unsupported",
            "policy_rejected",
            "expired",
            "not_found",
            "rate_limited",
            "too_large",
            "conflict",
          ],
        },
        detail: {
          type: ["string", "null"],
        },
        retryAfterMs: {
          type: ["number", "null"],
        },
        callId: {
          type: ["string", "null"],
        },
        result: {
          anyOf: [
            {
              type: "object",
              properties: {
                isError: {
                  type: "boolean",
                },
                structured: {
                  anyOf: [
                    {
                      type: "object",
                      propertyNames: {
                        type: "string",
                      },
                      additionalProperties: {},
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                text: {
                  type: ["string", "null"],
                },
              },
              required: ["isError", "structured", "text"],
              additionalProperties: false,
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: ["outcome", "detail", "retryAfterMs", "callId", "result"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Run a tool on a host",
  },
  {
    band: "reversible",
    category: "help",
    danger: "safe",
    description:
      "List the hosts this assistant reaches, this machine first as local, as observed: link flags, build, installed CLIs, load sample, agent counts and a page of each connected host's projects, which calls name. Null means unmeasured.",
    enabled: true,
    id: "host.list",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        includeAgents: {
          description:
            "Also list each host's agents: its workers and Daintree Assistants, as observed. Read the coverage before reading an empty list as nothing running.",
          type: "boolean",
        },
        projectId: {
          description:
            "With includeAgents, list only the agents of this project (a projectId from the list).",
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        hostId: {
          description: "List only this host.",
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
        projectQuery: {
          description: "Only projects whose name contains this, any case.",
          type: "string",
          minLength: 1,
          maxLength: 128,
        },
        projectCursor: {
          description: "A projectInventory.nextCursor: that host's next page, same query.",
          type: "string",
          minLength: 1,
          maxLength: 1024,
        },
      },
    },
    keywords: ["host", "remote", "assistant", "control", "load"],
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    name: "host.list",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        hosts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hostId: {
                type: "string",
              },
              name: {
                type: "string",
              },
              connection: {
                type: "string",
                enum: ["connected", "connecting", "disconnected"],
              },
              link: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    enum: [
                      "local",
                      "disconnected",
                      "connecting",
                      "connected",
                      "unreachable",
                      "version-mismatch",
                      "driven-elsewhere",
                    ],
                  },
                  attempt: {
                    type: ["number", "null"],
                  },
                  restarting: {
                    type: "boolean",
                    description: "It said it was shutting down; still retried.",
                  },
                  hostModeOff: {
                    type: "boolean",
                    description: "ssh got in; no Daintree in Host mode there.",
                  },
                  stoppedRetrying: {
                    description: "Waits for a Connect: login refused, Host mode off or unusable.",
                    type: ["boolean", "null"],
                  },
                  disconnectedByPerson: {
                    type: "boolean",
                  },
                  quietSince: {
                    description: "Connected; silent since.",
                    type: ["number", "null"],
                  },
                  mismatch: {
                    anyOf: [
                      {
                        type: "object",
                        properties: {
                          kind: {
                            type: "string",
                            enum: ["protocol", "version", "commit"],
                          },
                          local: {
                            type: "string",
                          },
                          remote: {
                            type: "string",
                          },
                        },
                        required: ["kind", "local", "remote"],
                        additionalProperties: false,
                      },
                      {
                        type: "null",
                      },
                    ],
                    description: "Builds differ; blocking only under version-mismatch.",
                  },
                },
                required: [
                  "status",
                  "attempt",
                  "restarting",
                  "hostModeOff",
                  "stoppedRetrying",
                  "disconnectedByPerson",
                  "quietSince",
                  "mismatch",
                ],
                additionalProperties: false,
              },
              build: {
                type: "object",
                properties: {
                  source: {
                    type: "string",
                    enum: ["connected", "rejected", "last-seen", "unknown"],
                  },
                  handshake: {
                    anyOf: [
                      {
                        type: "object",
                        properties: {
                          version: {
                            type: "string",
                          },
                          commit: {
                            type: "string",
                          },
                          protocolVersion: {
                            type: "number",
                          },
                          platform: {
                            type: "string",
                            enum: ["darwin", "linux"],
                          },
                          arch: {
                            type: "string",
                            enum: ["x64", "arm64"],
                          },
                        },
                        required: ["version", "commit", "protocolVersion", "platform", "arch"],
                        additionalProperties: false,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                },
                required: ["source", "handshake"],
                additionalProperties: false,
              },
              agentClis: {
                type: "object",
                properties: {
                  coverage: {
                    type: "string",
                    enum: ["observed", "stale", "unknown"],
                  },
                  sampledAt: {
                    type: ["number", "null"],
                  },
                  installed: {
                    maxItems: 32,
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        agentId: {
                          type: "string",
                        },
                        version: {
                          type: ["string", "null"],
                        },
                      },
                      required: ["agentId", "version"],
                      additionalProperties: false,
                    },
                  },
                  omitted: {
                    type: "number",
                  },
                },
                required: ["coverage", "sampledAt", "installed", "omitted"],
                additionalProperties: false,
                description: "Installed only: sign-in and quota unknown. Absence unproven.",
              },
              rttMs: {
                type: ["number", "null"],
              },
              lastSeenAt: {
                type: ["number", "null"],
              },
              load: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      sampledAt: {
                        type: "number",
                        description: "The host's own clock: provenance, not an age.",
                      },
                      receivedAt: {
                        description: "This machine's clock when the sample arrived.",
                        type: ["number", "null"],
                      },
                      ageMs: {
                        description:
                          "How old the sample is at most, never by comparing clocks. Null: unknown.",
                        type: ["number", "null"],
                      },
                      stale: {
                        type: "boolean",
                        description:
                          "Too old to trust: the live figures below are null. Not a zero reading.",
                      },
                      staleReason: {
                        anyOf: [
                          {
                            type: "string",
                            enum: ["age-limit", "clock-uncertain"],
                          },
                          {
                            type: "null",
                          },
                        ],
                        description:
                          "age-limit: known too old. clock-uncertain: an older host's timestamp, far from this clock: old or clocks disagree. Null when fresh.",
                      },
                      platform: {
                        type: "string",
                        enum: ["darwin", "linux"],
                      },
                      cpuPercent: {
                        type: ["number", "null"],
                      },
                      cpuLogicalCores: {
                        type: ["number", "null"],
                      },
                      cpuBusyCores: {
                        description:
                          "cpuPercent of the cores it is a share of: all logical cores, or a cgroup quota.",
                        type: ["number", "null"],
                      },
                      cpuIdleCores: {
                        type: ["number", "null"],
                      },
                      memoryTotalBytes: {
                        type: ["number", "null"],
                      },
                      memoryUsedBytes: {
                        type: ["number", "null"],
                      },
                      memoryAvailableBytes: {
                        description: "Total minus used, as the host counts.",
                        type: ["number", "null"],
                      },
                      memoryCapacityReported: {
                        type: "boolean",
                        description:
                          "False: an older host whose used memory includes file cache, so none is given.",
                      },
                      memoryPressure: {
                        anyOf: [
                          {
                            type: "string",
                            enum: ["normal", "warn", "critical"],
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      thermal: {
                        anyOf: [
                          {
                            type: "string",
                            enum: ["nominal", "fair", "serious", "critical"],
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      metricsScope: {
                        anyOf: [
                          {
                            type: "string",
                            enum: ["host", "cgroup"],
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      memoryPressureSomeAvg10: {
                        type: ["number", "null"],
                      },
                      temperatureCelsius: {
                        type: ["number", "null"],
                      },
                      temperatureZone: {
                        type: ["string", "null"],
                      },
                    },
                    required: [
                      "sampledAt",
                      "receivedAt",
                      "ageMs",
                      "stale",
                      "staleReason",
                      "platform",
                      "cpuPercent",
                      "cpuLogicalCores",
                      "cpuBusyCores",
                      "cpuIdleCores",
                      "memoryTotalBytes",
                      "memoryUsedBytes",
                      "memoryAvailableBytes",
                      "memoryCapacityReported",
                      "memoryPressure",
                      "thermal",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
                description:
                  "Null: no sample. Any null field inside is unknown, never zero or unlimited.",
              },
              agentsObserved: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      working: {
                        type: "number",
                      },
                      waiting: {
                        type: "number",
                      },
                      idle: {
                        type: "number",
                      },
                    },
                    required: ["working", "waiting", "idle"],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              projects: {
                anyOf: [
                  {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        projectId: {
                          type: "string",
                        },
                        name: {
                          type: "string",
                        },
                        frontendAttached: {
                          description:
                            "A frontend is attached: a view there or a driving Shell. If false, only tools the host runs itself run. Null: unknown.",
                          type: ["boolean", "null"],
                        },
                      },
                      required: ["projectId", "name", "frontendAttached"],
                      additionalProperties: false,
                    },
                  },
                  {
                    type: "null",
                  },
                ],
              },
              projectInventory: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      complete: {
                        type: "boolean",
                        description:
                          "This answer names every match. With a total, pages walked to a null nextCursor name them all.",
                      },
                      total: {
                        description: "Null: past the host's own list limit.",
                        type: ["number", "null"],
                      },
                      offset: {
                        type: "number",
                      },
                      omitted: {
                        description: "Matching projects not named here, earlier pages too.",
                        type: ["number", "null"],
                      },
                      nextCursor: {
                        description: "projectCursor for the next page.",
                        type: ["string", "null"],
                      },
                      listChanged: {
                        type: "boolean",
                        description: "The list changed since the cursor: its first page again.",
                      },
                    },
                    required: [
                      "complete",
                      "total",
                      "offset",
                      "omitted",
                      "nextCursor",
                      "listChanged",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              control: {
                type: "boolean",
              },
              agents: {
                type: "object",
                properties: {
                  coverage: {
                    type: "string",
                    enum: ["ok", "stale", "unreachable", "unsupported"],
                  },
                  observedAt: {
                    type: ["number", "null"],
                  },
                  complete: {
                    type: "boolean",
                  },
                  omitted: {
                    type: "integer",
                    minimum: 0,
                    maximum: 9007199254740991,
                  },
                  entries: {
                    type: "array",
                    items: {
                      oneOf: [
                        {
                          type: "object",
                          properties: {
                            state: {
                              type: "string",
                              const: "live",
                            },
                            role: {
                              type: "string",
                              enum: ["worker", "assistant"],
                            },
                            subject: {
                              type: "object",
                              properties: {
                                hostId: {
                                  type: "string",
                                  minLength: 1,
                                  maxLength: 64,
                                },
                                scope: {
                                  oneOf: [
                                    {
                                      type: "object",
                                      properties: {
                                        kind: {
                                          type: "string",
                                          const: "project",
                                        },
                                        projectId: {
                                          type: "string",
                                          minLength: 1,
                                          maxLength: 256,
                                        },
                                      },
                                      required: ["kind", "projectId"],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        kind: {
                                          type: "string",
                                          const: "global",
                                        },
                                      },
                                      required: ["kind"],
                                      additionalProperties: false,
                                    },
                                  ],
                                },
                                terminalId: {
                                  type: "string",
                                  minLength: 1,
                                  maxLength: 256,
                                },
                                incarnation: {
                                  type: "integer",
                                  minimum: 0,
                                  maximum: 9007199254740991,
                                },
                                lane: {
                                  type: "integer",
                                  minimum: 0,
                                  maximum: 2,
                                },
                              },
                              required: ["hostId", "scope", "terminalId", "incarnation"],
                              additionalProperties: false,
                            },
                            agentId: {
                              type: ["string", "null"],
                            },
                            agentState: {
                              anyOf: [
                                {
                                  type: "string",
                                  enum: [
                                    "idle",
                                    "working",
                                    "waiting",
                                    "directing",
                                    "completed",
                                    "exited",
                                  ],
                                },
                                {
                                  type: "null",
                                },
                              ],
                            },
                            waitingReason: {
                              anyOf: [
                                {
                                  type: "string",
                                  enum: ["prompt", "question", "approval", "error"],
                                },
                                {
                                  type: "null",
                                },
                              ],
                            },
                            since: {
                              type: ["number", "null"],
                            },
                            label: {
                              type: ["string", "null"],
                            },
                            attached: {
                              type: ["boolean", "null"],
                            },
                            handback: {
                              anyOf: [
                                {
                                  type: "object",
                                  properties: {
                                    observedAt: {
                                      type: "number",
                                    },
                                  },
                                  required: ["observedAt"],
                                  additionalProperties: false,
                                },
                                {
                                  type: "null",
                                },
                              ],
                            },
                            confirmations: {
                              type: "object",
                              properties: {
                                waiting: {
                                  maxItems: 4,
                                  type: "array",
                                  items: {
                                    type: "object",
                                    properties: {
                                      actionId: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 128,
                                      },
                                      since: {
                                        type: "number",
                                      },
                                      expiresAt: {
                                        type: "number",
                                      },
                                    },
                                    required: ["actionId", "since", "expiresAt"],
                                    additionalProperties: false,
                                  },
                                },
                                omitted: {
                                  type: "integer",
                                  minimum: 0,
                                  maximum: 9007199254740991,
                                },
                              },
                              required: ["waiting", "omitted"],
                              additionalProperties: false,
                            },
                            notices: {
                              anyOf: [
                                {
                                  type: "object",
                                  properties: {
                                    pending: {
                                      type: "integer",
                                      minimum: 0,
                                      maximum: 9007199254740991,
                                    },
                                    ready: {
                                      type: "integer",
                                      minimum: 0,
                                      maximum: 9007199254740991,
                                    },
                                    delivery: {
                                      type: "string",
                                      enum: [
                                        "idle",
                                        "scheduled",
                                        "held",
                                        "blocked",
                                        "outstanding",
                                        "failed",
                                      ],
                                    },
                                  },
                                  required: ["pending", "ready", "delivery"],
                                  additionalProperties: false,
                                },
                                {
                                  type: "null",
                                },
                              ],
                            },
                          },
                          required: [
                            "state",
                            "role",
                            "subject",
                            "agentId",
                            "agentState",
                            "waitingReason",
                            "since",
                            "label",
                            "attached",
                            "handback",
                          ],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            state: {
                              type: "string",
                              const: "resumable",
                            },
                            role: {
                              type: "string",
                              const: "assistant",
                            },
                            hostId: {
                              type: "string",
                              minLength: 1,
                              maxLength: 64,
                            },
                            scope: {
                              type: "object",
                              properties: {
                                kind: {
                                  type: "string",
                                  const: "project",
                                },
                                projectId: {
                                  type: "string",
                                  minLength: 1,
                                  maxLength: 256,
                                },
                              },
                              required: ["kind", "projectId"],
                              additionalProperties: false,
                            },
                            lane: {
                              type: "integer",
                              minimum: 0,
                              maximum: 2,
                            },
                            agentId: {
                              type: ["string", "null"],
                            },
                            capturedAt: {
                              type: "number",
                            },
                          },
                          required: [
                            "state",
                            "role",
                            "hostId",
                            "scope",
                            "lane",
                            "agentId",
                            "capturedAt",
                          ],
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                },
                required: ["coverage", "observedAt", "complete", "omitted", "entries"],
                additionalProperties: false,
              },
            },
            required: [
              "hostId",
              "name",
              "connection",
              "link",
              "build",
              "agentClis",
              "rttMs",
              "lastSeenAt",
              "load",
              "agentsObserved",
              "projects",
              "projectInventory",
              "control",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["hosts"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "List hosts",
  },
  {
    band: "reversible",
    category: "help",
    danger: "safe",
    description:
      "Read or change named settings on hosts, such as turning Canopy on across several. preview returns a ticket and changes nothing; apply asks the person to approve exactly that preview, then writes it. Never this machine's own settings.",
    enabled: true,
    id: "host.settings",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "preview", "apply"],
          description:
            "read: current values. preview: what patch would change, and a ticket. apply: run it.",
        },
        hostIds: {
          description: "For read and preview: the exact hosts, up to 8.",
          minItems: 1,
          maxItems: 8,
          type: "array",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "A host id from the host list.",
          },
        },
        keys: {
          description: "For read: which settings, up to 5. Default: all.",
          maxItems: 5,
          type: "array",
          items: {
            type: "string",
            enum: [
              "canopyMode",
              "agentDefaults.defaultAgent",
              "agentDefaults.assistantAgentId",
              "idleTerminalNotify.enabled",
              "idleTerminalNotify.thresholdMinutes",
            ],
          },
        },
        patch: {
          description: "For preview: values to set on every host named.",
          type: "object",
          properties: {
            canopyMode: {
              type: "string",
              enum: ["unset", "on", "hidden"],
            },
            "agentDefaults.defaultAgent": {
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                },
                {
                  type: "null",
                },
              ],
            },
            "agentDefaults.assistantAgentId": {
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                },
                {
                  type: "null",
                },
              ],
            },
            "idleTerminalNotify.enabled": {
              type: "boolean",
            },
            "idleTerminalNotify.thresholdMinutes": {
              type: "integer",
              minimum: 15,
              maximum: 1440,
            },
          },
          additionalProperties: false,
        },
        ticket: {
          description:
            "For apply: a preview's ticket. The person approves it in a dialog here first.",
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ["operation"],
    },
    keywords: ["host", "remote", "settings", "canopy", "enable", "configure"],
    kind: "command",
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    name: "host.settings",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "ok",
            "ambiguous",
            "opted_out",
            "disconnected",
            "unsupported",
            "policy_rejected",
            "expired",
            "not_found",
            "rate_limited",
            "too_large",
            "conflict",
          ],
        },
        detail: {
          type: ["string", "null"],
        },
        retryAfterMs: {
          type: ["number", "null"],
        },
        ticket: {
          type: ["string", "null"],
        },
        hosts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hostId: {
                type: "string",
              },
              name: {
                type: "string",
              },
              outcome: {
                type: "string",
                enum: [
                  "ok",
                  "ambiguous",
                  "opted_out",
                  "disconnected",
                  "unsupported",
                  "policy_rejected",
                  "expired",
                  "not_found",
                  "rate_limited",
                  "too_large",
                  "conflict",
                ],
              },
              detail: {
                type: ["string", "null"],
              },
              settings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: {
                      type: "string",
                      enum: [
                        "canopyMode",
                        "agentDefaults.defaultAgent",
                        "agentDefaults.assistantAgentId",
                        "idleTerminalNotify.enabled",
                        "idleTerminalNotify.thresholdMinutes",
                      ],
                    },
                    value: {
                      type: ["string", "number", "boolean", "null"],
                    },
                    proposed: {
                      type: ["string", "number", "boolean", "null"],
                    },
                  },
                  required: ["key", "value"],
                  additionalProperties: false,
                },
              },
            },
            required: ["hostId", "name", "outcome", "detail", "settings"],
            additionalProperties: false,
          },
        },
      },
      required: ["outcome", "detail", "retryAfterMs", "ticket", "hosts"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Change a host's settings",
  },
  {
    band: "reversible",
    category: "help",
    danger: "safe",
    description:
      "One notice when a host's link, or a fresh load sample, is first seen meeting your condition, so you can end your turn. It only observes: never dials or holds the host, never acts. Watches expire; cancel or list yours.",
    enabled: true,
    id: "host.watch",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["arm", "cancel", "list"],
          description:
            "arm: one notice when first observed. cancel: end one. list: yours, armed and ended.",
        },
        hostId: {
          description: "For arm: the host. For list: only that host.",
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
        connection: {
          description: "Arm on the link: fires once it is seen in this state for 5s.",
          type: "string",
          enum: ["connected", "disconnected"],
        },
        memoryAvailableBytesAtLeast: {
          description: "Arm on capacity instead: all given figures met by a fresh sample.",
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
        cpuIdleCoresAtLeast: {
          type: "number",
          minimum: 0,
          maximum: 4096,
        },
        memoryPressureAtMost: {
          type: "string",
          enum: ["normal", "warn"],
        },
        expiresInSeconds: {
          description: "Default 1800.",
          type: "integer",
          minimum: 60,
          maximum: 21600,
        },
        note: {
          description: "Echoed in the notice.",
          type: "string",
          maxLength: 160,
        },
        watchId: {
          description: "For cancel.",
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ["operation"],
    },
    keywords: ["host", "remote", "watch", "notify", "reconnect", "capacity", "wake"],
    kind: "command",
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    name: "host.watch",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "ok",
            "ambiguous",
            "opted_out",
            "disconnected",
            "unsupported",
            "policy_rejected",
            "expired",
            "not_found",
            "rate_limited",
            "too_large",
            "conflict",
          ],
        },
        detail: {
          type: ["string", "null"],
        },
        retryAfterMs: {
          type: ["number", "null"],
        },
        armed: {
          type: "boolean",
        },
        watches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              watchId: {
                type: "string",
              },
              hostId: {
                type: "string",
              },
              hostName: {
                type: "string",
              },
              condition: {
                type: "object",
                properties: {
                  connection: {
                    anyOf: [
                      {
                        type: "string",
                        enum: ["connected", "disconnected"],
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  memoryAvailableBytesAtLeast: {
                    type: ["number", "null"],
                  },
                  cpuIdleCoresAtLeast: {
                    type: ["number", "null"],
                  },
                  memoryPressureAtMost: {
                    anyOf: [
                      {
                        type: "string",
                        enum: ["normal", "warn"],
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                },
                required: [
                  "connection",
                  "memoryAvailableBytesAtLeast",
                  "cpuIdleCoresAtLeast",
                  "memoryPressureAtMost",
                ],
                additionalProperties: false,
              },
              note: {
                type: ["string", "null"],
              },
              armedAt: {
                type: "number",
              },
              expiresAt: {
                type: "number",
              },
              status: {
                type: "string",
                enum: ["armed", "fired", "expired", "cancelled", "lost"],
              },
              endedAt: {
                type: ["number", "null"],
              },
              lostReason: {
                anyOf: [
                  {
                    type: "string",
                    enum: ["host-removed", "control-off"],
                  },
                  {
                    type: "null",
                  },
                ],
              },
              observed: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      observedAt: {
                        type: "number",
                      },
                      link: {
                        type: "string",
                        enum: [
                          "local",
                          "disconnected",
                          "connecting",
                          "connected",
                          "unreachable",
                          "version-mismatch",
                          "driven-elsewhere",
                        ],
                      },
                      lastSeenAt: {
                        type: ["number", "null"],
                      },
                      sampledAt: {
                        type: ["number", "null"],
                      },
                      stale: {
                        type: "boolean",
                      },
                      memoryAvailableBytes: {
                        type: ["number", "null"],
                      },
                      cpuIdleCores: {
                        type: ["number", "null"],
                      },
                      memoryPressure: {
                        anyOf: [
                          {
                            type: "string",
                            enum: ["normal", "warn", "critical"],
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                    },
                    required: [
                      "observedAt",
                      "link",
                      "lastSeenAt",
                      "sampledAt",
                      "stale",
                      "memoryAvailableBytes",
                      "cpuIdleCores",
                      "memoryPressure",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              delivery: {
                type: "string",
                enum: [
                  "none",
                  "queued",
                  "held",
                  "delivered",
                  "unavailable",
                  "ambiguous",
                  "withdrawn",
                ],
              },
            },
            required: [
              "watchId",
              "hostId",
              "hostName",
              "condition",
              "note",
              "armedAt",
              "expiresAt",
              "status",
              "endedAt",
              "lostReason",
              "observed",
              "delivery",
            ],
            additionalProperties: false,
          },
        },
        observed: {
          anyOf: [
            {
              type: "object",
              properties: {
                observedAt: {
                  type: "number",
                },
                link: {
                  type: "string",
                  enum: [
                    "local",
                    "disconnected",
                    "connecting",
                    "connected",
                    "unreachable",
                    "version-mismatch",
                    "driven-elsewhere",
                  ],
                },
                lastSeenAt: {
                  type: ["number", "null"],
                },
                sampledAt: {
                  type: ["number", "null"],
                },
                stale: {
                  type: "boolean",
                },
                memoryAvailableBytes: {
                  type: ["number", "null"],
                },
                cpuIdleCores: {
                  type: ["number", "null"],
                },
                memoryPressure: {
                  anyOf: [
                    {
                      type: "string",
                      enum: ["normal", "warn", "critical"],
                    },
                    {
                      type: "null",
                    },
                  ],
                },
              },
              required: [
                "observedAt",
                "link",
                "lastSeenAt",
                "sampledAt",
                "stale",
                "memoryAvailableBytes",
                "cpuIdleCores",
                "memoryPressure",
              ],
              additionalProperties: false,
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: ["outcome", "detail", "retryAfterMs", "armed", "watches", "observed"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Watch a host",
  },
];
