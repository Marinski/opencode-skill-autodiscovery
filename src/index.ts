import { join } from "node:path";
import type { Plugin, Config } from "@opencode-ai/plugin";
import {
  applyConfigPatch,
  collectClaude,
  collectNodeModules,
  collectOpencodeCache,
  collectVscode,
  opencodeCacheRoot,
  planConfig,
} from "./discovery.js";
import type { PluginPackage } from "./discovery.js";

type ConfigWithSkills = Config & {
  skills?: {
    paths?: string[];
    urls?: string[];
  };
};

// Per-package consent option: package names whose MCP servers / agents are
// wanted even when the package is discovered as untrusted. Complements
// `exclude` (the deny side) and the global `mcp` / `agents` switches (the
// coarse on-switch); consent refines it for untrusted packages.
export type ConsentMap = {
  mcp: string[];
  agents: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Normalizes the `consent` option. Any malformed shape degrades to the empty
// map (no consent), so behavior is identical to when the option is absent.
export function parseConsent(raw: unknown): ConsentMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { mcp: [], agents: [] };
  }
  const consent = raw as Record<string, unknown>;
  return {
    mcp: isStringArray(consent.mcp) ? consent.mcp : [],
    agents: isStringArray(consent.agents) ? consent.agents : [],
  };
}

export default (async (_input, options) => {
  return {
    config: async (cfg: Config) => {
      const config = cfg as ConfigWithSkills;
      const extra = Array.isArray(options?.extraRoots)
        ? (options.extraRoots as string[])
        : [];
      const scanCache = options?.scanCache === true;
      const scanNodeModules = options?.scanNodeModules === true;
      const mcpEnabled = options?.mcp === true;
      const agentsEnabled = options?.agents === true;
      const exclude = Array.isArray(options?.exclude)
        ? (options.exclude as string[])
        : [];
      // Consent refines the mcp switch for untrusted packages: consent.mcp
      // admits a package's servers by name when mcp:true is on. Agents
      // consent is parsed and carried for the same gate; nothing here makes
      // an untrusted package register without its switch on.
      const consent = parseConsent(options?.consent);

      const packages: PluginPackage[] = [];
      collectClaude(packages, exclude);
      collectVscode(packages, extra, exclude);
      if (scanCache) {
        collectOpencodeCache(join(opencodeCacheRoot(), "packages"), packages, exclude);
      }
      if (scanNodeModules) {
        collectNodeModules(join(process.cwd(), "node_modules"), packages, false, exclude);
      }

      const plan = planConfig(
        packages,
        {
          commands: Object.keys(config.command ?? {}),
          mcp: Object.keys(config.mcp ?? {}),
          agents: Object.keys(config.agent ?? {}),
        },
        { mcp: mcpEnabled, agents: agentsEnabled },
        { mcp: consent.mcp, agents: consent.agents },
      );

      applyConfigPatch(config, plan, { mcp: mcpEnabled, agents: agentsEnabled });
    },
  };
}) satisfies Plugin;
