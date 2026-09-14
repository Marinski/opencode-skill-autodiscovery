import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
