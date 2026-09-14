import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetDiscoveryCacheForTests,
  fingerprintTree,
  flushDiscoveryCache,
  getCachedPackages,
  setCachedPackages,
} from "../dist/discovery-cache.js";

let envRoot;
let oldEnv = {};

before(() => {
  envRoot = mkdtempSync(join(tmpdir(), "oc-discovery-cache-"));
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
  _resetDiscoveryCacheForTests();
});

function tree(name) {
  return mkdtempSync(join(envRoot, `${name}-`));
}

test("fingerprintTree: stable across repeated calls on an unchanged tree", () => {
  const root = tree("stable");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "b", "x.md"), "hello");
  writeFileSync(join(root, "top.md"), "world");

  const first = fingerprintTree(root);
  const second = fingerprintTree(root);
  assert.equal(first, second, "fingerprinting the same unchanged tree twice must agree");
});

test("fingerprintTree: changes on add, remove, and content edit", () => {
  const root = tree("changes");
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "a.md"), "v1");
  const base = fingerprintTree(root);

  // Content edit (changes the file's own mtime/size).
  writeFileSync(join(root, "pkg", "a.md"), "v1-longer-now");
  const afterEdit = fingerprintTree(root);
  assert.notEqual(afterEdit, base, "editing a file's content must change the fingerprint");

  // Add a file (changes the parent directory's mtime, and adds an entry).
  writeFileSync(join(root, "pkg", "b.md"), "new");
  const afterAdd = fingerprintTree(root);
  assert.notEqual(afterAdd, afterEdit, "adding a file must change the fingerprint");

  // Remove a file. Note this does NOT need to reproduce `afterEdit`'s exact
  // hash: removing an entry also bumps its parent directory's own mtime,
  // which is itself part of the fingerprint — mtimes move forward, they
  // don't "revert" just because the file set does. All that matters here is
  // that removal is observable.
  rmSync(join(root, "pkg", "b.md"));
  const afterRemove = fingerprintTree(root);
  assert.notEqual(afterRemove, afterAdd, "removing a file must change the fingerprint");
});

test("fingerprintTree: a bare mtime touch (no content/size change) still changes the fingerprint", () => {
  const root = tree("touch");
  mkdirSync(root, { recursive: true });
  const file = join(root, "a.md");
  writeFileSync(file, "same content");
  const before1 = fingerprintTree(root);

  // Same bytes, deliberately different mtime.
  const future = new Date(Date.now() + 60_000);
  utimesSync(file, future, future);
  const after1 = fingerprintTree(root);
  assert.notEqual(
    after1,
    before1,
    "an mtime-only touch must still invalidate — cheaper to over-invalidate than to miss a real edit",
  );
});

test("getCachedPackages/setCachedPackages: a hit returns exactly what was stored, a fingerprint mismatch misses", () => {
  const packages = [
    {
      source: "claude",
      trusted: true,
      name: "pkg-a",
      root: "/fake/pkg-a",
      skillDirs: ["/fake/pkg-a/skills/s1"],
    },
  ];
  setCachedPackages("key-1", "fp-1", packages);
  assert.deepEqual(getCachedPackages("key-1", "fp-1"), packages);
  assert.equal(getCachedPackages("key-1", "fp-2"), null, "a different fingerprint is a miss");
  assert.equal(getCachedPackages("key-2", "fp-1"), null, "a different key is a miss");
});

test("flushDiscoveryCache + reload: a fresh process (simulated) reuses the persisted cache", () => {
  const packages = [
    { source: "vscode", trusted: false, name: "pkg-b", root: "/fake/pkg-b", skillDirs: [] },
  ];
  setCachedPackages("persist-key", "fp-persist", packages);
  flushDiscoveryCache();

  _resetDiscoveryCacheForTests();

  assert.deepEqual(getCachedPackages("persist-key", "fp-persist"), packages);
});

test("flushDiscoveryCache: writes under the shared plugin cache root, not opencode's plugin-data tree", () => {
  setCachedPackages("k", "fp", []);
  flushDiscoveryCache();
  const pluginData = join(envRoot, ".local", "state", "opencode", "plugin-data");
  const cacheFile = join(
    envRoot,
    ".cache",
    "opencode-skill-autodiscovery",
    "discovery-root-cache.json",
  );
  assert.equal(existsSync(pluginData), false);
  assert.ok(existsSync(cacheFile));
});

test("flushDiscoveryCache: writes atomically (no stray temp file left behind)", () => {
  setCachedPackages("k", "fp", []);
  flushDiscoveryCache();
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  const leftoverTemp = readdirSync(cacheDir).some((f) => f.includes(".tmp"));
  assert.equal(leftoverTemp, false, "the temp file must be renamed away, not left behind");
});

test("getCachedPackages: a corrupt on-disk cache degrades to a miss, never throws", () => {
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "discovery-root-cache.json"), "{not valid json");
  assert.equal(getCachedPackages("any", "any"), null);
});

test("getCachedPackages: a cache file from a future/mismatched version is ignored", () => {
  const cacheDir = join(envRoot, ".cache", "opencode-skill-autodiscovery");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "discovery-root-cache.json"),
    JSON.stringify({ version: 999, entries: { any: { fingerprint: "any", packages: [] } } }),
  );
  assert.equal(getCachedPackages("any", "any"), null);
});
