import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Persists the *derived* result of reading+parsing a file (never the raw
// content), keyed by that file's path and stamped with its (mtimeMs, size)
// at read time. On a warm run, a file whose stat is unchanged since the last
// read skips both the disk read and the parse — the only recurring per-file
// cost becomes a single `statSync`. This is what makes a large,
// mostly-unchanged tree (a synced Claude/VS Code plugin marketplace) cheap to
// re-scan on every opencode startup while staying live: any file that did
// change (edited, added, removed) is picked up on the very next run, with no
// staleness window, because its stat no longer matches the cached entry.
//
// Correctness never depends on this cache: a missing/corrupt cache file
// degrades to "read everything fresh" (an empty store), and a failed flush
// just means the next run pays the read cost again. Nothing here changes
// what gets discovered — only whether a given file's bytes get re-read.
type CacheEntry = { mtimeMs: number; size: number; value: unknown };
type CacheStore = Record<string, CacheEntry>;
type CacheFile = { version: number; entries: CacheStore };

const CACHE_FILE_NAME = "discovery-file-cache.json";
// Bump when the shape of a cached `value` changes, so an old on-disk cache
// from a prior plugin version is discarded instead of misread.
const CACHE_VERSION = 1;

let store: CacheStore | null = null;
let dirty = false;

// Deliberately its own root, separate from {state}/opencode/plugin-data/:
// that tree is reserved for *discovered* packages' own data (created only
// when a package's mcp.json is actually processed), and several tests assert
// it stays untouched when discovery finds nothing that needs it. This cache
// belongs to the plugin itself, not to anything it discovers. Exported so
// other plugin-owned caches (discovery-cache.ts) share one root instead of
// inventing their own convention.
export function pluginCacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "opencode-skill-autodiscovery");
}

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

// Test-only seam: drops the in-memory store so the next cachedRead/flush
// reloads from disk (or starts empty) instead of reusing state left over
// from a previous test's HOME. Production code never calls this: one
// opencode process makes exactly one config() call, so a process-lifetime
// singleton is the right scope there.
export function _resetFileCacheForTests(): void {
  store = null;
  dirty = false;
}

// Reads `path` and feeds its content to `parse`, reusing a previous result
// when the file's (mtimeMs, size) match the last successful cachedRead of the
// same (kind, path) pair. Throws exactly when `readFileSync`/`statSync` would
// have thrown (missing file, permission error, etc.) — existing callers
// already wrap those in try/catch, so behavior is unchanged when nothing is
// cached yet. `parse` must be pure and return a JSON-serializable value: it
// round-trips through the on-disk cache verbatim.
//
// `kind` namespaces the cache entry by what `parse` extracts, not just which
// file: the same file is read for different purposes at different call sites
// (e.g. "does this .md have agent frontmatter" vs. "the parsed agent from
// this .md"), and those must never share one cached value. The key is built
// with JSON.stringify (not string concatenation) so no separator choice can
// ever collide with a path or kind that happens to contain it.
export function cachedRead<T>(
  kind: string,
  path: string,
  parse: (content: string) => T,
): T {
  const st = statSync(path);
  const key = JSON.stringify([kind, path]);
  const s = loadStore();
  const cached = s[key];
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.value as T;
  }
  const content = readFileSync(path, "utf8");
  const value = parse(content);
  s[key] = { mtimeMs: st.mtimeMs, size: st.size, value };
  dirty = true;
  return value;
}

// Persists the in-memory cache to disk when it changed. Best-effort, like
// every other filesystem side effect in this codebase: a failed write is
// swallowed rather than surfaced, since caching is an optimization and must
// never be able to break discovery.
export function flushFileCache(): void {
  if (!dirty || !store) return;
  try {
    const path = cacheFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: CacheFile = { version: CACHE_VERSION, entries: store };
    writeFileSync(path, JSON.stringify(payload));
    dirty = false;
  } catch {
    // Non-fatal: the next run just re-reads everything.
  }
}
