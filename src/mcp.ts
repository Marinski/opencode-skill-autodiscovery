import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";
import { MCP_SCHEMA, VERSION, validateName } from "./schema.js";
import type { PluginPackage } from "./discovery.js";

export type McpEntry =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    };

const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set(["type", "url", "headers"]);
const HTTP_URL = /^https?:\/\//;

function opencodeStateRoot(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "opencode");
}

export function pluginDataRoot(name: string): string {
  return join(opencodeStateRoot(), "plugin-data", name);
}

function expandPluginVars(value: string, root: string, dataDir: string): string {
  return value
    .split("${PLUGIN_ROOT}")
    .join(root)
    .split("${PLUGIN_DATA}")
    .join(dataDir);
}

function collectHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  return headers;
}

function hasUnknownKeys(
  server: Record<string, unknown>,
  allowed: Set<string>,
): boolean {
  return Object.keys(server).some((k) => !allowed.has(k));
}

// Maps the portable mcp.json shape onto opencode's native config.mcp. Per the
// Agent Plugins spec, failures are per-entry (and per-package for an invalid
// mcp.json): a bad server never blocks other servers or the package's skills.
export function readMcp(
  pkg: PluginPackage,
  out: Array<{ key: string; entry: McpEntry }>,
): void {
  if (!pkg.mcpPath) return;
  let raw: string;
  try {
    raw = readFileSync(pkg.mcpPath, "utf8");
  } catch {
    return;
  }
  let parsed: { $schema?: unknown; mcpServers?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`ignoring mcp.json for package "${pkg.name}": not valid JSON`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    log(`ignoring mcp.json for package "${pkg.name}": not an object`);
    return;
  }
  if (typeof parsed.$schema !== "string" || !MCP_SCHEMA.test(parsed.$schema)) {
    log(`ignoring mcp.json for package "${pkg.name}": unsupported or missing $schema`);
    return;
  }
  const mcpVersion = VERSION.exec(parsed.$schema)?.[1];
  if (pkg.schemaVersion && mcpVersion && mcpVersion !== pkg.schemaVersion) {
    log(
      `ignoring mcp.json for package "${pkg.name}": schema version ${mcpVersion} does not match plugin.json (${pkg.schemaVersion})`,
    );
    return;
  }
  if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null) {
    log(`ignoring mcp.json for package "${pkg.name}": missing mcpServers`);
    return;
  }

  const dataDir = pluginDataRoot(pkg.name);
  const servers = parsed.mcpServers as Record<string, unknown>;
  for (const [name, serverValue] of Object.entries(servers)) {
    // mcp.json server keys are package-supplied input: gate the name before
    // it becomes any config key (applyConfigPatch writes config.mcp[key]).
    if (!validateName(name)) {
      log(
        `skipping MCP server key for package "${pkg.name}" (${pkg.source}): invalid name "${name}" (must match the identifier pattern and not be a prototype-chain key)`,
      );
      continue;
    }
    if (typeof serverValue !== "object" || serverValue === null) {
      log(`skipping MCP server "${pkg.name}/${name}": invalid entry`);
      continue;
    }
    const server = serverValue as Record<string, unknown>;

    if (server.type === "stdio") {
      if (hasUnknownKeys(server, STDIO_KEYS)) {
        log(`skipping MCP server "${pkg.name}/${name}": unknown fields in stdio entry`);
        continue;
      }
      if (typeof server.command !== "string" || server.command.length === 0) {
        log(`skipping MCP server "${pkg.name}/${name}": stdio requires a string command`);
        continue;
      }
      const command = server.command.startsWith("./")
        ? join(pkg.root, server.command)
        : server.command;
      const args = Array.isArray(server.args)
        ? server.args
            .filter((a): a is string => typeof a === "string")
            .map((a) => expandPluginVars(a, pkg.root, dataDir))
        : [];
      const environment: Record<string, string> = {};
      if (typeof server.env === "object" && server.env !== null) {
        for (const [k, v] of Object.entries(
          server.env as Record<string, unknown>,
        )) {
          if (k === "PLUGIN_ROOT" || k === "PLUGIN_DATA") {
            log(`dropping reserved env key "${k}" for MCP server "${pkg.name}/${name}"`);
            continue;
          }
          if (typeof v === "string") {
            environment[k] = expandPluginVars(v, pkg.root, dataDir);
          }
        }
      }
      environment.PLUGIN_ROOT = pkg.root;
      environment.PLUGIN_DATA = dataDir;
      if (server.cwd !== undefined) {
        const cwd =
          typeof server.cwd === "string"
            ? expandPluginVars(server.cwd, pkg.root, dataDir)
            : String(server.cwd);
        log(`dropping cwd "${cwd}" for MCP server "${pkg.name}/${name}": opencode has no cwd support`);
      }
      try {
        mkdirSync(dataDir, { recursive: true });
      } catch {
        // Non-fatal: the subprocess env still points at the (uncreated) dir.
      }
      out.push({
        key: name,
        entry: { type: "local", command: [command, ...args], environment, enabled: true },
      });
    } else if (server.type === "streamable-http") {
      if (hasUnknownKeys(server, HTTP_KEYS)) {
        log(`skipping MCP server "${pkg.name}/${name}": unknown fields in streamable-http entry`);
        continue;
      }
      if (typeof server.url !== "string" || server.url.length === 0) {
        log(`skipping MCP server "${pkg.name}/${name}": streamable-http requires a string url`);
        continue;
      }
      if (!HTTP_URL.test(server.url)) {
        log(`skipping MCP server "${pkg.name}/${name}": url must be an absolute http(s) URL`);
        continue;
      }
      out.push({
        key: name,
        entry: {
          type: "remote",
          url: server.url,
          headers: collectHeaders(server.headers),
          enabled: true,
        },
      });
    } else if (server.type === "sse") {
      if (hasUnknownKeys(server, HTTP_KEYS)) {
        log(`skipping MCP server "${pkg.name}/${name}": unknown fields in sse entry`);
        continue;
      }
      if (typeof server.url !== "string" || !HTTP_URL.test(server.url)) {
        log(`skipping MCP server "${pkg.name}/${name}": sse requires an absolute http(s) url`);
        continue;
      }
      log(`skipping MCP server "${pkg.name}/${name}": opencode does not support the sse transport`);
    } else {
      log(`skipping MCP server "${pkg.name}/${name}": unknown transport "${String(server.type)}"`);
    }
  }
}
