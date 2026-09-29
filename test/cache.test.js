import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetFileCacheForTests, cachedRead, flushFileCache } from "../dist/cache.js";

let envRoot;
let oldEnv = {};

before(() => {
  envRoot = mkdtempSync(join(tmpdir(), "oc-cache-"));
  oldEnv = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.HOME = envRoot;
  delete process.env.XDG_CACHE_HOME;
});

after(() => {
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(envRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetFileCacheForTests();
});

test("cachedRead: a second call for an unchanged file skips parse", () => {
  const file = join(envRoot, "a.txt");
  writeFileSync(file, "hello");
  let calls = 0;
  const parse = (content) => {
    calls++;
    return content.toUpperCase();
  };
  assert.equal(cachedRead("upper", file, parse), "HELLO");
  assert.equal(cachedRead("upper", file, parse), "HELLO");
  assert.equal(calls, 1, "parse must run once; the second read is a cache hit");
});

test("cachedRead: an edited file (new mtime/size) is re-parsed, not stale", () => {
  const file = join(envRoot, "b.txt");
  writeFileSync(file, "v1");
  let calls = 0;
  const parse = (content) => {
    calls++;
    return content;
  };
  assert.equal(cachedRead("id", file, parse), "v1");
  // Force a distinct mtime even on filesystems with coarse mtime resolution:
  // content+size differ regardless, and cachedRead compares both.
  writeFileSync(file, "v2-longer");
  assert.equal(cachedRead("id", file, parse), "v2-longer");
  assert.equal(calls, 2, "content change must never be served from cache");
});

test("cachedRead: different kinds for the same path never share a cached value", () => {
  const file = join(envRoot, "c.txt");
  writeFileSync(file, "payload");
  const asIs = cachedRead("kind-a", file, (c) => c);
  const asBool = cachedRead("kind-b", file, (c) => c.length > 0);
  assert.equal(asIs, "payload");
  assert.equal(asBool, true);
  // Re-reading "kind-a" must still return the string, not the other kind's
  // cached boolean — this is the exact collision the plugin's two readers of
  // the same flat agent .md (a frontmatter presence check, and the full
  // parsed agent) would hit without kind-namespacing.
  assert.equal(cachedRead("kind-a", file, (c) => c), "payload");
});

test("cachedRead: propagates the same error a direct read would (missing file)", () => {
  const missing = join(envRoot, "does-not-exist.txt");
  assert.throws(() => cachedRead("id", missing, (c) => c));
});

test("flushFileCache + reload: a fresh process (simulated) reuses the persisted cache", () => {
  const file = join(envRoot, "d.txt");
  writeFileSync(file, "persisted");
  let calls = 0;
  const parse = (content) => {
    calls++;
    return content;
  };
  assert.equal(cachedRead("id", file, parse), "persisted");
  flushFileCache();

  // Simulate the next opencode process: drop the in-memory store so the next
  // cachedRead must go through the on-disk file, not process memory.
  _resetFileCacheForTests();

  assert.equal(cachedRead("id", file, parse), "persisted");
  assert.equal(calls, 1, "the on-disk cache must survive across a simulated restart");
});

test("flushFileCache: writes under its own root, not opencode's plugin-data tree", () => {
  const file = join(envRoot, "e.txt");
  writeFileSync(file, "x");
  cachedRead("id", file, (c) => c);
  flushFileCache();
  const pluginData = join(envRoot, ".local", "state", "opencode", "plugin-data");
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  assert.equal(
    existsSync(pluginData),
    false,
    "the file cache must never create opencode's plugin-data tree",
  );
  assert.ok(existsSync(cacheDir), "the file cache lands under its own cache root");
});

test("cachedRead: a corrupt on-disk cache degrades to a fresh read, never throws", () => {
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "discovery-file-cache.json"), "{not valid json");
  const file = join(envRoot, "f.txt");
  writeFileSync(file, "still works");
  assert.equal(cachedRead("id", file, (c) => c), "still works");
});

test("cachedRead: a stale-versioned on-disk cache is rejected, never misread", () => {
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(envRoot, "g.txt");
  writeFileSync(file, "fresh");
  const key = JSON.stringify(["id", file]);
  // Stale-versioned file: same key, stale value, but a version the running
  // code no longer recognizes. loadStore must discard the whole store rather
  // than serve the stale value — this is exactly the class of bug that once
  // reintroduced double-registration through a stale on-disk cache.
  writeFileSync(
    join(cacheDir, "discovery-file-cache.json"),
    JSON.stringify({
      version: "stale-not-a-number",
      entries: { [key]: { mtimeMs: 0, size: 0, value: "stale" } },
    }),
  );
  assert.equal(
    cachedRead("id", file, (c) => c),
    "fresh",
    "a stale-versioned cache must never be served; the file is re-read",
  );
  // And the rejected store is what persists now: flush + reload sees fresh.
  flushFileCache();
  _resetFileCacheForTests();
  assert.equal(cachedRead("id", file, (c) => c), "fresh");
});

test("credential reasons are never a cached value shape: no CACHE_VERSION bump needed for the credentialHit detectors", () => {
  // credentialHit's reasons (env/header name + value classification) feed
  // only McpPlanEntry.credentialReason, which planConfig consumes transiently
  // for log lines. Neither on-disk cache persists them: the per-file cache
  // holds file-parse results, the walk cache holds package/agent results. A
  // changed reason therefore cannot be served stale, and the version bump
  // those caches carry stays where its comments scope it: cached-shape
  // changes only. If a future change ever caches plan output or reason fields,
  // this test must be replaced by bumping the owning CACHE_VERSION.
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(envRoot, "h.txt");
  writeFileSync(file, JSON.stringify("v1"));
  assert.deepEqual(cachedRead("plugin-manifest", file, (c) => JSON.parse(c)), "v1");
  flushFileCache();

  const cacheFile = join(cacheDir, "discovery-file-cache.json");
  const payload = JSON.parse(readFileSync(cacheFile, "utf8"));
  const manifestKey = JSON.stringify(["plugin-manifest", file]);
  assert.equal(payload.entries[manifestKey].value, "v1");
  assert.ok(
    !JSON.stringify(payload).includes("credential"),
    "no credential reason may appear in any cached value",
  );

  // The same check for the walk cache: it is keyed by fingerprint, and its
  // values are package/agent results, never credential classifications.
  assert.ok(
    !existsSync(join(cacheDir, "discovery-root-cache.json")) ||
      !JSON.stringify(JSON.parse(readFileSync(join(cacheDir, "discovery-root-cache.json"), "utf8"))).includes("credential"),
    "no credential reason may appear in the walk cache either",
  );
});
