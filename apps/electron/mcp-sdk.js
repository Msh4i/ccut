// MCP server (round 8): where the official SDK comes from. The packaged app has no node_modules
// ("!**/node_modules/**"), so bundle.js builds vendor/mcp-sdk.cjs (mcp-vendor.js); in development
// and in the tests the packages themselves are used. Both give the same three things.
function loadSdk() {
	try {
		return require("./vendor/mcp-sdk.cjs");
	} catch (error) {
		if (error?.code !== "MODULE_NOT_FOUND") throw error;
	}
	return require("./mcp-sdk-entry");
}

module.exports = { loadSdk };
