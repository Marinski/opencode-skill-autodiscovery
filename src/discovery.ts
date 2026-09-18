import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedRead } from "./cache.js";
import { getCachedPackages, setCachedPackages, fingerprintTree } from "./discovery-cache.js";
import { log, sanitize } from "./log.js";
import { PLUGIN_SCHEMA_1_0_0_ID, validatePluginManifest } from "./spec-schema.js";
import { readAgents } from "./agents.js";
import { readMcp } from "./mcp.js";
import { NAME_PATTERN, PLUGIN_SCHEMA, VERSION, validateName } from "./schema.js";
import type { AgentConfig } from "./agents.js";
import type { McpEntry, McpPlanEntry } from "./mcp.js";

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
  /**
   * Two-tier trust model. True when the content was installed or fetched
   * deliberately via a host tool or opencode itself (claude/vscode manifests
   * under home roots, opencode's package cache). False when present merely as
   * a side effect (project node_modules, manifest-less walks, and any package
   * reached through a user-supplied extra root).
   */
  trusted: boolean;
  name: string;
  root: string;
  skillDirs: string[];
  mcpPath?: string;
  /** Agent Plugins version declared by plugin.json, e.g. "1.0.0". */
  schemaVersion?: string;
  /**
   * True when `name` was read from a real plugin manifest (Agent Plugins
   * schema or a native Claude Code `.claude-plugin/plugin.json`), so it is
   * the plugin's own declared identity rather than a directory-basename
   * fallback. dedupePackages only collapses mirrors discovered at different
   * physical paths when this is true — trusting a bare basename the same
   * way would risk merging two unrelated packages that happen to share a
   * generic directory name.
   */
  manifestName: boolean;
};

export type SkillInfo = { dir: string; name: string; description: string };

export type ConfigPatch = {
  skillPaths: string[];
  // Parallel to skillPaths: per-path provenance (the owning package's
  // `trusted` flag) so registration code can tell deliberate installs from
  // side-effect discovery.
  skillTrust: Array<{ dir: string; trusted: boolean }>;
  commands: Array<{
    name: string;
    description: string;
    template: string;
    trusted: boolean;
  }>;
  mcp: Array<{ key: string; entry: McpEntry; trusted: boolean }>;
  agents: Array<{ name: string; agent: AgentConfig; trusted: boolean }>;
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

// True only for a JSON object container: not null, not an array, and not some
// other object kind. Manifest inputs are parsed JSON, so this rejects every
// shape other than a plain object before its keys are iterated.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// True when `child` resolves (through symlinks) inside `parent`.
export function contains(parent: string, child: string): boolean {
  const p = realpathSync(parent);
  const c = realpathSync(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolves `candidate` to its real path and returns it only when it still
// lives inside `root` (through symlinks); returns null when it is missing or
// escapes. This is the read gate for package files whose bytes feed config:
// a package must not be able to ship a symlink (mcp.json, AGENTS.md, a flat
// agent .md) that reads a file it never contained. A rejected candidate is
// logged once, naming the package root and the outside target.
export function resolveContained(root: string, candidate: string): string | null {
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!contains(root, resolved)) {
    log(`skipping "${resolved}": resolves outside "${root}"`);
    return null;
  }
  return resolved;
}

// Parses the YAML frontmatter of a SKILL.md (name, description). Returns null
// when the file is unreadable or lacks a valid `name`.
export function readSkillInfo(dir: string): SkillInfo | null {
  const skillMd = join(dir, "SKILL.md");
  let parsed: { name: string; description: string } | null;
  try {
    parsed = cachedRead("skill-frontmatter", skillMd, parseSkillFrontmatter);
  } catch {
    return null;
  }
  if (!parsed) return null;
  return { dir, name: parsed.name, description: parsed.description };
}

function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!frontmatter) return null;
  const field = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatter);
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, "");
  };
  const name = field("name");
  if (!name) return null;
  // The description is written into config verbatim: strip ANSI escapes and
  // C0 control characters before it can reach any config surface.
  return { name, description: sanitize(field("description") ?? "") };
}

// Reads a conformant Agent Plugins 1.0.0 package from a directory root.
// Returns null when the root has no valid plugin.json, so callers can fall
// back to legacy discovery. The $schema URL and the manifest name identify
// format only — never provenance or safety: any package can copy the
// literal schema URL. Provenance/safety is tracked separately by the
// caller-supplied `trusted` flag.
export function readPackage(
  root: string,
  source: PackageSource,
  trusted = false,
): PluginPackage | null {
  const manifestPath = join(root, "plugin.json");
  if (!isRegularFile(manifestPath)) return null;
  let manifest: { $schema?: unknown; name?: unknown };
  try {
    manifest = cachedRead("plugin-manifest", manifestPath, (content) => JSON.parse(content));
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  if (typeof manifest.$schema !== "string" || !PLUGIN_SCHEMA.test(manifest.$schema)) {
    return null;
  }
  // Rigorous structural validation against the real published schema, when
  // this plugin has vendored a copy matching the declared version (today,
  // only 1.0.0). Any other conformant 1.x.x version falls back to the
  // name-only check below, so a future minor version is never rejected just
  // because this plugin hasn't vendored its schema yet — see spec-schema.ts.
  if (manifest.$schema === PLUGIN_SCHEMA_1_0_0_ID) {
    const result = validatePluginManifest(manifest);
    if (!result.valid) {
      log(
        `ignoring plugin.json at "${root}": fails Agent Plugins 1.0.0 schema (${result.errors.join("; ")})`,
      );
      return null;
    }
  } else if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    manifest.name.length > 64 ||
    !NAME_PATTERN.test(manifest.name)
  ) {
    return null;
  }
  // Narrows `manifest.name` for TS: always true here (either branch above
  // already guarantees it — ajv's `name` schema requires a string, the
  // fallback branch checked it directly) but ajv validation doesn't carry
  // type-level narrowing the way the explicit typeof check does.
  if (typeof manifest.name !== "string") return null;

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
      const skillMd = join(dir, "SKILL.md");
      if (!isRegularFile(skillMd)) continue;
      // The directory alone is not enough: a package can keep the skill dir
      // in-root while symlinking its SKILL.md to an outside file, whose bytes
      // would otherwise become prompt material. Require the skill file itself
      // to resolve inside the package too.
      if (!resolveContained(root, skillMd)) continue;
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

  // mcp.json is package-supplied input read into config.mcp: resolve it
  // through the containment gate first, so a symlink cannot point it at a
  // file outside the package.
  const mcpResolved = resolveContained(root, join(root, "mcp.json"));
  const mcpPath =
    mcpResolved && isRegularFile(mcpResolved) ? mcpResolved : undefined;

  return {
    source,
    trusted,
    name: manifest.name,
    root,
    skillDirs,
    mcpPath,
    schemaVersion: VERSION.exec(manifest.$schema)?.[1],
    manifestName: true,
  };
}

// True when a discovered package matches the user's exclude list. Conformant
// packages match on their plugin.json manifest name; legacy packages fall back
// to the directory basename (which is what their name already is).
function isExcluded(pkg: PluginPackage, exclude: string[]): boolean {
  return exclude.includes(pkg.name);
}

// Belt-and-braces bound for the legacy walk. Correctness rests entirely on
// real-path dedupe below (symlink cycles terminate because every visited path
// is keyed on its resolved form); this cap only stops pathological deep trees
// from exhausting the stack, and is not load-bearing for that guarantee.
const MAX_WALK_DEPTH = 16;

// Legacy tree walk: every directory containing a SKILL.md, down to a shallow
// depth cap (see MAX_WALK_DEPTH). Visited and emitted paths are keyed on their
// real (symlink-resolved) forms, so symlink cycles — self-referential or
// ancestor-pointing — terminate the branch instead of growing ever-longer
// lexical paths until stack exhaustion. Candidates whose real location
// resolves outside the starting root are skipped, mirroring the containment
// guarantee of readPackage.
export function findSkillDirs(root: string, out: Set<string>, seen: Set<string>) {
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    return;
  }
  findSkillDirsUnder(resolved, resolved, out, seen);
}

function findSkillDirsUnder(
  realRoot: string,
  dir: string,
  out: Set<string>,
  seen: Set<string>,
  depth = 0,
) {
  if (depth > MAX_WALK_DEPTH) return;
  if (seen.has(dir)) return;
  seen.add(dir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git") continue;
    const full = join(dir, entry);
    if (!isDirectory(full)) continue;
    let child: string;
    try {
      child = realpathSync(full);
    } catch {
      continue;
    }
    if (!contains(realRoot, child)) {
      log(`skipping skill dir "${child}": resolves outside "${realRoot}"`);
      continue;
    }
    const childSkillMd = join(child, "SKILL.md");
    if (isRegularFile(childSkillMd)) {
      // A skill dir whose SKILL.md symlinks outside the walk root must not be
      // emitted: readSkillInfo (and opencode) would read the outside bytes.
      if (!resolveContained(realRoot, childSkillMd)) continue;
      out.add(child);
    } else {
      findSkillDirsUnder(realRoot, child, out, seen, depth + 1);
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
      if (
        readdirSync(skillsRoot).some((e) => {
          const skillMd = join(skillsRoot, e, "SKILL.md");
          return resolveContained(root, skillMd) !== null && isRegularFile(skillMd);
        })
      ) {
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
    const contained = resolveContained(root, join(root, e));
    if (!contained || !isRegularFile(contained)) return false;
    try {
      return cachedRead("agent-frontmatter-check", contained, hasAgentFrontmatter);
    } catch {
      return false;
    }
  });
}

function hasAgentFrontmatter(content: string): boolean {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!m) return false;
  return /^name:[ \t]/.test(m) || /^description:[ \t]/.test(m);
}

// Returns directories under `root` that are individual plugin roots. This
// mirrors what VS Code's installed.json points at (each {host}/{org}/{repo}
// clone, and inside a marketplace like agency-agents each
// ref_plugins/plugins/<division> dir), so a clone on disk is registered
// per-plugin instead of as one opaque tree that hides its agents.
//
// Hardened like findSkillDirs: traversal and emitted roots are keyed on real
// (symlink-resolved) paths, so symlink cycles — self-referential or
// ancestor-pointing — terminate instead of growing ever-longer lexical paths
// until stack exhaustion, and nothing that resolves outside the starting root
// is emitted. `isDirectory` uses statSync, which follows symlinks, so the
// realpath dedupe below is what bounds the walk.
export function findPluginRoots(root: string, out: string[]): void {
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    return;
  }
  findPluginRootsUnder(resolved, resolved, out, new Set());
}

// Equivalent to a caller doing `findPluginRoots(root, roots)` and converting
// each hit with `packageFromDir(pluginRoot, source, trusted)` — the exact
// pattern collectAgentPluginRoot's fallback and collectClaude's remote walk
// both used before discovery-cache.ts existed — except a cheap fingerprint
// check of `root` (see fingerprintTree) can skip the real walk, and every
// file read inside it, entirely when the subtree hasn't changed since the
// last run. A miss falls back to exactly the walk+convert callers did
// before, so this is never slower than the un-cached baseline.
//
// `exclude` is deliberately the caller's job, applied identically on a hit
// or a miss, so changing the exclude list never has to invalidate the cache.
function findPluginPackagesCached(
  root: string,
  source: PackageSource,
  trusted: boolean,
): PluginPackage[] {
  const fingerprint = fingerprintTree(root);
  const key = JSON.stringify([source, root]);
  const cached = getCachedPackages(key, fingerprint);
  if (cached) return cached;
  const roots: string[] = [];
  findPluginRoots(root, roots);
  const packages: PluginPackage[] = [];
  for (const pluginRoot of roots) {
    const pkg = packageFromDir(pluginRoot, source, trusted);
    if (pkg) packages.push(pkg);
  }
  setCachedPackages(key, fingerprint, packages);
  return packages;
}

function findPluginRootsUnder(
  realRoot: string,
  dir: string,
  out: string[],
  seen: Set<string>,
  depth = 0,
) {
  if (depth > MAX_WALK_DEPTH) return;
  if (seen.has(dir)) return;
  seen.add(dir);
  if (hasPluginLayout(dir)) {
    out.push(dir);
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (!isDirectory(full)) continue;
    let child: string;
    try {
      child = realpathSync(full);
    } catch {
      continue;
    }
    if (!contains(realRoot, child)) {
      log(`skipping plugin dir "${child}": resolves outside "${realRoot}"`);
      continue;
    }
    findPluginRootsUnder(realRoot, child, out, seen, depth + 1);
  }
}

// True when a legacy Claude Code plugin declares at least one agent, so an
// agents-only plugin is still discovered even though it ships no skills.
function hasClaudeAgents(root: string): boolean {
  const manifestPath = resolveContained(
    root,
    join(root, ".claude-plugin", "plugin.json"),
  );
  if (!manifestPath) return false;
  try {
    const manifest: unknown = cachedRead(
      "claude-legacy-manifest",
      manifestPath,
      (content) => JSON.parse(content),
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

// Reads the `name` declared by a legacy Claude Code manifest
// (.claude-plugin/plugin.json without a recognized $schema — the native
// Claude Code shape, which is what every plugin actually installed via
// Claude Code ships). readPackage() only trusts a manifest name when
// $schema is present and matches the Agent Plugins spec, so a plugin
// installed the native way falls through to packageFromDir's legacy tree
// walk; without this, that walk names the package after its directory
// basename instead, which differs at every physical location the same
// plugin is mirrored to (a top-level clone, the same clone nested again
// inside a bundled marketplace tree, an SSH-synced remote copy, ...) and
// defeats dedupePackages entirely, registering every skill in the plugin
// once per mirror. Shares the "claude-legacy-manifest" cache key with
// hasClaudeAgents so both reads of the same file cost one parse.
function legacyManifestName(root: string): string | null {
  const manifestPath = resolveContained(
    root,
    join(root, ".claude-plugin", "plugin.json"),
  );
  if (!manifestPath) return null;
  try {
    const manifest: unknown = cachedRead(
      "claude-legacy-manifest",
      manifestPath,
      (content) => JSON.parse(content),
    );
    if (!isPlainObject(manifest)) return null;
    const { name } = manifest;
    return typeof name === "string" && validateName(name) ? name : null;
  } catch {
    return null;
  }
}

// True when a plugin carries flat agent files: agents/<name>.md or bare
// <name>.md in the root (agency-agents layouts), which readAgents picks up
// even without a manifest `agents` field.
function hasFlatAgents(root: string): boolean {
  if (hasRootAgentFiles(root)) return true;
  const agentsDir = join(root, "agents");
  try {
    return readdirSync(agentsDir).some(
      (e) => e.endsWith(".md") && resolveContained(root, join(agentsDir, e)) !== null,
    );
  } catch {
    return false;
  }
}

// Sanitizes the legacy directory-basename package-name fallback before it
// feeds collision namespaces or dedupe keys: names that already satisfy
// NAME_PATTERN pass through untouched; anything else is stripped down to
// NAME_PATTERN-safe characters (characters outside [a-z0-9.-] removed,
// `--`/`..` runs collapsed, edges trimmed) and rejected outright when the
// result is empty or a prototype-chain key, falling back to a fixed safe
// identifier. Legacy packages keep their skills even when their directory
// name is hostile.
function legacyFallbackName(basename: string): string {
  if (validateName(basename)) return basename;
  const cleaned = basename
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");
  return validateName(cleaned) ?? "legacy";
}

// Prefers a conformant package manifest; falls back to a legacy tree walk so
// non-conformant layouts keep working. Returns null when nothing is found.
export function packageFromDir(
  root: string,
  source: PackageSource,
  trusted = false,
): PluginPackage | null {
  const pkg = readPackage(root, source, trusted);
  if (pkg) return pkg;
  const skillDirs = new Set<string>();
  findSkillDirs(root, skillDirs, new Set());
  if (skillDirs.size === 0 && !hasClaudeAgents(root) && !hasFlatAgents(root)) return null;
  // Prefer the plugin's own declared name (native Claude Code manifest, no
  // $schema) over the directory basename, so mirrors of the same plugin at
  // different physical paths share an identity dedupePackages can collapse.
  const declaredName = legacyManifestName(root);
  return {
    source,
    trusted,
    name: declaredName ?? legacyFallbackName(root.split(/[\\/]/).pop() ?? ""),
    root,
    skillDirs: [...skillDirs],
    manifestName: declaredName !== null,
  };
}

// --- VS Code agent plugin discovery ---------------------------------------

// VS Code keeps agent plugins in a per-platform "data dir". The holding
// folder is named `agent-plugins` on older builds (e.g. ~/.vscode) and
// `agentPlugins` on newer builds; remote servers nest theirs under `data/`
// (~/.vscode-server/data/agentPlugins). We list every known candidate so the
// discovery works regardless of OS, build channel, or local/remote setup.
//
// A data root carries its provenance: built-in per-platform home roots are
// trusted (VS Code itself owns them), while user-supplied `extraRoots` are not.
type DataRoot = { root: string; trusted: boolean };

function vsCodeDataRoots(extra: string[]): DataRoot[] {
  const home = homedir();
  const builtIn = new Set<string>([
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
  const roots: DataRoot[] = [...builtIn].map((root) => ({ root, trusted: true }));
  const seen = new Set(builtIn);
  for (const root of extra) {
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push({ root, trusted: false });
  }
  return roots;
}

function agentPluginDirs(roots: DataRoot[]): DataRoot[] {
  const seen = new Set<string>();
  const dirs: DataRoot[] = [];
  for (const { root, trusted } of roots) {
    for (const dir of [
      join(root, "agent-plugins"),
      join(root, "agentPlugins"),
      join(root, "data", "agent-plugins"),
      join(root, "data", "agentPlugins"),
    ]) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      dirs.push({ root: dir, trusted });
    }
  }
  return dirs;
}

// Resolves an `installed.json` `pluginUri` to an on-disk plugin root. Only
// `file:` URLs name a local directory: non-file schemes and malformed URLs are
// dropped (with a log) rather than echoed into the filesystem, and the
// resolved target must be an existing directory. `fileURLToPath` owns the
// slash/percent/drive-letter normalization; `resolve` then canonicalizes the
// result so a technically valid URL like `file:////abs` yields the same root
// string as its `file:///abs` spelling.
function vscodePluginPath(pluginUri: string): string | null {
  let resolved: string;
  try {
    resolved = resolve(fileURLToPath(pluginUri));
  } catch {
    log(`ignoring plugin URI "${pluginUri}": not a resolvable file: URL`);
    return null;
  }
  // `file://` (and `file:///`) resolve to the filesystem root; a plugin root
  // is never the root itself, and walking it would scan the whole disk.
  if (dirname(resolved) === resolved) {
    log(`ignoring plugin URI "${pluginUri}": filesystem root is not a plugin root`);
    return null;
  }
  if (!isDirectory(resolved)) {
    log(`ignoring plugin URI "${pluginUri}": "${resolved}" is not a directory`);
    return null;
  }
  return resolved;
}

export function collectVscodeManifest(
  out: PluginPackage[],
  installedJson: string,
  exclude: string[] = [],
  trusted = true,
): void {
  if (!existsSync(installedJson)) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(installedJson, "utf8"));
  } catch {
    return;
  }
  // installed.json is manifest input: fail closed on a malformed shape rather
  // than iterating a non-array (which throws) or trusting entry types.
  const installed = isPlainObject(manifest) ? manifest.installed : undefined;
  if (!Array.isArray(installed)) {
    log(`ignoring "${installedJson}": "installed" is not an array`);
    return;
  }
  const root = dirname(installedJson);
  for (const plugin of installed) {
    if (!isPlainObject(plugin)) {
      log(`ignoring entry in "${installedJson}": entry is not an object`);
      continue;
    }
    const pluginUri = plugin.pluginUri;
    if (typeof pluginUri !== "string") {
      log(`ignoring entry in "${installedJson}": "pluginUri" is not a string`);
      continue;
    }
    const dir = vscodePluginPath(pluginUri);
    if (!dir) continue;
    // installed.json is manifest input: under an untrusted root the recorded
    // install location must resolve inside that root. A trusted home root is
    // allowed to point at a global extension directory outside the data root.
    if (!trusted && !contains(root, dir)) {
      log(
        `skipping plugin URI "${pluginUri}": "${dir}" is outside untrusted root "${root}"`,
      );
      continue;
    }
    const pkg = packageFromDir(dir, "vscode", trusted);
    if (pkg && !isExcluded(pkg, exclude)) out.push(pkg);
  }
}

type CacheEntry = { uri?: string; nonce?: string };

// Remote hosts: VS Code syncs client skills into
// {data}/agentPlugins/{sanitizedUri}/{nonce}/ and records the LRU in
// cache.json. Resolve each entry so the materialized synced-customization
// bundle ("VS Code Synced Data" Open Plugin, skills/<name>/SKILL.md) is
// discovered.
export function collectVscodeCache(
  out: PluginPackage[],
  cacheJson: string,
  exclude: string[] = [],
  trusted = true,
): void {
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
    // Layouts without the {nonce} subdirectory materialize the bundle
    // directly under {key}; falling back only when the nonce dir is absent
    // avoids re-descending into it.
    const nonceDir = join(parent, key, nonce);
    const dir = isDirectory(nonceDir) ? nonceDir : join(parent, key);
    if (!isDirectory(dir)) continue;
    // cache.json is manifest input: under an untrusted root the bundle must
    // resolve inside that root, not be redirected elsewhere on disk.
    if (!trusted && !contains(parent, dir)) {
      log(
        `skipping cache entry "${entry.uri}": "${dir}" is outside untrusted root "${parent}"`,
      );
      continue;
    }
    const pkg = packageFromDir(dir, "vscode", trusted);
    if (pkg && !isExcluded(pkg, exclude)) out.push(pkg);
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

function collectAgentPluginRoot(
  out: PluginPackage[],
  root: string,
  exclude: string[] = [],
  trusted = true,
): void {
  const installedJson = join(root, "installed.json");
  const cacheJson = join(root, "cache.json");
  collectVscodeManifest(out, installedJson, exclude, trusted);
  collectVscodeCache(out, cacheJson, exclude, trusted);
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
    for (const pkg of findPluginPackagesCached(root, "vscode", false)) {
      if (!isExcluded(pkg, exclude)) out.push(pkg);
    }
  }
}

export function collectVscode(
  out: PluginPackage[],
  extra: string[],
  exclude: string[] = [],
): void {
  for (const { root, trusted } of agentPluginDirs(vsCodeDataRoots(extra))) {
    collectAgentPluginRoot(out, root, exclude, trusted);
  }
}

// --- Claude Code plugin discovery ------------------------------------------

// `trusted` defaults to true: every Claude root is home-scoped and
// host-managed (`~/.claude/...`), so it stays trusted. The parameter exists
// for symmetry with the VS Code collectors, letting a caller mark a non-home
// manifest untrusted.
export function collectClaudeManifest(
  out: PluginPackage[],
  installedJson: string,
  exclude: string[] = [],
  trusted = true,
): void {
  if (!existsSync(installedJson)) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(installedJson, "utf8"));
  } catch {
    return;
  }
  // installed_plugins.json is manifest input: fail closed when `plugins` is not
  // a plain object, when a version bucket is not an array, or when an entry
  // lacks a string installPath.
  const plugins = isPlainObject(manifest) ? manifest.plugins : undefined;
  if (!isPlainObject(plugins)) {
    log(`ignoring "${installedJson}": "plugins" is not an object`);
    return;
  }
  for (const versions of Object.values(plugins)) {
    if (!Array.isArray(versions)) {
      log(`ignoring entry in "${installedJson}": plugin versions are not an array`);
      continue;
    }
    for (const plugin of versions) {
      if (!isPlainObject(plugin)) {
        log(`ignoring entry in "${installedJson}": entry is not an object`);
        continue;
      }
      const installPath = plugin.installPath;
      if (typeof installPath !== "string") {
        log(`ignoring entry in "${installedJson}": "installPath" is not a string`);
        continue;
      }
      const pkg = packageFromDir(installPath, "claude", trusted);
      if (pkg && !isExcluded(pkg, exclude)) out.push(pkg);
    }
  }
}

export function collectClaude(
  out: PluginPackage[],
  exclude: string[] = [],
): void {
  const home = homedir();
  const installedJsons = [
    join(home, ".claude", "plugins", "installed_plugins.json"),
    join(home, ".claude", "remote", "plugins", "installed_plugins.json"),
  ];
  for (const installedJson of installedJsons) {
    if (existsSync(installedJson)) {
      collectClaudeManifest(out, installedJson, exclude);
    }
  }
  // Always scan the SSH-synced remote bundle too: it can exist alongside a
  // local Claude Code install that has its own installed_plugins.json, and
  // the same-source mirror dedup in planConfig collapses any overlap.
  const remoteRoot = join(home, ".claude", "remote", "plugins");
  if (existsSync(remoteRoot)) {
    for (const pkg of findPluginPackagesCached(remoteRoot, "claude", true)) {
      if (!isExcluded(pkg, exclude)) out.push(pkg);
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
  exclude: string[] = [],
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
    // opencode installed these packages itself, so they are deliberate.
    collectNodeModules(nodeModules, out, true, exclude);
  }
}

// Enumerates immediate package roots of a node_modules dir, including scoped
// packages (@scope/*). Only conformant packages (root plugin.json) are read;
// nothing else is walked.
export function collectNodeModules(
  nodeModulesRoot: string,
  out: PluginPackage[],
  trusted = false,
  exclude: string[] = [],
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
        const pkg = readPackage(join(candidate, sub), "node_modules", trusted);
        if (pkg && !isExcluded(pkg, exclude)) out.push(pkg);
      }
    } else {
      const pkg = readPackage(candidate, "node_modules", trusted);
      if (pkg && !isExcluded(pkg, exclude)) out.push(pkg);
    }
  }
}

// --- Merge logic ------------------------------------------------------------

// Collapses mirrors of the same package discovered from several places at
// once (opencode cache + project node_modules + VS Code clone + synced
// bundle + a bundled marketplace tree that nests a second copy of a plugin
// already discovered standalone). Any package with a manifest-declared name
// -- Agent Plugins schema or a native Claude Code plugin.json -- is
// identified by that name; packages with no manifest at all fall back to
// source + root, which is unique per location (see PluginPackage.manifestName).
function dedupePackages(packages: PluginPackage[]): PluginPackage[] {
  const seen = new Set<string>();
  const out: PluginPackage[] = [];
  for (const pkg of packages) {
    const id = pkg.manifestName
      ? `named:${pkg.name}`
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
  // Mirrors the plugin options: when mcp is false the MCP subsystem is
  // skipped entirely — no mcp.json parsing, no filesystem side effects.
  // Same for agents: when agents is false readAgents is never invoked.
  enabled: { mcp?: boolean; agents?: boolean } = {},
  // Per-package consent for untrusted packages: a package discovered as a
  // side effect contributes nothing to plan.mcp or plan.agents unless its
  // name is listed in the matching consent list.
  consent: { mcp?: Iterable<string>; agents?: Iterable<string> } = {},
): ConfigPatch {
  packages = dedupePackages(packages);
  const skillPaths: string[] = [];
  const skillTrust: ConfigPatch["skillTrust"] = [];
  const seenDir = new Set<string>();
  for (const pkg of packages) {
    // Graduated default, permissive half: skills and slash commands are
    // read-only content registration and stay allowed for every trust tier —
    // surfacing them is the plugin's job. An untrusted package registers
    // exactly like a trusted one, but emits one info line so side-effect
    // content entering the session stays visible to the user.
    if (!pkg.trusted && pkg.skillDirs.length > 0) {
      log(
        `registering skills and slash commands for untrusted package "${pkg.name}" (${pkg.source})`,
      );
    }
    for (const dir of pkg.skillDirs) {
      if (seenDir.has(dir)) continue;
      seenDir.add(dir);
      skillPaths.push(dir);
      skillTrust.push({ dir, trusted: pkg.trusted });
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
      // SKILL.md frontmatter is package-supplied input: gate the name before
      // it becomes any config key (applyConfigPatch writes config.command[name]).
      if (!validateName(name)) {
        log(
          `skipping skill frontmatter for package "${pkg.name}": invalid name "${name}" (must match the identifier pattern and not be a prototype-chain key)`,
        );
        continue;
      }
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
          // The name is a quoted data value (JSON string encoding), never
          // wrapped in backticks: even a name that skipped validateName
          // cannot terminate the quote and inject template text.
          `Load the ${JSON.stringify(info.name)} skill and follow its instructions.`,
          `Context: $ARGUMENTS`,
        ].join("\n"),
        trusted: pkg.trusted,
      });
    }
  }

  const mcp: ConfigPatch["mcp"] = [];
  if (enabled.mcp !== false) {
    const consentedMcp = new Set(consent.mcp ?? []);
    const usedMcp = new Set(taken.mcp ?? []);
    const mcpOwner = new Map<string, PackageSource | "user">();
    for (const name of taken.mcp ?? []) mcpOwner.set(name, "user");
    const seenMcpEntry = new Set<string>();
    for (const pkg of packages) {
      // Trust gate: MCP servers are both powerful and opaque to opencode.
      // Untrusted packages are present merely as side effects, so they never
      // contribute servers unless the user consented to the package by name.
      // Host-vouched installs (trusted: true) pass through unchanged.
      if (!pkg.trusted && !consentedMcp.has(pkg.name)) {
        // Slice the credential signal out of the untrusted package's mcp.json
        // so entries carrying headers/env/url credentials get a per-entry
        // refusal line. readMcp runs with warnings off: a refused credential
        // must never be told it "will be stored in opencode's config".
        if (pkg.mcpPath) {
          const entries: McpPlanEntry[] = [];
          readMcp(pkg, entries, { warn: false });
          let named = 0;
          for (const { key, credentialReason } of entries) {
            if (!credentialReason) continue;
            named++;
            log(
              `skipping MCP server "${pkg.name}/${key}" (${pkg.source}): ${credentialReason}; add it to consent.mcp to admit its servers`,
            );
          }
          if (named === 0) {
            log(
              `skipping MCP server for untrusted package "${pkg.name}" (${pkg.source}): add it to consent.mcp to admit its servers`,
            );
          }
        }
        continue;
      }
      const entries: McpPlanEntry[] = [];
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
        mcp.push({ key: k, entry, trusted: pkg.trusted });
      }
    }
  }

  const agents: ConfigPatch["agents"] = [];
  if (enabled.agents !== false) {
    const consentedAgents = new Set(consent.agents ?? []);
    const usedAgents = new Set(taken.agents ?? []);
    const agentOwner = new Map<string, PackageSource | "user">();
    for (const name of taken.agents ?? []) agentOwner.set(name, "user");
    const seenAgent = new Set<string>();
    for (const pkg of packages) {
      // Trust gate: agents are prompt-and-behavior material that a package
      // registers into opencode config slots. Untrusted packages are present
      // merely as side effects, so they contribute agents only when the user
      // consented to the package by name. Host-vouched installs (trusted:
      // true) pass through. Note the readAgents call is hoisted so name
      // validation logs behave identically for every admitted package.
      const pkgAgents = readAgents(pkg);
      if (!pkg.trusted && !consentedAgents.has(pkg.name)) {
        if (pkgAgents.length > 0) {
          log(
            `skipping agents for untrusted package "${pkg.name}" (${pkg.source}): add it to consent.agents to admit its agents`,
          );
        }
        continue;
      }
      for (const { name, agent } of pkgAgents) {
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
        agents.push({ name: agentName, agent, trusted: pkg.trusted });
      }
    }
  }

  return { skillPaths, skillTrust, commands, mcp, agents };
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
    // Containers are built prototype-free so a key can never resolve to an
    // inherited member (__proto__/constructor/toString), even if a future
    // call site skips the upstream validateName gate.
    config.command ??= Object.create(null) as NonNullable<
      ConfigLike["command"]
    >;
    for (const cmd of plan.commands) {
      if (config.command[cmd.name]) continue;
      config.command[cmd.name] = {
        description: cmd.description,
        template: cmd.template,
      };
    }
  }

  if (enabled.mcp && plan.mcp.length > 0) {
    config.mcp ??= Object.create(null) as NonNullable<ConfigLike["mcp"]>;
    for (const { key, entry } of plan.mcp) {
      if (config.mcp[key]) continue;
      config.mcp[key] = entry;
      // A package stdio server runs with PLUGIN_DATA pointing at its data
      // dir. The dir is created only here, when the server is actually
      // applied -- never at plan time, so planning leaves no trace on disk.
      if (entry.type === "local" && entry.environment?.PLUGIN_DATA) {
        try {
          mkdirSync(entry.environment.PLUGIN_DATA, { recursive: true });
        } catch {
          // Non-fatal: the subprocess env still points at the (uncreated) dir.
        }
      }
    }
  }

  if (doAgents) {
    config.agent ??= Object.create(null) as NonNullable<ConfigLike["agent"]>;
    for (const { name, agent } of plan.agents) {
      if (config.agent[name]) continue;
      config.agent[name] = agent;
    }
  }
}
