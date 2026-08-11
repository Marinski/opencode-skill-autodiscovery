import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { log } from "./log.js";
import { readAgents } from "./agents.js";
import { readMcp } from "./mcp.js";
import { NAME_PATTERN, PLUGIN_SCHEMA, VERSION } from "./schema.js";
import type { AgentConfig } from "./agents.js";
import type { McpEntry } from "./mcp.js";

export { readAgents } from "./agents.js";
export type { AgentConfig } from "./agents.js";
export { readMcp } from "./mcp.js";
export type { McpEntry } from "./mcp.js";

export type PackageSource =
  | "claude"
  | "vscode"
  | "opencode-cache"
  | "node_modules"
  | "extra";

export type PluginPackage = {
  source: PackageSource;
  name: string;
  root: string;
  skillDirs: string[];
  mcpPath?: string;
  /** Agent Plugins version declared by plugin.json, e.g. "1.0.0". */
  schemaVersion?: string;
};

export type SkillInfo = { dir: string; name: string; description: string };

export type ConfigPatch = {
  skillPaths: string[];
  commands: Array<{ name: string; description: string; template: string }>;
  mcp: Array<{ key: string; entry: McpEntry }>;
  agents: Array<{ name: string; agent: AgentConfig }>;
};

export type ConfigLike = {
  skills?: { paths?: string[] };
  command?: Record<string, { description?: string; template: string }>;
  mcp?: Record<string, McpEntry>;
  agent?: Record<string, AgentConfig | undefined>;
};

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// True when `child` resolves (through symlinks) inside `parent`.
export function contains(parent: string, child: string): boolean {
  const p = realpathSync(parent);
  const c = realpathSync(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Parses the YAML frontmatter of a SKILL.md (name, description). Returns null
// when the file is unreadable or lacks a valid `name`.
export function readSkillInfo(dir: string): SkillInfo | null {
  const skillMd = join(dir, "SKILL.md");
  let content: string;
  try {
    content = readFileSync(skillMd, "utf8");
  } catch {
    return null;
  }
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!frontmatter) return null;
  const field = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatter);
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, "");
  };
  const name = field("name");
  if (!name) return null;
  return { dir, name, description: field("description") ?? "" };
}

// Reads a conformant Agent Plugins 1.0.0 package from a directory root.
// Returns null when the root has no valid plugin.json, so callers can fall
// back to legacy discovery. The $schema URL and the manifest name are the
// discriminators that make scanning untrusted directories safe.
export function readPackage(
  root: string,
  source: PackageSource,
): PluginPackage | null {
  const manifestPath = join(root, "plugin.json");
  if (!isRegularFile(manifestPath)) return null;
  let manifest: { $schema?: unknown; name?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  if (typeof manifest.$schema !== "string" || !PLUGIN_SCHEMA.test(manifest.$schema)) {
    return null;
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    manifest.name.length > 64 ||
    !NAME_PATTERN.test(manifest.name)
  ) {
    return null;
  }

  const skillDirs: string[] = [];
  const skillsRoot = join(root, "skills");
  if (isDirectory(skillsRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(skillsRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const dir = join(skillsRoot, entry);
      if (!isDirectory(dir)) continue;
      if (!isRegularFile(join(dir, "SKILL.md"))) continue;
      let resolved: string;
      try {
        resolved = realpathSync(dir);
      } catch {
        continue;
      }
      if (!contains(root, resolved)) continue;
      skillDirs.push(resolved);
    }
  }

  const mcpPath = isRegularFile(join(root, "mcp.json"))
    ? join(root, "mcp.json")
    : undefined;

  return {
    source,
    name: manifest.name,
    root,
    skillDirs,
    mcpPath,
    schemaVersion: VERSION.exec(manifest.$schema)?.[1],
  };
}

// Legacy tree walk: every directory containing a SKILL.md, at any depth.
export function findSkillDirs(root: string, out: Set<string>, seen: Set<string>) {
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
    if (!isDirectory(full)) continue;
    if (isRegularFile(join(full, "SKILL.md"))) {
      out.add(full);
    } else {
      findSkillDirs(full, out, seen);
    }
  }
}

// True when `root` directly carries a plugin-like layout: a `skills/` subtree,
// a flat `agents/` directory of markdown files, a `.claude-plugin/plugin.json`,
// or bare agent markdown files in the root itself.
function hasPluginLayout(root: string): boolean {
  const skillsRoot = join(root, "skills");
  if (isDirectory(skillsRoot)) {
    try {
      if (readdirSync(skillsRoot).some((e) => isRegularFile(join(skillsRoot, e, "SKILL.md")))) {
        return true;
      }
    } catch {
      // fall through
    }
  }
  if (hasRootAgentFiles(root)) return true;
  return isRegularFile(join(root, ".claude-plugin", "plugin.json"));
}

// True when `root` holds flat agent markdown files directly (the current
// agency-agents layout: engineering/*.md). A file counts as an agent when it
// has a frontmatter block carrying at least a `name` or `description`, which
// keeps README/docs out of the agent list.
function hasRootAgentFiles(root: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  return entries.some((e) => {
    if (!e.endsWith(".md")) return false;
    const full = join(root, e);
    if (!isRegularFile(full)) return false;
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(readFileSync(full, "utf8"))?.[1];
    if (!m) return false;
    return /^name:[ \t]/.test(m) || /^description:[ \t]/.test(m);
  });
}

// Returns directories under `root` that are individual plugin roots. This
// mirrors what VS Code's installed.json points at (each {host}/{org}/{repo}
// clone, and inside a marketplace like agency-agents each
// ref_plugins/plugins/<division> dir), so a clone on disk is registered
// per-plugin instead of as one opaque tree that hides its agents.
export function findPluginRoots(root: string, out: string[]): void {
  if (hasPluginLayout(root)) {
    out.push(root);
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(root, entry);
    if (!isDirectory(full)) continue;
    findPluginRoots(full, out);
  }
}

// True when a legacy Claude Code plugin declares at least one agent, so an
// agents-only plugin is still discovered even though it ships no skills.
function hasClaudeAgents(root: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return false;
    const agents = (manifest as Record<string, unknown>).agents;
    return (
      typeof agents === "object" &&
      agents !== null &&
      Object.keys(agents).length > 0
    );
  } catch {
    return false;
  }
}

// True when a plugin carries flat agent files: agents/<name>.md or bare
// <name>.md in the root (agency-agents layouts), which readAgents picks up
// even without a manifest `agents` field.
function hasFlatAgents(root: string): boolean {
  if (hasRootAgentFiles(root)) return true;
  try {
    return readdirSync(join(root, "agents")).some((e) => e.endsWith(".md"));
  } catch {
    return false;
  }
}

// Prefers a conformant package manifest; falls back to a legacy tree walk so
// non-conformant layouts keep working. Returns null when nothing is found.
export function packageFromDir(
  root: string,
  source: PackageSource,
): PluginPackage | null {
  const pkg = readPackage(root, source);
  if (pkg) return pkg;
  const skillDirs = new Set<string>();
  findSkillDirs(root, skillDirs, new Set());
  if (skillDirs.size === 0 && !hasClaudeAgents(root) && !hasFlatAgents(root)) {
    return null;
  }
  return {
    source,
    name: root.split(/[\\/]/).pop() || root,
    root,
    skillDirs: [...skillDirs],
  };
}

// --- VS Code agent plugin discovery ---------------------------------------

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

export function collectVscodeManifest(
  out: PluginPackage[],
  installedJson: string,
): void {
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
    if (dir) {
      const pkg = packageFromDir(dir, "vscode");
      if (pkg) out.push(pkg);
    }
  }
}

type CacheEntry = { uri?: string; nonce?: string };

// Remote hosts: VS Code syncs client skills into
// {data}/agentPlugins/{sanitizedUri}/{nonce}/ and records the LRU in
// cache.json. Resolve each entry so the materialized synced-customization
// bundle ("VS Code Synced Data" Open Plugin, skills/<name>/SKILL.md) is
// discovered.
export function collectVscodeCache(out: PluginPackage[], cacheJson: string): void {
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
    const nonceDir = join(parent, key, nonce);
    if (isDirectory(nonceDir)) {
      const pkg = packageFromDir(nonceDir, "vscode");
      if (pkg) out.push(pkg);
    } else {
      // Layouts without the {nonce} subdirectory materialize the bundle
      // directly under {key}; walking it only when the nonce dir is absent
      // avoids re-descending into it.
      const pkg = packageFromDir(join(parent, key), "vscode");
      if (pkg) out.push(pkg);
    }
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

function collectAgentPluginRoot(out: PluginPackage[], root: string): void {
  const installedJson = join(root, "installed.json");
  const cacheJson = join(root, "cache.json");
  collectVscodeManifest(out, installedJson);
  collectVscodeCache(out, cacheJson);
  // `installed.json` is the authoritative record of what VS Code installed;
  // when it exists, respect it exactly and skip the fallback walk so
  // cloned-but-not-installed marketplaces stay hidden.
  //
  // `cache.json` alone is NOT authoritative: on remote hosts it is just the
  // LRU of synced skills bundles and is always present, while a marketplace
  // cloned directly under {host}/{org}/{repo} (newer layouts, or a manual
  // clone) has no manifest entry at all. Only suppress the walk when
  // installed.json exists, so any clone actually on disk is still discovered.
  if (!existsSync(installedJson)) {
    const pluginRoots: string[] = [];
    findPluginRoots(root, pluginRoots);
    for (const pluginRoot of pluginRoots) {
      const pkg = packageFromDir(pluginRoot, "vscode");
      if (pkg) out.push(pkg);
    }
  }
}

export function collectVscode(out: PluginPackage[], extra: string[]): void {
  for (const dir of agentPluginDirs(vsCodeDataRoots(extra))) {
    collectAgentPluginRoot(out, dir);
  }
}

// --- Claude Code plugin discovery ------------------------------------------

export function collectClaudeManifest(
  out: PluginPackage[],
  installedJson: string,
): void {
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
        const pkg = packageFromDir(plugin.installPath, "claude");
        if (pkg) out.push(pkg);
      }
    }
  }
}

export function collectClaude(out: PluginPackage[]): void {
  const home = homedir();
  const installedJsons = [
    join(home, ".claude", "plugins", "installed_plugins.json"),
    join(home, ".claude", "remote", "plugins", "installed_plugins.json"),
  ];
  for (const installedJson of installedJsons) {
    if (existsSync(installedJson)) {
      collectClaudeManifest(out, installedJson);
    }
  }
  // Always scan the SSH-synced remote bundle too: it can exist alongside a
  // local Claude Code install that has its own installed_plugins.json, and
  // the same-source mirror dedup in planConfig collapses any overlap.
  //
  // Like the VS Code agent plugin dir, the remote plugins root holds
  // hash-named plugin directories with no manifest. Walk it with
  // findPluginRoots so skills and flat agent markdown files are found by
  // filename wherever they live — no hardcoded folder names needed.
  const remoteRoot = join(home, ".claude", "remote", "plugins");
  if (existsSync(remoteRoot)) {
    const roots: string[] = [];
    findPluginRoots(remoteRoot, roots);
    for (const pluginRoot of roots) {
      const pkg = packageFromDir(pluginRoot, "claude");
      if (pkg) out.push(pkg);
    }
  }
}

// --- npm-distributed Agent Plugins packages --------------------------------

export function opencodeCacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "opencode");
}

// opencode installs npm plugins into its own cache, not the project's
// node_modules: {cache}/packages/{name}@{version}/node_modules/{name}. Scanning
// it is what makes an npm-distributed Agent Plugins package work without any
// manual skills.paths entry.
export function collectOpencodeCache(
  packagesRoot: string,
  out: PluginPackage[],
): void {
  let pkgEntries: string[];
  try {
    pkgEntries = readdirSync(packagesRoot);
  } catch {
    return;
  }
  for (const pkgEntry of pkgEntries) {
    const nodeModules = join(packagesRoot, pkgEntry, "node_modules");
    if (!isDirectory(nodeModules)) continue;
    collectNodeModules(nodeModules, out);
  }
}

// Enumerates immediate package roots of a node_modules dir, including scoped
// packages (@scope/*). Only conformant packages (root plugin.json) are read;
// nothing else is walked.
export function collectNodeModules(
  nodeModulesRoot: string,
  out: PluginPackage[],
): void {
  if (!isDirectory(nodeModulesRoot)) return;
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    const candidate = join(nodeModulesRoot, entry);
    if (!isDirectory(candidate)) continue;
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = readdirSync(candidate);
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (sub.startsWith(".")) continue;
        const pkg = readPackage(join(candidate, sub), "node_modules");
        if (pkg) out.push(pkg);
      }
    } else {
      const pkg = readPackage(candidate, "node_modules");
      if (pkg) out.push(pkg);
    }
  }
}

// --- Merge logic ------------------------------------------------------------

// Collapses mirrors of the same conformant package discovered from several
// places at once (opencode cache + project node_modules + VS Code clone +
// synced bundle). Conformant packages are identified by their manifest name;
// legacy packages fall back to source + root, which is unique per location.
function dedupePackages(packages: PluginPackage[]): PluginPackage[] {
  const seen = new Set<string>();
  const out: PluginPackage[] = [];
  for (const pkg of packages) {
    const id = pkg.schemaVersion
      ? `conformant:${pkg.name}`
      : `${pkg.source}\u0000${pkg.root}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(pkg);
  }
  return out;
}

// Computes the config contribution from the discovered packages: every unique
// skill path, slash commands keyed by frontmatter name with collisions
// namespaced by package name, and MCP servers keyed by server name with
// collisions namespaced by package name. `taken` seeds the reserved names from
// the user's existing config so user-defined entries are never overwritten.
export function planConfig(
  packages: PluginPackage[],
  taken: {
    commands?: Iterable<string>;
    mcp?: Iterable<string>;
    agents?: Iterable<string>;
  } = {},
): ConfigPatch {
  packages = dedupePackages(packages);
  const skillPaths: string[] = [];
  const seenDir = new Set<string>();
  for (const pkg of packages) {
    for (const dir of pkg.skillDirs) {
      if (seenDir.has(dir)) continue;
      seenDir.add(dir);
      skillPaths.push(dir);
    }
  }

  const commands: ConfigPatch["commands"] = [];
  const usedCommands = new Set(taken.commands ?? []);
  const commandOwner = new Map<string, PackageSource | "user">();
  for (const name of taken.commands ?? []) commandOwner.set(name, "user");
  const seenCommandDir = new Set<string>();
  for (const pkg of packages) {
    for (const dir of pkg.skillDirs) {
      if (seenCommandDir.has(dir)) continue;
      seenCommandDir.add(dir);
      const info = readSkillInfo(dir);
      if (!info) continue;
      let name = info.name;
      const owner = commandOwner.get(name);
      if (owner !== undefined) {
        if (owner === pkg.source) {
          // Same client layout mirroring one plugin (e.g. a VS Code synced
          // bundle next to the local clone): redundant, keep the first.
          continue;
        }
        const namespaced = `${pkg.name}-${info.name}`;
        if (usedCommands.has(namespaced)) {
          log(`skipping slash command for skill "${info.name}": name already taken`);
          continue;
        }
        name = namespaced;
      }
      commandOwner.set(name, pkg.source);
      usedCommands.add(name);
      commands.push({
        name,
        description: info.description || `Run the ${info.name} skill`,
        template: [
          `Load the \`${info.name}\` skill and follow its instructions.`,
          `Context: $ARGUMENTS`,
        ].join("\n"),
      });
    }
  }

  const mcp: ConfigPatch["mcp"] = [];
  const usedMcp = new Set(taken.mcp ?? []);
  const mcpOwner = new Map<string, PackageSource | "user">();
  for (const name of taken.mcp ?? []) mcpOwner.set(name, "user");
  const seenMcpEntry = new Set<string>();
  for (const pkg of packages) {
    const entries: Array<{ key: string; entry: McpEntry }> = [];
    readMcp(pkg, entries);
    for (const { key, entry } of entries) {
      const dedupeKey = `${pkg.root}\u0000${key}`;
      if (seenMcpEntry.has(dedupeKey)) continue;
      seenMcpEntry.add(dedupeKey);
      let k = key;
      const owner = mcpOwner.get(k);
      if (owner !== undefined) {
        if (owner === pkg.source) continue;
        const namespaced = `${pkg.name}/${key}`;
        if (usedMcp.has(namespaced)) {
          log(`skipping MCP server "${pkg.name}/${key}": name already taken`);
          continue;
        }
        k = namespaced;
      }
      mcpOwner.set(k, pkg.source);
      usedMcp.add(k);
      mcp.push({ key: k, entry });
    }
  }

  const agents: ConfigPatch["agents"] = [];
  const usedAgents = new Set(taken.agents ?? []);
  const agentOwner = new Map<string, PackageSource | "user">();
  for (const name of taken.agents ?? []) agentOwner.set(name, "user");
  const seenAgent = new Set<string>();
  for (const pkg of packages) {
    for (const { name, agent } of readAgents(pkg)) {
      const dedupeKey = `${pkg.root}\u0000${name}`;
      if (seenAgent.has(dedupeKey)) continue;
      seenAgent.add(dedupeKey);
      let agentName = name;
      const owner = agentOwner.get(agentName);
      if (owner !== undefined) {
        if (owner === pkg.source) continue;
        const namespaced = `${pkg.name}-${agentName}`;
        if (usedAgents.has(namespaced)) {
          log(`skipping agent "${pkg.name}/${agentName}": name already taken`);
          continue;
        }
        agentName = namespaced;
      }
      agentOwner.set(agentName, pkg.source);
      usedAgents.add(agentName);
      agents.push({ name: agentName, agent });
    }
  }

  return { skillPaths, commands, mcp, agents };
}

// Applies a computed plan to the resolved config. Never overwrites user-defined
// entries; de-duplicates paths against what the user already configured.
// `enabled` gates the opt-in component types (MCP servers, agents), which are
// more powerful than skills and therefore off by default.
export function applyConfigPatch(
  config: ConfigLike,
  plan: ConfigPatch,
  enabled: { mcp: boolean; agents: boolean },
): void {
  const doAgents = enabled.agents && plan.agents.length > 0;
  if (plan.skillPaths.length === 0 && !enabled.mcp && !doAgents) return;

  if (plan.skillPaths.length > 0) {
    config.skills ??= {};
    config.skills.paths ??= [];
    const seen = new Set(config.skills.paths);
    for (const dir of plan.skillPaths) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      config.skills.paths.push(dir);
    }
  }

  if (plan.commands.length > 0) {
    config.command ??= {};
    for (const cmd of plan.commands) {
      if (config.command[cmd.name]) continue;
      config.command[cmd.name] = {
        description: cmd.description,
        template: cmd.template,
      };
    }
  }

  if (enabled.mcp && plan.mcp.length > 0) {
    config.mcp ??= {};
    for (const { key, entry } of plan.mcp) {
      if (config.mcp[key]) continue;
      config.mcp[key] = entry;
    }
  }

  if (doAgents) {
    config.agent ??= {};
    for (const { name, agent } of plan.agents) {
      if (config.agent[name]) continue;
      config.agent[name] = agent;
    }
  }
}
