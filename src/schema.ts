// Shared Agent Plugins schema identifiers and constraints. Kept in one module
// so the plugin manifest, MCP config, and version-match logic never drift.

export const PLUGIN_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/plugin\.schema\.json$/;

export const MCP_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/mcp\.schema\.json$/;

export const VERSION = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\//;

// Manifest `name` constraints (Agent Plugins spec 5.5): 1-64 chars, lowercase
// alphanumeric plus `-`/`.`, alphanumeric start/end, no `--` or `..`.
export const NAME_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
