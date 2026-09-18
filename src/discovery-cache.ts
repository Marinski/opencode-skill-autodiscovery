import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pluginCacheRoot } from "./cache.js";
import type { PluginPackage } from "./discovery.js";

// findPluginRoots' real walk is the expensive part of a scan: at every
// directory it calls hasPluginLayout -> hasRootAgentFiles, which reads every
// flat *.md file's content to check its frontmatter (cache.ts's cachedRead
// avoids re-parsing an unchanged file's bytes, but the walk still visits
// every directory and opens every candidate file on every single run). For a
// large, mostly-unchanged tree (a synced Claude/VS Code plugin marketplace),
// that per-directory cost dominates opencode's startup time.
//
// This module is a second, coarser cache layer in front of the walk itself:
// fingerprint the subtree cheaply (readdirSync + statSync only, no content
// reads, no containment/symlink-resolution overhead) and let the caller skip
// the real walk entirely when the fingerprint matches the last run's. Pure
// primitives only — no dependency on discovery.ts's walk functions, so
// discovery.ts can depend on this module without a cycle; the glue that
// actually runs findPluginRoots on a miss lives in discovery.ts itself.

const CACHE_FILE_NAME = "discovery-root-cache.json";
// Bumped from 1 to 2 when the per-entry field storing the cached value was
// renamed from `packages` (PluginPackage[]-only) to the generic `value`
// (any JSON-serializable result — readAgents' cache reuses this same store).
// A version-1 file on disk is now correctly treated as absent rather than
// misread with the wrong field name.
//
// Bumped from 2 to 3 when PluginPackage gained the required `manifestName`
// field (see discovery.ts's dedupePackages): a cached entry written before
// that change serializes packages with no such field, so dedupePackages
// would silently treat every one of them as unidentified and keep every
// mirror — exactly the double-registration bug this field exists to fix,
// just reintroduced via a stale cache. Bumping the version discards those
// entries so the next scan rebuilds them with the new field.
const CACHE_VERSION = 3;
// Mirrors discovery.ts's MAX_WALK_DEPTH: this is a separate, cheaper walk
// (see fingerprintTree below), but it must bound depth the same way for the
// same reason — a pathological or cyclic tree must not grow this pass
// unboundedly, even though (unlike the real walk) it does not resolve
// symlinks to detect cycles precisely. A cycle just gets fingerprinted up to
// this depth and then stops, exactly like the real walk's own documented
// "belt-and-braces, not load-bearing" depth cap.
const MAX_FINGERPRINT_DEPTH = 16;

type CacheEntry = { fingerprint: string; value: unknown; cachedAt: string };
type CacheStore = Record<string, CacheEntry>;
type CacheFile = { version: number; entries: CacheStore };

let store: CacheStore | null = null;
let dirty = false;

function cacheFilePath(): string {
  return join(pluginCacheRoot(), CACHE_FILE_NAME);
}

function loadStore(): CacheStore {
  if (store) return store;
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as Partial<CacheFile>;
    store =
      raw && raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object"
        ? raw.entries
        : {};
  } catch {
    store = {};
  }
  return store;
}

// Test-only seam, same rationale as cache.ts's _resetFileCacheForTests: one
// opencode process makes one config() call, so the module-level singleton is
// the right scope in production; tests need to force a reload between cases
// that reuse the same HOME.
export function _resetDiscoveryCacheForTests(): void {
  store = null;
  dirty = false;
}

// A cheap, content-free signature of everything a full walk of `root` would
// visit: every directory's direct children, keyed by (path relative to root,
// file-or-dir, mtimeMs, size), hashed. Any add, remove, rename, or content
// edit anywhere in the subtree changes at least one child's stat (a write
// changes the file's own mtime/size; an add/remove/rename changes its parent
// directory's mtime) and so changes this hash — there is no staleness
// window, only a cheaper way to notice nothing changed.
//
// Deliberately skips realpathSync: that is precisely the overhead the real
// walk pays for its containment/symlink-cycle guarantees, and this pass does
// not need those guarantees — it only decides whether to trust a cached
// *result* of the real (fully-guarded) walk, never emits a path itself.
export function fingerprintTree(root: string): string {
  const parts: string[] = [];
  walkFingerprint(root, root, parts, 0);
  parts.sort();
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part).update("\n");
  return hash.digest("hex");
}

function walkFingerprint(root: string, dir: string, parts: string[], depth: number): void {
  if (depth > MAX_FINGERPRINT_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const isDir = st.isDirectory();
    parts.push(`${relative(root, full)}:${isDir ? "d" : "f"}:${st.mtimeMs}:${st.size}`);
    if (isDir) walkFingerprint(root, full, parts, depth + 1);
  }
}

// Returns the packages cached for `key` when its stored fingerprint matches
// `fingerprint`, or null on a miss (not cached yet, or the subtree changed).
export function getCachedPackages(key: string, fingerprint: string): PluginPackage[] | null {
  return getCachedValue<PluginPackage[]>(key, fingerprint);
}

// Records `packages` as the result for `key` at `fingerprint`, so the next
// call with an unchanged fingerprint gets them back from getCachedPackages
// without re-walking.
export function setCachedPackages(
  key: string,
  fingerprint: string,
  packages: PluginPackage[],
): void {
  setCachedValue(key, fingerprint, packages);
}

// Generic form of the same fingerprint-gated cache, for any JSON-serializable
// result of a per-directory computation — not just a package list. Used by
// readAgents (agents.ts) to cache a whole package's extracted agents keyed by
// a fingerprint of that package's own root: a marketplace layout with few
// packages but many flat *.md files per package (the exact shape that caused
// the original hang) would otherwise re-run readdirSync + the per-file
// containment check for every file, every run, even once the top-level walk
// itself is fully cached — package roots are typically far smaller subtrees
// than the marketplace root, so fingerprinting one is cheap.
export function getCachedValue<T>(key: string, fingerprint: string): T | null {
  const cached = loadStore()[key];
  return cached && cached.fingerprint === fingerprint ? (cached.value as T) : null;
}

export function setCachedValue<T>(key: string, fingerprint: string, value: T): void {
  loadStore()[key] = { fingerprint, value, cachedAt: new Date().toISOString() };
  dirty = true;
}

// Persists the in-memory cache to disk when it changed, atomically (write to
// a pid-suffixed temp file, then rename over the real path) so a process
// killed mid-write can never leave a half-written cache file behind for the
// next run to trip over. Best-effort, like every other filesystem side
// effect in this codebase: a failed write is swallowed, and the next run
// just re-walks.
export function flushDiscoveryCache(): void {
  if (!dirty || !store) return;
  try {
    const path = cacheFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: CacheFile = { version: CACHE_VERSION, entries: store };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
    dirty = false;
  } catch {
    // Non-fatal: the next run just re-walks and rebuilds the cache.
  }
}
