#!/usr/bin/env node

// Thin stdio entry: environment parsing plus transport wiring only. The
// McpServer construction and all tool registrations live in server-core.ts so
// the remote Streamable HTTP endpoint at /mcp serves the identical contract.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNamingSignalMcpServer, DEFAULT_API_URL } from "./server-core";

const apiBase = (process.env.NAMING_SIGNAL_API_URL?.trim() || process.env.NAME_LEDGER_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
const apiKey = process.env.NAMING_SIGNAL_API_KEY?.trim();

async function main() {
  const server = createNamingSignalMcpServer({ baseUrl: apiBase, apiKey });
  await server.connect(new StdioServerTransport());
  console.error(`NamingSignal MCP connected over stdio; API: ${apiBase}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
