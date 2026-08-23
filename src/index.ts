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

export default (async (_input, options) => {
  return {
    config: async (cfg: Config) => {
      const config = cfg as ConfigWithSkills;
      const extra = Array.isArray(options?.extraRoots)
        ? (options.extraRoots as string[])
        : [];
      const scanCache = options?.scanCache !== false;
      const scanNodeModules = options?.scanNodeModules !== false;
      const mcpEnabled = options?.mcp === true;
      const agentsEnabled = options?.agents === true;

      const packages: PluginPackage[] = [];
      collectClaude(packages);
      collectVscode(packages, extra);
      if (scanCache) {
        collectOpencodeCache(join(opencodeCacheRoot(), "packages"), packages);
      }
      if (scanNodeModules) {
        collectNodeModules(join(process.cwd(), "node_modules"), packages, false);
      }

      const plan = planConfig(packages, {
        commands: Object.keys(config.command ?? {}),
        mcp: Object.keys(config.mcp ?? {}),
        agents: Object.keys(config.agent ?? {}),
      });

      applyConfigPatch(config, plan, { mcp: mcpEnabled, agents: agentsEnabled });
    },
  };
}) satisfies Plugin;
