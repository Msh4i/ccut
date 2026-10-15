// MCP server (round 8): the entry that esbuild bundles into vendor/mcp-sdk.cjs, and what
// mcp-sdk.js requires directly when there is no bundle. Only what the app uses.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

module.exports = { McpServer, StreamableHTTPServerTransport, z };
