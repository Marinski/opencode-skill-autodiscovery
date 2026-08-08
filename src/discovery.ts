import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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

export type ConfigPatch = {
  skillPaths: string[];
  commands: Array<{ name: string; description: string; template: string }>;
  mcp: Array<{ key: string; entry: McpEntry }>;
};

const PLUGIN_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/plugin\.schema\.json$/;
const MCP_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/mcp\.schema\.json$/;
const VERSION = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\//;

const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set(["type", "url", "headers"]);

export function log(message: string): void {
  console.error(`[opencode-skill-autodiscovery] ${message}`);
}

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
// back to legacy discovery. The $schema URL is the discriminator that makes
// scanning untrusted directories safe.
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
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
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
  if (skillDirs.size === 0) return null;
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

function collectVscodeManifest(
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
function collectVscodeCache(out: PluginPackage[], cacheJson: string): void {
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
    for (const dir of [join(parent, key, nonce), join(parent, key)]) {
      const pkg = packageFromDir(dir, "vscode");
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
  const hasManifest = existsSync(installedJson) || existsSync(cacheJson);
  collectVscodeManifest(out, installedJson);
  collectVscodeCache(out, cacheJson);
  // Newer VS Code installs marketplaces directly as {host}/{org}/{repo}
  // subdirectories with no manifest file at all. Fall back to a full tree walk
  // only when no metadata exists, so we don't surface skills from cloned-but-
  // not-installed marketplaces on setups that do have a manifest.
  if (!hasManifest) {
    const pkg = packageFromDir(root, "vscode");
    if (pkg) out.push(pkg);
  }
}

export function collectVscode(out: PluginPackage[], extra: string[]): void {
  for (const dir of agentPluginDirs(vsCodeDataRoots(extra))) {
    collectAgentPluginRoot(out, dir);
  }
}

// --- Claude Code plugin discovery ------------------------------------------

function collectClaudeManifest(
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
      const pkg = packageFromDir(remoteRoot, "claude");
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

// --- MCP servers (mcp.json) -------------------------------------------------

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
      log(`skipping MCP server "${pkg.name}/${name}": opencode does not support the sse transport`);
    } else {
      log(`skipping MCP server "${pkg.name}/${name}": unknown transport "${String(server.type)}"`);
    }
  }
}

// --- Merge logic ------------------------------------------------------------

// Computes the config contribution from the discovered packages: every unique
// skill path, slash commands keyed by frontmatter name with collisions
// namespaced by package name, and MCP servers keyed by server name with
// collisions namespaced by package name. `taken` seeds the reserved names from
// the user's existing config so user-defined entries are never overwritten.
export function planConfig(
  packages: PluginPackage[],
  taken: { commands?: Iterable<string>; mcp?: Iterable<string> } = {},
): ConfigPatch {
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

  return { skillPaths, commands, mcp };
}
