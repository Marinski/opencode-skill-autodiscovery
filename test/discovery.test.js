import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectNodeModules,
  collectOpencodeCache,
  contains,
  packageFromDir,
  planConfig,
  readMcp,
  readPackage,
} from "../dist/discovery.js";

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
