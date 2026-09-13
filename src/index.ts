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
import { log } from "./log.js";

type ConfigWithSkills = Config & {
  skills?: {
    paths?: string[];
    urls?: string[];
  };
};

// Normalizes a plugin option declared as a string array. Non-array values
// degrade to []; non-string entries are dropped individually, so one bad entry
// never discards the valid ones — the same per-entry tolerance the rest of the
// codebase applies to package-supplied arrays (e.g. mcp.json `args`).
function isStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

// Each collector is a best-effort probe of manifest- or filesystem-derived
// state. The individual collectors already fail closed on malformed manifests,
// so this is a backstop: a source that still throws is logged by name and the
// merge continues with the packages collected so far.
function collectSafely(source: string, collect: () => void): void {
  try {
    collect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`collector "${source}" failed: ${detail}`);
  }
}

export default (async (_input, options) => {
  return {
    config: async (cfg: Config) => {
      const config = cfg as ConfigWithSkills;
      const extra = isStringArray(options?.extraRoots);
      const scanCache = options?.scanCache === true;
      const scanNodeModules = options?.scanNodeModules === true;
      const mcpEnabled = options?.mcp === true;
      const agentsEnabled = options?.agents === true;
      const exclude = isStringArray(options?.exclude);

      const packages: PluginPackage[] = [];
      collectSafely("claude", () => collectClaude(packages, exclude));
      collectSafely("vscode", () => collectVscode(packages, extra, exclude));
      if (scanCache) {
        collectSafely("opencode-cache", () =>
          collectOpencodeCache(join(opencodeCacheRoot(), "packages"), packages, exclude),
        );
      }
      if (scanNodeModules) {
        collectSafely("node_modules", () =>
          collectNodeModules(join(process.cwd(), "node_modules"), packages, false, exclude),
        );
      }

      const plan = planConfig(
        packages,
        {
          commands: Object.keys(config.command ?? {}),
          mcp: Object.keys(config.mcp ?? {}),
          agents: Object.keys(config.agent ?? {}),
        },
        { mcp: mcpEnabled, agents: agentsEnabled },
      );

      applyConfigPatch(config, plan, { mcp: mcpEnabled, agents: agentsEnabled });
    },
  };
}) satisfies Plugin;
