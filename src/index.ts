import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Config } from "@opencode-ai/plugin";

type ConfigWithSkills = Config & {
  skills?: {
    paths?: string[];
    urls?: string[];
  };
};

const VSCODE_ROOTS = [
  join(homedir(), ".vscode"),
  join(homedir(), ".vscode-server"),
  join(homedir(), ".vscode-server-insiders"),
  join(homedir(), ".vscode-remote"),
];

const CLAUDE_INSTALLED = join(
  homedir(),
  ".claude",
  "plugins",
  "installed_plugins.json",
);

function findSkillDirs(root: string, out: Set<string>, seen: Set<string>) {
  const resolved = join(root);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(resolved, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (existsSync(join(full, "SKILL.md"))) {
        out.add(full);
      } else {
        findSkillDirs(full, out, seen);
      }
    }
  }
}

function vscodePluginPath(pluginUri: string): string | null {
  const m = /^file:\/\/(.+)$/.exec(pluginUri);
  if (!m) return pluginUri;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]);
  } catch {
    raw = m[1];
  }
  if (raw.startsWith("/")) raw = raw.slice(1);
  return raw;
}

function collectVscodeManifest(out: Set<string>, installedJson: string): void {
  if (!existsSync(installedJson)) return;
  let manifest: { installed?: Array<{ pluginUri?: string }> };
  try {
    manifest = JSON.parse(readFileSync(installedJson, "utf8"));
  } catch {
    return;
  }
  for (const plugin of manifest.installed ?? []) {
    if (!plugin.pluginUri) continue;
    const dir = vscodePluginPath(plugin.pluginUri);
    if (dir) findSkillDirs(dir, out, new Set());
  }
}

function collectVscode(out: Set<string>, roots: string[]): void {
  for (const root of roots) {
    collectVscodeManifest(out, join(root, "agent-plugins", "installed.json"));
    collectVscodeManifest(
      out,
      join(root, "data", "agent-plugins", "installed.json"),
    );
  }
}

function collectClaude(out: Set<string>): void {
  if (!existsSync(CLAUDE_INSTALLED)) return;
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    manifest = JSON.parse(readFileSync(CLAUDE_INSTALLED, "utf8"));
  } catch {
    return;
  }
  for (const versions of Object.values(manifest.plugins ?? {})) {
    for (const plugin of versions) {
      if (plugin.installPath) {
        findSkillDirs(plugin.installPath, out, new Set());
      }
    }
  }
}

export default (async (_input, options) => {
  return {
    config: async (cfg: Config) => {
      const config = cfg as ConfigWithSkills;
      const roots = VSCODE_ROOTS;
      const extra = Array.isArray(options?.extraRoots) ? options.extraRoots : [];
      const dirs = new Set<string>();
      collectVscode(dirs, [...roots, ...extra]);
      collectClaude(dirs);
      if (dirs.size === 0) return;
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const dir of dirs) {
        const name = dir.split(/[\\/]/).pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        unique.push(dir);
      }
      config.skills ??= {};
      config.skills.paths ??= [];
      for (const dir of unique) {
        if (!config.skills.paths.includes(dir)) {
          config.skills.paths.push(dir);
        }
      }
    },
  };
}) satisfies Plugin;
