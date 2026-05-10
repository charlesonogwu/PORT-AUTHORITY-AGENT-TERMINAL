import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * Build the MCP server, registering one tool per CLI verb. The MCP server
 * shares the same core library as the CLI, so behaviour stays consistent.
 */
export declare function buildMcpServer(): McpServer;
/**
 * Run the portpilot MCP server over stdio. This is the entrypoint used by
 * `portpilot mcp`.
 */
export declare function runMcpStdio(): Promise<void>;
