import { join } from "node:path";
import type { Plugin, Config } from "@opencode-ai/plugin";
import {
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

      const packages: PluginPackage[] = [];
      collectClaude(packages);
      collectVscode(packages, extra);
      if (scanCache) {
        collectOpencodeCache(join(opencodeCacheRoot(), "packages"), packages);
      }
      if (scanNodeModules) {
        collectNodeModules(join(process.cwd(), "node_modules"), packages);
      }

      const plan = planConfig(packages, {
        commands: Object.keys(config.command ?? {}),
        mcp: Object.keys(config.mcp ?? {}),
      });

      if (plan.skillPaths.length === 0 && !mcpEnabled) return;

      if (plan.skillPaths.length > 0) {
        config.skills ??= {};
        config.skills.paths ??= [];
        for (const dir of plan.skillPaths) {
          if (!config.skills.paths.includes(dir)) {
            config.skills.paths.push(dir);
          }
        }
      }

      config.command ??= {};
      for (const cmd of plan.commands) {
        if (config.command[cmd.name]) continue;
        config.command[cmd.name] = {
          description: cmd.description,
          template: cmd.template,
        };
      }

      if (mcpEnabled) {
        config.mcp ??= {};
        for (const { key, entry } of plan.mcp) {
          if (config.mcp[key]) continue;
          config.mcp[key] = entry;
        }
      }
    },
  };
}) satisfies Plugin;
