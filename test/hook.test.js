import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(cfg.command.s1.template.includes("Load the `s1` skill"), true);
  assert.equal(cfg.mcp, undefined);
});

test("config hook: registers MCP only when the mcp option is enabled", async () => {
  makePackage(join(envRoot, "node_modules", "dotest2"), "dotest2", ["s"], {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      srv: { type: "streamable-http", url: "https://api.example.com/mcp" },
    },
  });
  const off = await runHook({ scanNodeModules: true });
  assert.equal(off.mcp, undefined);
  const on = await runHook({ scanNodeModules: true, mcp: true });
  assert.equal(on.mcp.srv.type, "remote");
  assert.equal(on.mcp.srv.url, "https://api.example.com/mcp");
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

test("config hook: registers agents only when the agents option is enabled", async () => {
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
  const on = await runHook({ scanNodeModules: true, agents: true });
  assert.ok(on.agent.reviewer, "agent registered when agents:true");
  assert.equal(on.agent.reviewer.description, "Reviews diffs");
  assert.equal(on.agent.reviewer.permission, undefined, "permission stripped");
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
    on.command.sneaky.template.includes("Load the `sneaky` skill"),
    true,
    "slash command restored with scanNodeModules:true",
  );
});
