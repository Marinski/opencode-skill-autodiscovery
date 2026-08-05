import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin, Config } from "@opencode-ai/plugin";

type ConfigWithSkills = Config & {
  skills?: {
    paths?: string[];
    urls?: string[];
  };
};

type CacheEntry = { uri?: string; nonce?: string };

// VS Code keeps agent plugins in a per-platform "data dir". The holding
// folder is named `agent-plugins` on older builds (e.g. ~/.vscode) and
// `agentPlugins` on newer builds; remote servers nest theirs under `data/`
// (~/.vscode-server/data/agentPlugins). We list every known candidate so the
// discovery works regardless of OS, build channel, or local/remote setup.
function vsCodeDataRoots(extra: string[]): string[] {
  const home = homedir();
  const roots = new Set<string>([
    join(home, ".vscode"),
    // Linux
    join(home, ".config", "Code"),
    join(home, ".config", "Code - Insiders"),
    // macOS
    join(home, "Library", "Application Support", "Code"),
    join(home, "Library", "Application Support", "Code - Insiders"),
    // Windows
    ...(process.env.APPDATA
      ? [
          join(process.env.APPDATA, "Code"),
          join(process.env.APPDATA, "Code - Insiders"),
        ]
      : []),
    // Remote hosts (Remote-SSH, Dev Containers, Codespaces, WSL)
    join(home, ".vscode-server"),
    join(home, ".vscode-server-insiders"),
    join(home, ".vscode-remote"),
  ]);
  for (const root of extra) roots.add(root);
  return [...roots];
}

function agentPluginDirs(roots: string[]): string[] {
  const dirs = new Set<string>();
  for (const root of roots) {
    dirs.add(join(root, "agent-plugins"));
    dirs.add(join(root, "agentPlugins"));
    dirs.add(join(root, "data", "agent-plugins"));
    dirs.add(join(root, "data", "agentPlugins"));
  }
  return [...dirs];
}

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
    if (entry === ".git") continue;
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

// Remote hosts: VS Code syncs client skills into
// {data}/agentPlugins/{sanitizedUri}/{nonce}/ and records the LRU in
// cache.json. Resolve each entry so the materialized synced-customization
// bundle ("VS Code Synced Data" Open Plugin, skills/<name>/SKILL.md) is
// discovered.
function collectVscodeCache(out: Set<string>, cacheJson: string): void {
  if (!existsSync(cacheJson)) return;
  let entries: CacheEntry[];
  try {
    entries = JSON.parse(readFileSync(cacheJson, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;
  const parent = dirname(cacheJson);
  for (const entry of entries) {
    if (typeof entry?.uri !== "string") continue;
    const key = sanitizeKey(entry.uri) || "default";
    const nonce =
      typeof entry.nonce === "string" && entry.nonce
        ? sanitizeKey(entry.nonce)
        : "default";
    findSkillDirs(join(parent, key, nonce), out, new Set());
    // Some remote builds materialize the synced bundle directly as
    // {parent}/{key}/skills/... without the {nonce} subdirectory.
    findSkillDirs(join(parent, key), out, new Set());
  }
}

// Mirrors the server-side AgentPluginManager sanitizer so we can resolve the
// cache.json entries to their on-disk directories.
function sanitizeKey(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 128);
}

function collectAgentPluginRoot(out: Set<string>, root: string): void {
  const installedJson = join(root, "installed.json");
  const cacheJson = join(root, "cache.json");
  const hasManifest = existsSync(installedJson) || existsSync(cacheJson);
  collectVscodeManifest(out, installedJson);
  collectVscodeCache(out, cacheJson);
  // Newer VS Code installs marketplaces directly as {host}/{org}/{repo}
  // subdirectories with no manifest file at all. Fall back to a full tree walk
  // only when no metadata exists, so we don't surface skills from cloned-but-
  // not-installed marketplaces on setups that do have a manifest.
  if (!hasManifest) {
    findSkillDirs(root, out, new Set());
  }
}

function collectVscode(out: Set<string>, extra: string[]): void {
  for (const dir of agentPluginDirs(vsCodeDataRoots(extra))) {
    collectAgentPluginRoot(out, dir);
  }
}

function collectClaudeManifest(out: Set<string>, installedJson: string): void {
  if (!existsSync(installedJson)) return;
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    manifest = JSON.parse(readFileSync(installedJson, "utf8"));
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

function collectClaude(out: Set<string>): void {
  const home = homedir();
  const installedJsons = [
    join(home, ".claude", "plugins", "installed_plugins.json"),
    join(home, ".claude", "remote", "plugins", "installed_plugins.json"),
  ];
  let found = false;
  for (const installedJson of installedJsons) {
    if (existsSync(installedJson)) {
      found = true;
      collectClaudeManifest(out, installedJson);
    }
  }
  // Remote hosts sync Claude plugins as {nonce}/ dirs with per-plugin
  // manifest.json but no installed_plugins.json; tree-walk the remote plugins
  // dir as a fallback so those skills are discovered too.
  if (!found) {
    const remoteRoot = join(home, ".claude", "remote", "plugins");
    if (existsSync(remoteRoot)) {
      findSkillDirs(remoteRoot, out, new Set());
    }
  }
}

export default (async (_input, options) => {
  return {
    config: async (cfg: Config) => {
      const config = cfg as ConfigWithSkills;
      const extra = Array.isArray(options?.extraRoots) ? options.extraRoots : [];
      const dirs = new Set<string>();
      collectVscode(dirs, extra);
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
