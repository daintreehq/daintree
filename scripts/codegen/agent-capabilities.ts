import { writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { format, resolveConfig } from "prettier";
import {
  CapabilitySearchActionSchema,
  CapabilitySearchResultSchema,
  CapabilityGetActionSchema,
  CapabilityGetResultSchema,
} from "../../shared/types/agentCapabilities.js";

const contract = [
  {
    name: "agentCapabilities.search",
    inputSchema: z.toJSONSchema(CapabilitySearchActionSchema),
    outputSchema: z.toJSONSchema(CapabilitySearchResultSchema),
  },
  {
    name: "agentCapabilities.get",
    inputSchema: z.toJSONSchema(CapabilityGetActionSchema),
    outputSchema: z.toJSONSchema(CapabilityGetResultSchema),
  },
];
mkdirSync("docs/contracts", { recursive: true });
writeFileSync(
  "docs/contracts/agent-capabilities.json",
  await format(JSON.stringify(contract), {
    ...(await resolveConfig("docs/contracts/agent-capabilities.json")),
    parser: "json",
  })
);
