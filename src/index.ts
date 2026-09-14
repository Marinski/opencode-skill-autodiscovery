import { join } from "node:path";
import type { Plugin, Config } from "@opencode-ai/plugin";
import { flushFileCache } from "./cache.js";
import { flushDiscoveryCache } from "./discovery-cache.js";
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

// Per-package consent option: package names whose MCP servers / agents are
// wanted even when the package is discovered as untrusted. Complements
// `exclude` (the deny side) and the global `mcp` / `agents` switches (the
// coarse on-switch); consent refines it for untrusted packages.
export type ConsentMap = {
  mcp: string[];
  agents: string[];
};

function isAllStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Normalizes the `consent` option. Unlike isStringArray above, a malformed
// list degrades the *whole* map entry to [] rather than filtering per-entry:
// consent is an allow-list for otherwise-untrusted package content, so a
// half-valid entry (e.g. one non-string item) should not partially admit it.
// Any malformed shape is identical to the option being absent.
export function parseConsent(raw: unknown): ConsentMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { mcp: [], agents: [] };
  }
  const consent = raw as Record<string, unknown>;
  return {
    mcp: isAllStrings(consent.mcp) ? consent.mcp : [],
    agents: isAllStrings(consent.agents) ? consent.agents : [],
  };
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
      // Consent refines the mcp switch for untrusted packages: consent.mcp
      // admits a package's servers by name when mcp:true is on. Agents
      // consent is parsed and carried for the same gate; nothing here makes
      // an untrusted package register without its switch on.
      const consent = parseConsent(options?.consent);

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
        { mcp: consent.mcp, agents: consent.agents },
      );

      applyConfigPatch(config, plan, { mcp: mcpEnabled, agents: agentsEnabled });
      // Persist both cache layers this scan may have written: the per-file
      // content cache (cache.ts) and the whole-root walk-skip cache
      // (discovery-cache.ts). Both are best-effort and never throw — an
      // unchanged tree on the next opencode startup skips re-reading files
      // via the first, and skips re-walking entirely via the second.
      flushFileCache();
      flushDiscoveryCache();
    },
  };
}) satisfies Plugin;
