import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  applyConfigPatch,
  collectClaude,
  collectClaudeManifest,
  collectNodeModules,
  collectOpencodeCache,
  collectVscode,
  collectVscodeCache,
  collectVscode,
  collectVscodeManifest,
  contains,
  findSkillDirs,
  packageFromDir,
  planConfig,
  readAgents,
  readMcp,
  readPackage,
} from "../dist/discovery.js";
import { sanitize } from "../dist/log.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

let stateDir;

function makeTemp(prefix = "oc-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makePackage(root, name, skills = [], mcp = null) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: SCHEMA, name }),
  );
  for (const skill of skills) {
    mkdirSync(join(root, "skills", skill), { recursive: true });
    writeFileSync(
      join(root, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill} description\n---\n# ${skill}\n`,
    );
  }
  if (mcp) {
    writeFileSync(join(root, "mcp.json"), JSON.stringify(mcp));
  }
  return root;
}

// Shared scaffolding for temp-dir fixtures. makeTemp/cleanup above own
// creation and removal; these two build fixture contents on top of them.

// Creates `dir` (recursively) holding a minimal valid SKILL.md.
function writeSkillDir(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n`,
  );
}

// Probes whether this platform allows the symlink/junction type the fixtures
// need. Callers must SKIP (never fail) when this returns false, e.g. Windows
// CI runners without symlink privilege.
function supportsSymlinks() {
  const probe = makeTemp("oc-symlinks-");
  try {
    const target = join(probe, "target");
    mkdirSync(target);
    symlinkSync(
      target,
      join(probe, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch {
    return false;
  } finally {
    cleanup(probe);
  }
}

// Renders an emitted dir as a POSIX-style path relative to the walk root so
// golden lists stay stable across platforms and mkdtemp randomness.
function goldenPaths(root, out) {
  const base = realpathSync(root);
  return [...out].map((d) => relative(base, d).split(sep).join("/")).sort();
}

before(() => {
  stateDir = makeTemp("oc-state-");
  process.env.XDG_STATE_HOME = stateDir;
});

after(() => {
  delete process.env.XDG_STATE_HOME;
  cleanup(stateDir);
});

test("contains: inside, outside, and same dir", () => {
  const root = makeTemp();
  const outside = makeTemp("oc-outside-");
  try {
    mkdirSync(join(root, "sub"));
    assert.equal(contains(root, join(root, "sub")), true);
    assert.equal(contains(root, outside), false);
    assert.equal(contains(root, root), true);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test("readPackage: recognises a valid package and its skills", () => {
  const root = makeTemp();
  try {
    const pkgDir = makePackage(root, "alpha", ["summarize", "deploy"]);
    const pkg = readPackage(pkgDir, "node_modules");
    assert.ok(pkg);
    assert.equal(pkg.name, "alpha");
    assert.equal(pkg.source, "node_modules");
    assert.equal(pkg.skillDirs.length, 2);
    assert.ok(pkg.skillDirs.every((d) => join(d, "SKILL.md").startsWith(join(pkgDir, "skills"))));
    assert.equal(pkg.mcpPath, undefined);
  } finally {
    cleanup(root);
  }
});

test("readPackage: rejects missing manifest, bad JSON, bad $schema, missing name", () => {
  const root = makeTemp();
  try {
    const empty = makeTemp();
    mkdirSync(join(empty, "skills", "x"), { recursive: true });
    assert.equal(readPackage(empty, "node_modules"), null);

    const badJson = makeTemp();
    mkdirSync(badJson, { recursive: true });
    writeFileSync(join(badJson, "plugin.json"), "{ not json");
    assert.equal(readPackage(badJson, "node_modules"), null);

    const noSchema = makeTemp();
    mkdirSync(noSchema, { recursive: true });
    writeFileSync(join(noSchema, "plugin.json"), JSON.stringify({ name: "x" }));
    assert.equal(readPackage(noSchema, "node_modules"), null);

    const wrongVersion = makeTemp();
    mkdirSync(wrongVersion, { recursive: true });
    writeFileSync(
      join(wrongVersion, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
        name: "x",
      }),
    );
    assert.equal(readPackage(wrongVersion, "node_modules"), null);

    const otherSite = makeTemp();
    mkdirSync(otherSite, { recursive: true });
    writeFileSync(
      join(otherSite, "plugin.json"),
      JSON.stringify({ $schema: "https://example.com/plugin.schema.json", name: "x" }),
    );
    assert.equal(readPackage(otherSite, "node_modules"), null);

    const noName = makeTemp();
    mkdirSync(noName, { recursive: true });
    writeFileSync(join(noName, "plugin.json"), JSON.stringify({ $schema: SCHEMA }));
    assert.equal(readPackage(noName, "node_modules"), null);
  } finally {
    cleanup(root);
  }
});

test("readPackage: unknown top-level fields are ignored", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({
        $schema: SCHEMA,
        name: "pkg",
        mystery: { anything: true },
        extensions: { "com.example.client": { setting: 1 } },
      }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    assert.ok(pkg);
    assert.equal(pkg.name, "pkg");
  } finally {
    cleanup(root);
  }
});

test("readPackage: skills are immediate children only, with a regular SKILL.md", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "skills", "top"), { recursive: true });
    writeFileSync(
      join(pkgDir, "skills", "top", "SKILL.md"),
      "---\nname: top\n---\n",
    );
    // Nested deeper: must not be discovered.
    mkdirSync(join(pkgDir, "skills", "top", "nested"), { recursive: true });
    writeFileSync(
      join(pkgDir, "skills", "top", "nested", "SKILL.md"),
      "---\nname: nested\n---\n",
    );
    // SKILL.md is a directory, not a regular file: must not be discovered.
    mkdirSync(join(pkgDir, "skills", "notafile", "SKILL.md"), { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({ $schema: SCHEMA, name: "pkg" }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    assert.ok(pkg);
    assert.equal(pkg.skillDirs.length, 1);
    assert.equal(
      join(pkg.skillDirs[0], "SKILL.md"),
      join(pkgDir, "skills", "top", "SKILL.md"),
    );
  } finally {
    cleanup(root);
  }
});

test("readPackage: symlinked skill dir outside the root is skipped", (t) => {
  const root = makeTemp();
  try {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: evil\n---\n");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "skills"), { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({ $schema: SCHEMA, name: "pkg" }),
    );
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(outside, join(pkgDir, "skills", "evil"), type);
    } catch {
      t.skip("cannot create symlink/junction on this platform");
      return;
    }
    const pkg = readPackage(pkgDir, "node_modules");
    assert.ok(pkg);
    assert.deepEqual(pkg.skillDirs, []);
  } finally {
    cleanup(root);
  }
});

// --- Legacy-walker parity baseline ------------------------------------------
// These fixtures pin findSkillDirs' CURRENT output for legitimate nested
// legacy layouts (nothing escapes, no cycles). The golden lists are the
// before/after contract for later walker changes: update them only alongside
// an intentional, reviewed behavior change — never to make a test pass.

test("findSkillDirs parity: nested legacy layout pins the emitted skill dirs", () => {
  const root = makeTemp();
  try {
    writeSkillDir(join(root, "top-a"), "top-a");
    // A skill dir below another skill dir is not reached: the walk does not
    // descend past an emitted SKILL.md.
    writeSkillDir(join(root, "top-a", "nested-b"), "nested-b");
    writeSkillDir(join(root, "group", "mid-c"), "mid-c");
    writeSkillDir(join(root, "group", "deeper", "deep-d"), "deep-d");
    // Noise that must stay out of the golden list.
    writeFileSync(join(root, "README.md"), "a file, not a dir");
    mkdirSync(join(root, "empty-dir"));

    const out = new Set();
    findSkillDirs(root, out, new Set());
    assert.deepEqual(goldenPaths(root, out), [
      "group/deeper/deep-d",
      "group/mid-c",
      "top-a",
    ]);
  } finally {
    cleanup(root);
  }
});

test("findSkillDirs parity: internal symlink aliases emit the real skill dir once", (t) => {
  if (!supportsSymlinks()) {
    t.skip("cannot create symlink/junction on this platform");
    return;
  }
  const root = makeTemp();
  try {
    writeSkillDir(join(root, "skills-a"), "skills-a");
    writeSkillDir(join(root, "shared", "target-b"), "target-b");
    symlinkSync(
      join(root, "shared"),
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const out = new Set();
    findSkillDirs(root, out, new Set());
    // The alias resolves inside the root, so it stays legitimate; the emitted
    // path is the real one (shared/target-b) and appears exactly once,
    // regardless of whether readdir visits `alias` or `shared` first.
    assert.deepEqual(goldenPaths(root, out), [
      "shared/target-b",
      "skills-a",
    ]);
  } finally {
    cleanup(root);
  }
});

test("packageFromDir: falls back to a tree walk without a manifest", () => {
  const root = makeTemp();
  try {
    const dir = join(root, "legacy");
    mkdirSync(join(dir, "deep", "skill-a"), { recursive: true });
    writeFileSync(join(dir, "deep", "skill-a", "SKILL.md"), "---\nname: skill-a\n---\n");
    const pkg = packageFromDir(dir, "claude");
    assert.ok(pkg);
    assert.equal(pkg.name, "legacy");
    assert.equal(pkg.skillDirs.length, 1);
    assert.equal(join(pkg.skillDirs[0], "SKILL.md"), join(dir, "deep", "skill-a", "SKILL.md"));

    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    assert.equal(packageFromDir(empty, "claude"), null);
  } finally {
    cleanup(root);
  }
});

test("findSkillDirs: terminates on a self-referential symlink cycle", (t) => {
  const root = makeTemp();
  try {
    mkdirSync(join(root, "solo"), { recursive: true });
    writeFileSync(join(root, "solo", "SKILL.md"), "---\nname: solo\n---\n");
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(root, join(root, "self"), type);
    } catch {
      t.skip("cannot create symlink/junction on this platform");
      return;
    }
    const out = new Set();
    findSkillDirs(root, out, new Set());
    // Completing at all is the bound: the old lexical walk recursed on
    // root/self/self/self/... until stack exhaustion.
    const expected = new Set([realpathSync(join(root, "solo"))]);
    assert.deepEqual(out, expected);
  } finally {
    cleanup(root);
  }
});

test("findSkillDirs: terminates when a descendant links back to an ancestor", (t) => {
  const root = makeTemp();
  try {
    mkdirSync(join(root, "deep", "inner"), { recursive: true });
    writeFileSync(
      join(root, "deep", "inner", "SKILL.md"),
      "---\nname: inner\n---\n",
    );
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(root, join(root, "deep", "back"), type);
    } catch {
      t.skip("cannot create symlink/junction on this platform");
      return;
    }
    const out = new Set();
    findSkillDirs(root, out, new Set());
    // `deep/back` resolves to the already-visited ancestor and must not be
    // re-walked; only the real skill dir is emitted.
    const expected = new Set([realpathSync(join(root, "deep", "inner"))]);
    assert.deepEqual(out, expected);
  } finally {
    cleanup(root);
  }
});

test("findSkillDirs: symlinked dir outside the walk root is never emitted", (t) => {
  const root = makeTemp();
  try {
    const legacy = join(root, "legacy");
    mkdirSync(join(legacy, "deep", "inner"), { recursive: true });
    writeFileSync(
      join(legacy, "deep", "inner", "SKILL.md"),
      "---\nname: inner\n---\n",
    );
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: evil\n---\n");
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(outside, join(legacy, "deep", "escape"), type);
    } catch {
      t.skip("cannot create symlink/junction on this platform");
      return;
    }
    const out = new Set();
    findSkillDirs(legacy, out, new Set());
    // `deep/escape` resolves outside `legacy`: neither it nor its SKILL.md
    // may appear in the emitted dirs, even though the link itself sits
    // inside the walked tree.
    const expected = new Set([realpathSync(join(legacy, "deep", "inner"))]);
    assert.deepEqual(out, expected);
  } finally {
    cleanup(root);
  }
});

test("findSkillDirs: depth cap stops the descent past 16 levels", () => {
  const root = makeTemp();
  try {
    // A plain nested chain (no symlinks): a skill well inside the cap is
    // found, one far below it is not, and the walk always terminates.
    const segments = Array.from({ length: 20 }, (_, i) => `l${i}`);
    writeSkillDir(join(root, ...segments, "too-deep"), "too-deep");
    writeSkillDir(join(root, ...segments.slice(0, 14), "in-cap"), "in-cap");

    const out = new Set();
    findSkillDirs(root, out, new Set());
    assert.deepEqual(goldenPaths(root, out), [
      [...segments.slice(0, 14), "in-cap"].join("/"),
    ]);
  } finally {
    cleanup(root);
  }
});

test("collectNodeModules: finds unscoped and scoped packages only", () => {
  const root = makeTemp();
  try {
    const nm = join(root, "node_modules");
    makePackage(join(nm, "alpha"), "alpha", ["a"]);
    makePackage(join(nm, "@scope", "beta"), "beta", ["b"]);
    mkdirSync(join(nm, "plain-dir"), { recursive: true });
    mkdirSync(join(nm, "@scope", "no-manifest"), { recursive: true });
    mkdirSync(join(nm, ".bin"), { recursive: true });
    const out = [];
    collectNodeModules(nm, out);
    assert.deepEqual(out.map((p) => p.name).sort(), ["alpha", "beta"]);
  } finally {
    cleanup(root);
  }
});

test("collectOpencodeCache: finds packages in the opencode cache layout", () => {
  const root = makeTemp();
  try {
    const packagesRoot = join(root, "packages");
    makePackage(
      join(packagesRoot, "dodo@latest", "node_modules", "dodo"),
      "dodo",
      ["s"],
    );
    // A cached non-package plugin must be ignored.
    mkdirSync(join(packagesRoot, "other@latest", "node_modules", "other"), {
      recursive: true,
    });
    const out = [];
    collectOpencodeCache(packagesRoot, out);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "dodo");
  } finally {
    cleanup(root);
  }
});

test("readMcp: maps stdio, expands placeholders, injects PLUGIN_ROOT/PLUGIN_DATA", () => {
  const root = makeTemp();
  try {
    const pkgDir = makePackage(root, "pkg", [], {
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        srv: {
          type: "stdio",
          command: "./bin/server",
          args: ["--cfg", "${PLUGIN_ROOT}/config.json"],
          env: { MODE: "${PLUGIN_DATA}/mode" },
        },
      },
    });
    const pkg = readPackage(pkgDir, "node_modules");
    const out = [];
    readMcp(pkg, out);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "srv");
    const dataDir = join(stateDir, "opencode", "plugin-data", "pkg");
    assert.deepEqual(out[0].entry, {
      type: "local",
      command: [join(pkgDir, "bin", "server"), "--cfg", `${pkgDir}/config.json`],
      environment: {
        MODE: `${dataDir}/mode`,
        PLUGIN_ROOT: pkgDir,
        PLUGIN_DATA: dataDir,
      },
      enabled: true,
    });
  } finally {
    cleanup(root);
  }
});

test("readMcp: maps streamable-http to remote and skips sse/unknowns", () => {
  const root = makeTemp();
  try {
    const pkgDir = makePackage(root, "pkg", [], {
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        api: { type: "streamable-http", url: "https://api.example.com/mcp" },
        legacy: { type: "sse", url: "https://old.example.com/sse" },
        broken: { type: "stdio", command: "npx", enabled: true },
        weird: { type: "magic", url: "https://x" },
      },
    });
    const pkg = readPackage(pkgDir, "node_modules");
    const out = [];
    readMcp(pkg, out);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "api");
    assert.deepEqual(out[0].entry, {
      type: "remote",
      url: "https://api.example.com/mcp",
      headers: {},
      enabled: true,
    });
  } finally {
    cleanup(root);
  }
});

test("readMcp: missing or mismatched $schema disables MCP for the package", () => {
  const root = makeTemp();
  try {
    const pkgDir = makePackage(root, "pkg", [], {
      mcpServers: { srv: { type: "stdio", command: "npx" } },
    });
    const pkg = readPackage(pkgDir, "node_modules");
    const out = [];
    readMcp(pkg, out);
    assert.equal(out.length, 0);
  } finally {
    cleanup(root);
  }
});

test("readMcp: mcp.json version must match plugin.json version", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({ $schema: SCHEMA, name: "pkg" }),
    );
    writeFileSync(
      join(pkgDir, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
        mcpServers: { srv: { type: "stdio", command: "npx" } },
      }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    const out = [];
    readMcp(pkg, out);
    assert.equal(out.length, 0);
  } finally {
    cleanup(root);
  }
});

test("planConfig: dedups skill paths and namespaces cross-source command collisions", () => {
  const root = makeTemp();
  try {
    const a = readPackage(makePackage(join(root, "a"), "alpha", ["spec"]), "node_modules");
    const b = readPackage(makePackage(join(root, "b"), "beta", ["spec", "unique"]), "opencode-cache");
    const plan = planConfig([a, a, b]);
    assert.equal(plan.skillPaths.length, 3);
    assert.deepEqual(
      plan.commands.map((c) => c.name).sort(),
      ["beta-spec", "spec", "unique"],
    );
  } finally {
    cleanup(root);
  }
});

test("planConfig: same-source duplicates are mirrors and do not namespace", () => {
  const root = makeTemp();
  try {
    const a = readPackage(makePackage(join(root, "a"), "alpha", ["dup"]), "node_modules");
    const b = readPackage(makePackage(join(root, "b"), "beta", ["dup"]), "node_modules");
    const plan = planConfig([a, b]);
    // Both skill paths are kept (no data loss)...
    assert.equal(plan.skillPaths.length, 2);
    // ...but only one command is registered, with no namespaced duplicate.
    assert.deepEqual(plan.commands.map((c) => c.name), ["dup"]);
  } finally {
    cleanup(root);
  }
});

test("planConfig: respects names already taken by the user's config", () => {
  const root = makeTemp();
  try {
    const a = readPackage(makePackage(join(root, "a"), "alpha", ["spec"]), "node_modules");
    const plan = planConfig([a], { commands: ["spec"] });
    assert.deepEqual(plan.commands.map((c) => c.name), ["alpha-spec"]);
  } finally {
    cleanup(root);
  }
});

test("planConfig: namespaces MCP collisions across distinct sources", () => {
  const root = makeTemp();
  try {
    const mcp = {
      $schema: MCP_SCHEMA_URL,
      mcpServers: { shared: { type: "streamable-http", url: "https://api.example.com/mcp" } },
    };
    const a = readPackage(makePackage(join(root, "a"), "alpha", [], mcp), "node_modules");
    const b = readPackage(makePackage(join(root, "b"), "beta", [], mcp), "opencode-cache");
    const plan = planConfig([a, b]);
    assert.deepEqual(
      plan.mcp.map((m) => m.key).sort(),
      ["beta/shared", "shared"],
    );
  } finally {
    cleanup(root);
  }
});

test("planConfig: same-source MCP mirrors are not duplicated", () => {
  const root = makeTemp();
  try {
    const mcp = {
      $schema: MCP_SCHEMA_URL,
      mcpServers: { shared: { type: "streamable-http", url: "https://api.example.com/mcp" } },
    };
    const a = readPackage(makePackage(join(root, "a"), "alpha", [], mcp), "node_modules");
    const b = readPackage(makePackage(join(root, "b"), "beta", [], mcp), "node_modules");
    const plan = planConfig([a, b]);
    assert.deepEqual(plan.mcp.map((m) => m.key), ["shared"]);
  } finally {
    cleanup(root);
  }
});

test("planConfig: skips readMcp entirely when the mcp flag is false", () => {
  const root = makeTemp();
  try {
    // stdio entries are the strongest probe for invocation: readMcp's stdio
    // branch mkdirs the package's plugin-data dir as a side effect, and ESM
    // bindings can't be monkey-patched with a literal spy.
    const mcp = {
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        srv: { type: "stdio", command: "npx", args: ["-y", "server"] },
      },
    };
    const a = readPackage(makePackage(join(root, "a"), "alpha", [], mcp), "node_modules");
    const dataDir = join(stateDir, "opencode", "plugin-data", "alpha");

    // Enabled: readMcp runs — entry planned, side effect performed.
    const on = planConfig([a], {}, { mcp: true });
    assert.deepEqual(on.mcp.map((m) => m.key), ["srv"]);
    assert.equal(existsSync(dataDir), true);

    // Disabled: readMcp must not be invoked at all — nothing planned, no
    // filesystem side effects (dir removed first so absence proves it).
    rmSync(dataDir, { recursive: true, force: true });
    const off = planConfig([a], {}, { mcp: false });
    assert.deepEqual(off.mcp, []);
    assert.equal(existsSync(dataDir), false);
  } finally {
    cleanup(root);
  }
});

test("readPackage: rejects names that violate the manifest name constraints", () => {
  const root = makeTemp();
  try {
    const invalid = ["My-Plugin", "-start", "trailing-", "has--double", "too.many..dots", "a".repeat(65)];
    invalid.forEach((name, i) => {
      const dir = join(root, `bad-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name }));
      assert.equal(readPackage(dir, "node_modules"), null, `expected "${name}" to be rejected`);
    });
    const valid = ["my-plugin", "acme.tools", "lint3r", "a"];
    valid.forEach((name, i) => {
      const dir = join(root, `good-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name }));
      assert.ok(readPackage(dir, "node_modules"), `expected "${name}" to be accepted`);
    });
  } finally {
    cleanup(root);
  }
});

test("readMcp: rejects non-http(s) urls for remote transports", () => {
  const root = makeTemp();
  try {
    const pkgDir = makePackage(root, "pkg", [], {
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        bad: { type: "streamable-http", url: "file:///etc/passwd" },
        good: { type: "streamable-http", url: "https://api.example.com/mcp" },
      },
    });
    const pkg = readPackage(pkgDir, "node_modules");
    const out = [];
    readMcp(pkg, out);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "good");
  } finally {
    cleanup(root);
  }
});

test("collectClaudeManifest: resolves installPaths from installed_plugins.json", () => {
  const root = makeTemp();
  try {
    const pluginDir = makePackage(join(root, "plugins", "cache", "org", "repo"), "alpha", ["s"]);
    const manifestPath = join(root, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ plugins: { "org/repo": [{ installPath: pluginDir }] } }),
    );
    const out = [];
    collectClaudeManifest(out, manifestPath);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "alpha");
    assert.equal(out[0].skillDirs.length, 1);
  } finally {
    cleanup(root);
  }
});

test("collectClaude: walks hash-named remote plugin dirs for flat agents and skills", () => {
  const root = makeTemp();
  try {
    // Simulate ~/.claude/remote/plugins/<hash>/ holding a plugin with flat
    // agent files and a skills tree, no installed_plugins.json at all.
    const remote = join(root, ".claude", "remote", "plugins");
    const hashDir = join(remote, "6d93ea7b9a6121ca");
    mkdirSync(join(hashDir, "skills", "s"), { recursive: true });
    writeFileSync(join(hashDir, "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
    writeFileSync(
      join(hashDir, "engineering-code-reviewer.md"),
      "---\ndescription: Reviews diffs\n---\nYou review code.",
    );
    const oldHome = process.env.HOME;
    const oldUser = process.env.USERPROFILE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try {
      const out = [];
      collectClaude(out);
      const pkg = out.find((p) => p.source === "claude");
      assert.ok(pkg, "hash-named remote plugin discovered");
      assert.equal(pkg.skillDirs.length, 1);
      const agents = readAgents(pkg);
      assert.equal(agents.length, 1);
      assert.equal(agents[0].name, "engineering-code-reviewer");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUser === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUser;
    }
  } finally {
    cleanup(root);
  }
});

test("collectVscodeManifest: resolves pluginUri entries from installed.json", () => {
  const root = makeTemp();
  try {
    const pluginDir = makePackage(join(root, "github.com", "org", "repo"), "beta", ["t"]);
    const manifestPath = join(root, "installed.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        installed: [{ pluginUri: `file:///${pluginDir.replace(/\\/g, "/")}` }],
      }),
    );
    const out = [];
    collectVscodeManifest(out, manifestPath);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "beta");
    assert.equal(out[0].skillDirs.length, 1);
  } finally {
    cleanup(root);
  }
});

test("collectVscodeCache: resolves synced bundles with and without a nonce subdir", () => {
  const root = makeTemp();
  try {
    const agentPlugins = join(root, "data", "agentPlugins");
    mkdirSync(agentPlugins, { recursive: true });
    makePackage(join(agentPlugins, "vscode-synced-some", "abc123"), "synced", ["s1"]);
    makePackage(join(agentPlugins, "vscode-synced-other"), "synced2", ["s2"]);
    writeFileSync(
      join(agentPlugins, "cache.json"),
      JSON.stringify([
        { uri: "vscode://synced/some", nonce: "abc123" },
        { uri: "vscode://synced/other" },
      ]),
    );
    const out = [];
    collectVscodeCache(out, join(agentPlugins, "cache.json"));
    const names = out.map((p) => p.name);
    assert.ok(names.includes("synced"), "with-nonce bundle discovered");
    assert.ok(names.includes("synced2"), "without-nonce bundle discovered");
    // The with-nonce bundle must not be discovered twice via the {key} walk.
    assert.equal(out.filter((p) => p.name === "synced").length, 1);
  } finally {
    cleanup(root);
  }
});

test("sanitize: strips ANSI escapes and control characters", () => {
  assert.equal(sanitize("hello\u001b[31mred\u001b[0m world"), "hellored world");
  assert.equal(sanitize("a\u0007b\u001fc"), "abc");
});

test("collectAgentPluginRoot: a marketplace clone is discovered even when only cache.json exists", () => {
  const root = makeTemp();
  try {
    // Remote layout: agentPlugins/ holds a synced-bundle cache.json AND a
    // marketplace clone that has no installed.json entry. The clone must
    // still be found via the plugin-root tree walk.
    const agentPlugins = join(root, "data", "agentPlugins");
    const eng = join(
      agentPlugins,
      "github.com",
      "Marinski",
      "agency-agents",
      "ref_plugins",
      "plugins",
      "engineering",
    );
    mkdirSync(join(eng, "skills", "code-review"), { recursive: true });
    writeFileSync(
      join(eng, "skills", "code-review", "SKILL.md"),
      "---\nname: code-review\n---\n",
    );
    writeFileSync(
      join(eng, "engineering-code-reviewer.md"),
      "---\ndescription: Reviews diffs\n---\nYou review code.",
    );
    writeFileSync(join(agentPlugins, "cache.json"), JSON.stringify([]));
    const out = [];
    collectVscode(out, [root]);
    const normRoot = root.replace(/\\/g, "/");
    const engPkg = out.find(
      (p) =>
        p.source === "vscode" &&
        p.name === "engineering" &&
        p.root.replace(/\\/g, "/").startsWith(normRoot),
    );
    assert.ok(engPkg, "marketplace clone discovered despite cache.json");
    assert.equal(engPkg.skillDirs.length, 1);
    const agents = readAgents(engPkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "engineering-code-reviewer");
  } finally {
    cleanup(root);
  }
});

test("collectAgentPluginRoot: installed.json suppresses the fallback walk", () => {
  const root = makeTemp();
  try {
    // Local layout: installed.json is authoritative. A clone that is NOT
    // listed there must stay hidden (cloned-but-not-installed marketplace).
    const agentPlugins = join(root, "agentPlugins");
    const listed = join(agentPlugins, "github.com", "org", "installed-plugin");
    const stray = join(agentPlugins, "github.com", "org", "stray-plugin");
    makePackage(listed, "listed", ["s"]);
    makePackage(stray, "stray", ["s"]);
    writeFileSync(
      join(agentPlugins, "installed.json"),
      JSON.stringify({
        version: 1,
        installed: [{ pluginUri: `file:///${listed.replace(/\\/g, "/")}`, name: "listed" }],
      }),
    );
    const out = [];
    collectVscode(out, [root]);
    const normRoot = root.replace(/\\/g, "/");
    const names = out
      .filter((p) => p.root.replace(/\\/g, "/").startsWith(normRoot))
      .map((p) => p.name);
    assert.ok(names.includes("listed"), "installed plugin discovered");
    assert.ok(!names.includes("stray"), "unlisted clone stays hidden");
  } finally {
    cleanup(root);
  }
});

test("applyConfigPatch: merges without overwriting user entries", () => {
  const plan = {
    skillPaths: ["/a/s1", "/a/s2"],
    commands: [
      { name: "s1", description: "S1", template: "T1" },
      { name: "s2", description: "S2", template: "T2" },
    ],
    mcp: [{ key: "m", entry: { type: "remote", url: "https://x", enabled: true } }],
    agents: [{ name: "a1", agent: { description: "A1" } }],
  };
  const cfg = {
    skills: { paths: ["/a/s1"] },
    command: { s1: { template: "user-template" } },
    mcp: undefined,
    agent: { a1: { description: "user agent" } },
  };
  applyConfigPatch(cfg, plan, { mcp: true, agents: true });
  // Duplicate path already present is not re-added.
  assert.deepEqual(cfg.skills.paths, ["/a/s1", "/a/s2"]);
  assert.equal(cfg.command.s1.template, "user-template");
  assert.equal(cfg.command.s2.template, "T2");
  assert.deepEqual(cfg.mcp.m, { type: "remote", url: "https://x", enabled: true });
  assert.equal(cfg.agent.a1.description, "user agent");
});

test("applyConfigPatch: no-op when nothing found and opt-ins disabled", () => {
  const cfg = { skills: { paths: ["/user"] } };
  applyConfigPatch(
    cfg,
    { skillPaths: [], commands: [], mcp: [], agents: [{ name: "a", agent: { description: "A" } }] },
    { mcp: false, agents: false },
  );
  assert.deepEqual(cfg.skills.paths, ["/user"]);
  assert.equal(cfg.command, undefined);
  assert.equal(cfg.agent, undefined);
});

test("applyConfigPatch: does not create command/mcp/agent objects when empty", () => {
  const cfg = {};
  applyConfigPatch(
    cfg,
    { skillPaths: ["/a"], commands: [], mcp: [], agents: [] },
    { mcp: true, agents: true },
  );
  assert.deepEqual(cfg.skills.paths, ["/a"]);
  assert.equal(cfg.command, undefined);
  assert.equal(cfg.mcp, undefined);
  assert.equal(cfg.agent, undefined);
});

test("applyConfigPatch: registers agents only when the agents opt-in is enabled", () => {
  const plan = {
    skillPaths: [],
    commands: [],
    mcp: [],
    agents: [{ name: "reviewer", agent: { description: "Reviews diffs" } }],
  };
  const off = {};
  applyConfigPatch(off, plan, { mcp: false, agents: false });
  assert.equal(off.agent, undefined);
  const on = {};
  applyConfigPatch(on, plan, { mcp: false, agents: true });
  assert.deepEqual(on.agent.reviewer, { description: "Reviews diffs" });
});

test("readAgents: reads dev.opencode manifest agents and strips permission", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({
        $schema: SCHEMA,
        name: "pkg",
        extensions: {
          "dev.opencode": {
            agents: {
              reviewer: {
                description: "Reviews diffs",
                prompt: "You review code",
                mode: "subagent",
                permission: { edit: "allow" },
                bogus: 123,
              },
              broken: {},
            },
          },
        },
      }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "reviewer");
    assert.deepEqual(agents[0].agent, {
      description: "Reviews diffs",
      prompt: "You review code",
      mode: "subagent",
    });
  } finally {
    cleanup(root);
  }
});

test("readAgents: reads dev.opencode/agents/<name>.json extension directory", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "dev.opencode", "agents"), { recursive: true });
    writeFileSync(join(pkgDir, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name: "pkg" }));
    writeFileSync(
      join(pkgDir, "dev.opencode", "agents", "triage.json"),
      JSON.stringify({ description: "Triages issues", prompt: "You triage" }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "triage");
    assert.equal(agents[0].agent.prompt, "You triage");
  } finally {
    cleanup(root);
  }
});

test("readAgents: reads Claude Code plugin agents shim with AGENTS.md fallback", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "legacy");
    mkdirSync(join(pkgDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pkgDir, "agents", "explorer"), { recursive: true });
    writeFileSync(
      join(pkgDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "legacy",
        agents: {
          explorer: { description: "Explores the codebase" },
        },
      }),
    );
    writeFileSync(join(pkgDir, "agents", "explorer", "AGENTS.md"), "# Explorer\n\nFind things.\n");
    const pkg = packageFromDir(pkgDir, "node_modules");
    assert.ok(pkg, "agents-only plugin is discovered");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "explorer");
    assert.equal(agents[0].agent.description, "Explores the codebase");
    assert.equal(agents[0].agent.prompt, "# Explorer\n\nFind things.\n");
  } finally {
    cleanup(root);
  }
});

test("readAgents: reads flat agents/<name>.md files (agency-agents layout)", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "skills", "s"), { recursive: true });
    writeFileSync(join(pkgDir, "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
    writeFileSync(join(pkgDir, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name: "pkg" }));
    mkdirSync(join(pkgDir, "agents"), { recursive: true });
    writeFileSync(
      join(pkgDir, "agents", "engineering-code-reviewer.md"),
      [
        "---",
        "name: Code Reviewer",
        "description: Expert code reviewer",
        "color: purple",
        "---",
        "",
        "You are Code Reviewer.",
      ].join("\n"),
    );
    writeFileSync(join(pkgDir, "agents", "empty.md"), "");
    const pkg = readPackage(pkgDir, "node_modules");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "engineering-code-reviewer");
    assert.equal(agents[0].agent.description, "Expert code reviewer");
    assert.equal(agents[0].agent.color, "#800080");
    assert.equal(agents[0].agent.prompt, "You are Code Reviewer.");
  } finally {
    cleanup(root);
  }
});

test("readAgents: reads bare <name>.md files in the package root (new agency-agents layout)", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "engineering");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "engineering-code-reviewer.md"),
      [
        "---",
        "name: Code Reviewer",
        "description: Expert code reviewer",
        "color: purple",
        "---",
        "",
        "You are Code Reviewer.",
      ].join("\n"),
    );
    writeFileSync(
      join(pkgDir, "engineering-ai-engineer.md"),
      "---\ndescription: AI engineer\n---\nYou build AI.",
    );
    // Docs and non-agent files in the root must be ignored.
    writeFileSync(join(pkgDir, "README.md"), "# Not an agent");
    writeFileSync(join(pkgDir, "divisions.json"), JSON.stringify({}));
    const pkg = packageFromDir(pkgDir, "vscode");
    assert.ok(pkg, "root-level agent files make the dir a package");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 2);
    const byName = new Map(agents.map((a) => [a.name, a.agent]));
    assert.equal(byName.get("engineering-code-reviewer").prompt, "You are Code Reviewer.");
    assert.equal(byName.get("engineering-code-reviewer").color, "#800080");
    assert.equal(byName.get("engineering-ai-engineer").description, "AI engineer");
    assert.equal(byName.get("README"), undefined, "README.md is not an agent");
  } finally {
    cleanup(root);
  }
});

test("readAgents: normalizes agent colors to values opencode accepts", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "agents"), { recursive: true });
    writeFileSync(join(pkgDir, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name: "pkg" }));
    const cases = {
      // Claude Code frontmatter uses bare CSS names: must be mapped to hex.
      named: "orange",
      // opencode theme tokens and hex literals pass through untouched.
      token: "Warning",
      hex: "#a1B2c3",
      shorthand: "#0f8",
      // Anything else would reject the entire merged config: drop it.
      bogus: "chartreuse-ish",
    };
    for (const [name, color] of Object.entries(cases)) {
      writeFileSync(
        join(pkgDir, "agents", `${name}.md`),
        `---\ndescription: ${name}\ncolor: ${color}\n---\nBody`,
      );
    }
    const pkg = readPackage(pkgDir, "node_modules");
    const byName = new Map(readAgents(pkg).map((a) => [a.name, a.agent]));
    assert.equal(byName.get("named").color, "#FFA500");
    assert.equal(byName.get("token").color, "warning");
    assert.equal(byName.get("hex").color, "#a1B2c3");
    assert.equal(byName.get("shorthand").color, "#00ff88");
    assert.equal(byName.get("bogus").color, undefined);
    // A dropped color must not cost us the agent itself.
    assert.equal(byName.get("bogus").description, "bogus");
  } finally {
    cleanup(root);
  }
});

test("readAgents: normalizes colors from dev.opencode manifest agents too", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({
        $schema: SCHEMA,
        name: "pkg",
        extensions: {
          "dev.opencode": {
            agents: { reviewer: { description: "Reviews diffs", color: "orange" } },
          },
        },
      }),
    );
    const pkg = readPackage(pkgDir, "node_modules");
    const agents = readAgents(pkg);
    assert.equal(agents[0].agent.color, "#FFA500");
  } finally {
    cleanup(root);
  }
});

test("readAgents: dev.opencode agents win over flat agents with the same name", () => {
  const root = makeTemp();
  try {
    const pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "agents"), { recursive: true });
    writeFileSync(
      join(pkgDir, "plugin.json"),
      JSON.stringify({
        $schema: SCHEMA,
        name: "pkg",
        extensions: {
          "dev.opencode": {
            agents: { reviewer: { description: "Manifest agent" } },
          },
        },
      }),
    );
    writeFileSync(
      join(pkgDir, "agents", "reviewer.md"),
      "---\ndescription: Flat agent\n---\nFlat body",
    );
    const pkg = readPackage(pkgDir, "node_modules");
    const agents = readAgents(pkg);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].agent.description, "Manifest agent");
  } finally {
    cleanup(root);
  }
});

test("planConfig: namespaces agent collisions across distinct sources", () => {
  const root = makeTemp();
  try {
    const manifest = {
      $schema: SCHEMA,
      name: "alpha",
      extensions: { "dev.opencode": { agents: { reviewer: { description: "R" } } } },
    };
    const aDir = join(root, "a");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(join(aDir, "plugin.json"), JSON.stringify(manifest));
    const bDir = join(root, "b");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(
      join(bDir, "plugin.json"),
      JSON.stringify({ ...manifest, name: "beta" }),
    );
    const a = readPackage(aDir, "node_modules");
    const b = readPackage(bDir, "opencode-cache");
    const plan = planConfig([a, b]);
    assert.deepEqual(
      plan.agents.map((x) => x.name).sort(),
      ["beta-reviewer", "reviewer"],
    );
  } finally {
    cleanup(root);
  }
});

test("planConfig: same-source agent mirrors are not duplicated", () => {
  const root = makeTemp();
  try {
    const manifest = (name) => ({
      $schema: SCHEMA,
      name,
      extensions: { "dev.opencode": { agents: { reviewer: { description: "R" } } } },
    });
    const aDir = join(root, "a");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(join(aDir, "plugin.json"), JSON.stringify(manifest("alpha")));
    const bDir = join(root, "b");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "plugin.json"), JSON.stringify(manifest("beta")));
    const a = readPackage(aDir, "node_modules");
    const b = readPackage(bDir, "node_modules");
    const plan = planConfig([a, b]);
    assert.deepEqual(plan.agents.map((x) => x.name), ["reviewer"]);
  } finally {
    cleanup(root);
  }
});

test("planConfig: collapses the same conformant package across sources", () => {
  const root = makeTemp();
  try {
    const build = (dir) => {
      mkdirSync(join(dir, "skills", "s"), { recursive: true });
      writeFileSync(join(dir, "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
      writeFileSync(
        join(dir, "plugin.json"),
        JSON.stringify({
          $schema: SCHEMA,
          name: "dotest",
          extensions: { "dev.opencode": { agents: { reviewer: { description: "R" } } } },
        }),
      );
    };
    const cacheDir = join(root, "cache");
    const nmDir = join(root, "node_modules");
    build(cacheDir);
    build(nmDir);
    const cache = readPackage(cacheDir, "opencode-cache");
    const nm = readPackage(nmDir, "node_modules");
    const plan = planConfig([cache, nm]);
    // Same package name across sources: one agent, one skill path, one command.
    assert.deepEqual(plan.agents.map((x) => x.name), ["reviewer"]);
    assert.equal(plan.skillPaths.length, 1);
    assert.deepEqual(plan.commands.map((c) => c.name), ["s"]);
  } finally {
    cleanup(root);
  }
});

test("exclude: a named package is suppressed from every source type", () => {
  const root = makeTemp();
  try {
    const name = "blockme";
    const skills = ["hidden"];

    // claude: installPath in installed_plugins.json
    const claudeFixture = makePackage(join(root, "claude-fixture"), name, skills);
    const claudeJson = join(root, "installed_plugins.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ plugins: { "org/repo": [{ installPath: claudeFixture }] } }),
    );

    // vscode: pluginUri in installed.json
    const vscodeFixture = makePackage(join(root, "vscode-fixture"), name, skills);
    const vscodeJson = join(root, "installed.json");
    writeFileSync(
      vscodeJson,
      JSON.stringify({
        installed: [{ pluginUri: `file:///${vscodeFixture.replace(/\\/g, "/")}` }],
      }),
    );

    // opencode-cache: {packages}/{name}@{version}/node_modules/{name}
    const packagesRoot = join(root, "cache-packages");
    makePackage(join(packagesRoot, `${name}@1.0.0`, "node_modules", name), name, skills);

    // node_modules: project dependency
    const nmDir = join(root, "project", "node_modules");
    makePackage(join(nmDir, name), name, skills);

    // extra root: a non-standard VS Code data dir holding the package itself
    const extraRoot = join(root, "extra-data");
    makePackage(join(extraRoot, "agent-plugins"), name, skills);

    const expectCollected = (out, label) =>
      assert.ok(out.some((p) => p.name === name), `${label}: collected without exclude`);
    const expectSuppressed = (out, label) =>
      assert.ok(!out.some((p) => p.name === name), `${label}: suppressed with exclude`);

    const claudeOn = [];
    collectClaudeManifest(claudeOn, claudeJson);
    const claudeOff = [];
    collectClaudeManifest(claudeOff, claudeJson, [name]);
    expectCollected(claudeOn, "claude");
    expectSuppressed(claudeOff, "claude");

    const vscodeOn = [];
    collectVscodeManifest(vscodeOn, vscodeJson);
    const vscodeOff = [];
    collectVscodeManifest(vscodeOff, vscodeJson, [name]);
    expectCollected(vscodeOn, "vscode");
    expectSuppressed(vscodeOff, "vscode");

    const cacheOn = [];
    collectOpencodeCache(packagesRoot, cacheOn);
    const cacheOff = [];
    collectOpencodeCache(packagesRoot, cacheOff, [name]);
    expectCollected(cacheOn, "opencode-cache");
    expectSuppressed(cacheOff, "opencode-cache");

    const nmOn = [];
    collectNodeModules(nmDir, nmOn);
    const nmOff = [];
    collectNodeModules(nmDir, nmOff, false, [name]);
    expectCollected(nmOn, "node_modules");
    expectSuppressed(nmOff, "node_modules");

    const extraOn = [];
    collectVscode(extraOn, [extraRoot]);
    const extraOff = [];
    collectVscode(extraOff, [extraRoot], [name]);
    expectCollected(extraOn, "extra");
    expectSuppressed(extraOff, "extra");
  } finally {
    cleanup(root);
  }
});

test("exclude: legacy packages match on the directory basename", () => {
  const root = makeTemp();
  try {
    // No plugin.json anywhere: packageFromDir falls back to the tree walk and
    // names the package after the directory basename.
    const legacy = join(root, "legacy-pkg");
    mkdirSync(join(legacy, "deep"), { recursive: true });
    writeFileSync(join(legacy, "deep", "SKILL.md"), "---\nname: hidden\n---\n");
    const claudeJson = join(root, "installed_plugins.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ plugins: { "org/repo": [{ installPath: legacy }] } }),
    );
    const off = [];
    collectClaudeManifest(off, claudeJson, ["legacy-pkg"]);
    assert.equal(off.length, 0);
    const on = [];
    collectClaudeManifest(on, claudeJson);
    assert.equal(on.length, 1);
    assert.equal(on[0].name, "legacy-pkg");
  } finally {
    cleanup(root);
  }
});
