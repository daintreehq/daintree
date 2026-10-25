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
      "List the hosts this assistant reaches, this machine first as local, as observed: connection, load sample, agent counts and each connected host's projects, which calls name. Null means unmeasured.",
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
                      },
                      ageMs: {
                        type: "number",
                      },
                      stale: {
                        type: "boolean",
                        description:
                          "Too old to trust: the live figures below are null. Not a zero reading.",
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
                      "ageMs",
                      "stale",
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
              "rttMs",
              "lastSeenAt",
              "load",
              "agentsObserved",
              "projects",
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
];
