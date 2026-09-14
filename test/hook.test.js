import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import plugin from "../dist/index.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

let envRoot;
let oldCwd;
let oldEnv = {};

before(() => {
  envRoot = mkdtempSync(join(tmpdir(), "oc-hook-"));
  oldCwd = process.cwd();
  oldEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  // Isolate machine-local discovery: homedir() and the plugin cache both land
  // under envRoot, and the project dir is envRoot, so only what we create in
  // envRoot/node_modules is discoverable.
  process.env.USERPROFILE = envRoot;
  process.env.HOME = envRoot;
  process.env.APPDATA = join(envRoot, "AppData", "Roaming");
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_STATE_HOME;
  process.chdir(envRoot);
});

after(() => {
  process.chdir(oldCwd);
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(envRoot, { recursive: true, force: true });
});

function makePackage(root, name, skills = [], mcp = null) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name }));
  for (const skill of skills) {
    mkdirSync(join(root, "skills", skill), { recursive: true });
    writeFileSync(
      join(root, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill}\n---\n# ${skill}\n`,
    );
  }
  if (mcp) writeFileSync(join(root, "mcp.json"), JSON.stringify(mcp));
  return root;
}

async function runHook(options) {
  const hooks = await plugin({}, options);
  const cfg = { skills: { paths: [] } };
  await hooks.config(cfg);
  return cfg;
}

test("config hook: no-op when nothing is installed", async () => {
  const cfg = await runHook({});
  assert.deepEqual(cfg.skills.paths, []);
  assert.equal(cfg.command, undefined);
  assert.equal(cfg.mcp, undefined);
  assert.equal(cfg.agent, undefined);
});

test("config hook: discovers an Agent Plugins package in the project node_modules", async () => {
  makePackage(join(envRoot, "node_modules", "dotest"), "dotest", ["s1", "s2"]);
  const cfg = await runHook({ scanNodeModules: true });
  const found = cfg.skills.paths.filter(
    (p) => p.includes("dotest") && (p.endsWith("skills\\s1") || p.endsWith("skills/s1")),
  );
  assert.equal(found.length, 1);
  assert.ok(cfg.command.s1, "s1 slash command registered");
  assert.ok(cfg.command.s2, "s2 slash command registered");
  assert.equal(cfg.command.s1.template.includes('Load the "s1" skill'), true);
  assert.equal(cfg.mcp, undefined);
});

test("config hook: registers MCP only when mcp is enabled and the package is consented", async () => {
  makePackage(join(envRoot, "node_modules", "dotest2"), "dotest2", ["s"], {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      srv: { type: "streamable-http", url: "https://api.example.com/mcp" },
    },
  });
  const off = await runHook({ scanNodeModules: true });
  assert.equal(off.mcp, undefined);
  // mcp:true alone is not enough for an untrusted package: the trust gate
  // admits it only when the package name is listed in consent.mcp.
  const gated = await runHook({ scanNodeModules: true, mcp: true });
  assert.equal(gated.mcp, undefined, "untrusted package skipped without consent");
  const on = await runHook({
    scanNodeModules: true,
    mcp: true,
    consent: { mcp: ["dotest2"] },
  });
  assert.equal(on.mcp.srv.type, "remote");
  assert.equal(on.mcp.srv.url, "https://api.example.com/mcp");
});

test("config hook: consent admits an untrusted package's MCP servers", async () => {
  makePackage(join(envRoot, "node_modules", "consenttest"), "consenttest", ["s"], {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      srv: { type: "streamable-http", url: "https://api.example.com/mcp" },
    },
  });
  // Consent gates MCP registration for untrusted packages: with the switch
  // on and the package listed, servers register; with the switch off,
  // consent alone enables nothing.
  const on = await runHook({
    scanNodeModules: true,
    mcp: true,
    agents: true,
    consent: { mcp: ["consenttest"], agents: ["consenttest"] },
  });
  assert.ok(
    on.skills.paths.some((p) => p.includes("consenttest")),
    "package still discovered with consent present",
  );
  assert.equal(on.mcp.srv.type, "remote", "consented package's servers register");
  const off = await runHook({ consent: { mcp: ["consenttest"] } });
  assert.equal(off.mcp, undefined, "consent without the mcp switch enables nothing");
  assert.equal(off.agent, undefined, "consent without the agents switch enables nothing");
});

test("config hook: does not overwrite a user-defined command", async () => {
  makePackage(join(envRoot, "node_modules", "dotest3"), "dotest3", ["custom"]);
  const hooks = await plugin({}, { scanNodeModules: true });
  const cfg = {
    skills: { paths: [] },
    command: { custom: { template: "user template" } },
  };
  await hooks.config(cfg);
  assert.equal(cfg.command.custom.template, "user template");
});

test("config hook: registers agents only when the agents option is enabled and the package is consented", async () => {
  const pkgDir = join(envRoot, "node_modules", "dotest4");
  mkdirSync(join(pkgDir, "skills", "s"), { recursive: true });
  writeFileSync(
    join(pkgDir, "skills", "s", "SKILL.md"),
    "---\nname: s\n---\n",
  );
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      $schema: SCHEMA,
      name: "dotest4",
      extensions: {
        "dev.opencode": {
          agents: {
            reviewer: {
              description: "Reviews diffs",
              prompt: "You review code",
              permission: { edit: "allow" },
            },
          },
        },
      },
    }),
  );
  const off = await runHook({ scanNodeModules: true });
  assert.equal(off.agent, undefined);
  const gated = await runHook({ scanNodeModules: true, agents: true });
  assert.equal(
    gated.agent,
    undefined,
    "untrusted package skipped without consent.agents",
  );
  const on = await runHook({
    scanNodeModules: true,
    agents: true,
    consent: { agents: ["dotest4"] },
  });
  assert.ok(on.agent.reviewer, "agent registered when agents:true and consented");
  assert.equal(on.agent.reviewer.description, "Reviews diffs");
  assert.equal(on.agent.reviewer.permission, undefined, "permission stripped");
});

test("config hook: agent tools from a consented package are dropped with a merge-time warning naming package and agent", async () => {
  const pkgDir = join(envRoot, "node_modules", "toolgrant");
  mkdirSync(join(pkgDir, "skills", "s"), { recursive: true });
  writeFileSync(
    join(pkgDir, "skills", "s", "SKILL.md"),
    "---\nname: s\n---\n",
  );
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      $schema: SCHEMA,
      name: "toolgrant",
      extensions: {
        "dev.opencode": {
          agents: {
            reviewer: {
              description: "Reviews diffs",
              prompt: "You review code",
              tools: { bash: true, write: true },
            },
          },
        },
      },
    }),
  );

  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  let cfg;
  try {
    cfg = await runHook({
      scanNodeModules: true,
      agents: true,
      consent: { agents: ["toolgrant"] },
    });
  } finally {
    console.error = origError;
  }

  // The agent is admitted, minus its declared tools grant...
  assert.ok(cfg.agent.reviewer, "consented agent registers");
  assert.equal("tools" in cfg.agent.reviewer, false, "tools grant never reaches config");
  // ...and the drop warning appears in the hook's merge output, naming the
  // agent and the package that supplied it.
  const drop = logs.find((line) => line.includes("dropping tools"));
  assert.ok(drop, "tools-drop warning appears in the merge summary");
  assert.match(drop, /agent "reviewer"/);
  assert.match(drop, /package "toolgrant"/);
});

test("config hook: project node_modules is not scanned unless scanNodeModules is true", async () => {
  // Conformant package carrying every component type the plugin can
  // register from node_modules: a skill (which would also become a slash
  // command telling the model to follow the package's instructions), an MCP
  // server, and a dev.opencode agent.
  const pkgDir = join(envRoot, "node_modules", "nmdefault");
  mkdirSync(join(pkgDir, "skills", "sneaky"), { recursive: true });
  writeFileSync(
    join(pkgDir, "skills", "sneaky", "SKILL.md"),
    "---\nname: sneaky\ndescription: planted\n---\n# sneaky\n",
  );
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      $schema: SCHEMA,
      name: "nmdefault",
      extensions: {
        "dev.opencode": {
          agents: {
            rogue: { description: "Planted agent", prompt: "You are planted" },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(pkgDir, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        srv: { type: "streamable-http", url: "https://api.example.com/mcp" },
      },
    }),
  );

  // (a) Default options: the planted package must contribute nothing.
  const off = await runHook({});
  assert.equal(
    off.skills.paths.some((p) => p.includes("nmdefault")),
    false,
    "no skills.paths entry from the planted package",
  );
  assert.equal(off.command?.sneaky, undefined, "no slash command from the planted package");
  assert.equal(off.mcp?.srv, undefined, "no config.mcp entry from the planted package");
  assert.equal(off.agent?.rogue, undefined, "no config.agent entry from the planted package");

  // (b) Opting back in restores collection for the same fixture.
  const on = await runHook({ scanNodeModules: true });
  assert.ok(
    on.skills.paths.some((p) => p.includes("nmdefault")),
    "skills.paths entry restored with scanNodeModules:true",
  );
  assert.equal(
    on.command.sneaky.template.includes('Load the "sneaky" skill'),
    true,
    "slash command restored with scanNodeModules:true",
  );
});

test("config hook: opencode plugin cache is not scanned unless scanCache is true", async () => {
  // Conformant package planted where opencode itself installs npm plugins:
  // {cache}/opencode/packages/{name}@{version}/node_modules/{name}
  const pkgDir = join(
    envRoot,
    ".cache",
    "opencode",
    "packages",
    "cachetest@1.0.0",
    "node_modules",
    "cachetest",
  );
  makePackage(pkgDir, "cachetest", ["cachesneaky"]);

  // (a) Default options: the cached package must contribute nothing.
  const off = await runHook({});
  assert.equal(
    off.skills.paths.some((p) => p.includes("cachetest")),
    false,
    "no skills.paths entry from the planted package",
  );
  assert.equal(
    off.command?.cachesneaky,
    undefined,
    "no slash command from the planted package",
  );

  // (b) Opting back in restores collection for the same fixture.
  const on = await runHook({ scanCache: true });
  assert.ok(
    on.skills.paths.some((p) => p.includes("cachetest")),
    "skills.paths entry restored with scanCache:true",
  );
  assert.equal(
    on.command.cachesneaky.template.includes('Load the "cachesneaky" skill'),
    true,
    "slash command restored with scanCache:true",
  );
});

test("config hook: trusted opencode-cache package registers MCP server and agent without consent", async () => {
  // opencode installs npm plugins into its own cache, so cache packages are
  // host-vouched (trusted). The trust gate must not require consent for them:
  // mcp:true / agents:true alone admit their servers and agents.
  const pkgDir = join(
    envRoot,
    ".cache",
    "opencode",
    "packages",
    "trustedcache@1.0.0",
    "node_modules",
    "trustedcache",
  );
  mkdirSync(join(pkgDir, "skills", "s"), { recursive: true });
  writeFileSync(
    join(pkgDir, "skills", "s", "SKILL.md"),
    "---\nname: s\ndescription: s\n---\n# s\n",
  );
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      $schema: SCHEMA,
      name: "trustedcache",
      extensions: {
        "dev.opencode": {
          agents: {
            reviewer: { description: "Reviews diffs", prompt: "You review code" },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(pkgDir, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        srv: { type: "streamable-http", url: "https://api.example.com/mcp" },
      },
    }),
  );

  const on = await runHook({ scanCache: true, mcp: true, agents: true });
  assert.ok(on.agent.reviewer, "trusted cache package's agent registers without consent");
  assert.equal(on.agent.reviewer.description, "Reviews diffs");
  assert.equal(on.mcp.srv.type, "remote", "trusted cache package's MCP server registers without consent");
  assert.equal(on.mcp.srv.enabled, false, "package-supplied MCP entry still defaults to enabled:false");
});

test("config hook: no plugin-data directory without flags or with an unparseable mcp.json", async () => {
  // FS snapshot: applyConfigPatch's mcp branch is the only code path that
  // creates {state}/opencode/plugin-data/{pkg} (never at plan time), and it
  // runs only when the mcp flag is enabled AND a stdio server was actually
  // planned from a parsed mcp.json.
  const pluginDataRoot = join(envRoot, ".local", "state", "opencode", "plugin-data");

  // Package carrying every component type (skill, agent, valid stdio
  // mcp.json) with both opt-in flags off: nothing may touch plugin-data.
  const pkgDir = join(envRoot, "node_modules", "fssnap");
  mkdirSync(join(pkgDir, "skills", "s"), { recursive: true });
  writeFileSync(
    join(pkgDir, "skills", "s", "SKILL.md"),
    "---\nname: s\ndescription: s\n---\n# s\n",
  );
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      $schema: SCHEMA,
      name: "fssnap",
      extensions: {
        "dev.opencode": {
          agents: {
            reviewer: { description: "Reviews diffs", prompt: "You review code" },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(pkgDir, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { srv: { type: "stdio", command: "npx", args: ["-y", "server"] } },
    }),
  );

  // mcp:false / agents:false (the defaults): package is discovered...
  const off = await runHook({ scanNodeModules: true });
  assert.ok(
    off.skills.paths.some((p) => p.includes("fssnap")),
    "fixture must actually be discovered for the snapshot to be meaningful",
  );
  assert.equal(off.mcp, undefined);
  assert.equal(off.agent, undefined);
  // ...but no {state}/opencode/plugin-data/** path may exist. The root is
  // created recursively by mkdirSync, so its absence implies every child's.
  assert.equal(existsSync(pluginDataRoot), false, "no plugin-data root with flags off");
  assert.equal(
    existsSync(join(pluginDataRoot, "fssnap")),
    false,
    "no per-package plugin-data dir with flags off",
  );

  // Flag enabled but the manifest is unparseable: readMcp bails before any
  // side effect, so still no plugin-data directory.
  rmSync(join(envRoot, "node_modules", "fssnap"), { recursive: true, force: true });
  const badDir = join(envRoot, "node_modules", "fssnap-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(
    join(badDir, "plugin.json"),
    JSON.stringify({ $schema: SCHEMA, name: "fssnap-bad" }),
  );
  writeFileSync(
    join(badDir, "mcp.json"),
    '{"$schema": "' + MCP_SCHEMA_URL + '", "mcpServers": {', // truncated JSON
  );
  await runHook({ scanNodeModules: true, mcp: true });
  assert.equal(existsSync(pluginDataRoot), false, "no plugin-data root for unparseable mcp.json");
});

test("config hook: a corrupt Claude/VS Code manifest cannot abort the merge", async () => {
  // A valid package that must still be registered even though both manifest
  // sources are malformed.
  makePackage(join(envRoot, "node_modules", "survivor"), "survivor", ["alive"]);

  // Corrupt Claude manifest in the home-scoped location collectClaude reads.
  const claudeManifest = join(envRoot, ".claude", "plugins", "installed_plugins.json");
  mkdirSync(dirname(claudeManifest), { recursive: true });
  writeFileSync(claudeManifest, JSON.stringify({ plugins: { a: {} } }));

  // Corrupt VS Code manifest under a built-in home root.
  const vscodeManifest = join(envRoot, ".vscode", "agent-plugins", "installed.json");
  mkdirSync(dirname(vscodeManifest), { recursive: true });
  writeFileSync(vscodeManifest, JSON.stringify({ installed: null }));

  try {
    const cfg = await runHook({ scanNodeModules: true });
    assert.ok(
      cfg.skills.paths.some((p) => p.includes("survivor")),
      "valid package applied despite corrupt manifests",
    );
    assert.equal(
      cfg.command.alive.template.includes('Load the "alive" skill'),
      true,
      "slash command from the valid package still registered",
    );
  } finally {
    rmSync(join(envRoot, ".claude"), { recursive: true, force: true });
    rmSync(join(envRoot, ".vscode"), { recursive: true, force: true });
    rmSync(join(envRoot, "node_modules", "survivor"), { recursive: true, force: true });
  }
});

test("config hook: non-string extraRoots/exclude entries are filtered per-entry", async () => {
  // A malformed option array must not abort the hook: the valid root is still
  // scanned (it would not be reached if path.join saw 42 or null), and a
  // non-string exclude entry is tolerated rather than rejecting the array.
  makePackage(join(envRoot, "ok", "agent-plugins"), "extraok", ["xs"]);
  const cfg = await runHook({
    extraRoots: ["ok", 42, null],
    exclude: [1],
  });
  assert.equal(
    cfg.command.xs.template.includes('Load the "xs" skill'),
    true,
    "valid extra root discovered despite non-string siblings",
  );
  const found = cfg.skills.paths.filter(
    (p) => p.endsWith("skills\\xs") || p.endsWith("skills/xs"),
  );
  assert.equal(found.length, 1, "one skill path from the valid extra root");
});

test("config hook: a flat agent .md is discovered identically on a warm cache, and an edit is picked up on the next run (no staleness)", async () => {
  // Regression test for a real collision: hasRootAgentFiles (a boolean
  // "does this .md carry agent frontmatter" check, run for every directory
  // the walk visits) and readAgents (the full parsed agent, run once per
  // discovered package) both read the *same* flat agent-file layout
  // (engineering/*.md) — the layout this repo's own opencode.jsonc
  // extraRoots scan hits on ~/.claude/remote/plugins. Without namespacing the
  // file cache by which of the two is reading, the second reader would get
  // back the first reader's cached boolean instead of a real parse.
  // Legacy flat-agent layout (no plugin.json) is only found through
  // collectVscode's extraRoots -> {root}/agent-plugins/{name} convention —
  // collectNodeModules only reads conformant (plugin.json) packages, so this
  // has to go through extraRoots to exercise the same code path the real
  // ~/.claude/remote/plugins walk uses on the host that hit this bug.
  const pkgDir = join(envRoot, "extraflat", "agent-plugins", "flatagents");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "cache-regression-reviewer.md"),
    "---\nname: Reviewer\ndescription: Reviews things\n---\nYou review things.",
  );

  const opts = {
    extraRoots: ["extraflat"],
    agents: true,
    consent: { agents: ["flatagents"] },
  };
  const first = await runHook(opts);
  assert.equal(first.agent["cache-regression-reviewer"].description, "Reviews things");
  assert.equal(first.agent["cache-regression-reviewer"].prompt, "You review things.");

  // Second run against the same, unchanged file: must reuse the file cache
  // and still produce the exact same (correct, non-boolean) parsed agent —
  // not the collision bug's leaked `true`.
  const second = await runHook(opts);
  assert.deepEqual(
    second.agent["cache-regression-reviewer"],
    first.agent["cache-regression-reviewer"],
  );

  // Edit the file's content: a cached-but-live source must reflect this on
  // the very next run, with no staleness window.
  writeFileSync(
    join(pkgDir, "cache-regression-reviewer.md"),
    "---\nname: Reviewer\ndescription: Reviews things, now more thoroughly\n---\nYou review things very carefully.",
  );
  const third = await runHook(opts);
  assert.equal(
    third.agent["cache-regression-reviewer"].description,
    "Reviews things, now more thoroughly",
  );
  assert.equal(
    third.agent["cache-regression-reviewer"].prompt,
    "You review things very carefully.",
  );
});

test("config hook: the whole-root discovery cache is populated by a real scan and reflects an added package on the next run", async () => {
  // Integration coverage for discovery-cache.ts's wiring into
  // collectAgentPluginRoot's fallback walk (the same code path
  // collectClaude's remote-plugins walk uses): not just that the cache
  // module is internally correct in isolation, but that a real hook run
  // actually populates and consults it.
  const marketRoot = join(envRoot, "rootcache", "agent-plugins", "onepkg");
  mkdirSync(marketRoot, { recursive: true });
  writeFileSync(
    join(marketRoot, "first.md"),
    "---\nname: First\ndescription: First agent\n---\nBody one.",
  );

  const opts = {
    extraRoots: ["rootcache"],
    agents: true,
    consent: { agents: ["onepkg"] },
  };
  const first = await runHook(opts);
  assert.ok(first.agent["first"], "the fixture package is actually discovered");

  const cacheFile = join(
    envRoot,
    ".cache",
    "opencode-skill-autodiscovery",
    "discovery-root-cache.json",
  );
  assert.ok(existsSync(cacheFile), "a real hook run must populate the whole-root cache file");
  const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
  const entry = Object.values(cached.entries).find(
    (e) => Array.isArray(e.value) && e.value.some((p) => p.name === "onepkg"),
  );
  assert.ok(entry, "the discovered package is recorded under its scanned root");

  // Add a second flat-agent file to the same package root: the subtree
  // fingerprint must change, so the next run picks up the new agent rather
  // than replaying the first run's cached (now stale) package list.
  writeFileSync(
    join(marketRoot, "second.md"),
    "---\nname: Second\ndescription: Second agent\n---\nBody two.",
  );
  const second = await runHook(opts);
  assert.ok(second.agent["first"], "the original agent is still discovered");
  assert.ok(second.agent["second"], "the newly added agent is discovered on the next run");
});
