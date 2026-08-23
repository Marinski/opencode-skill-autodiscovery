# opencode-skill-autodiscovery

An [opencode](https://opencode.ai) plugin that auto-discovers skills installed by
VS Code agent plugins, Claude Code plugins, and [Agent Plugins
1.0.0](https://agent-plugins.org) conformant packages on the current machine,
and registers them with opencode's `skills.paths` so they appear in every
session. Each discovered skill is also exposed as a `/skill-name` slash command
that loads the skill and routes the rest of your message through it.

## Why

Skills live in different places depending on the tool, OS, and local vs remote
setup:

- VS Code agent plugins, local client: `~/.vscode/agent-plugins` (Windows /
  older builds), `~/.config/Code/agentPlugins` (Linux),
  `~/Library/Application Support/Code/agentPlugins` (macOS), and
  `%APPDATA%\Code\agentPlugins` (Windows), plus `Code - Insiders` variants.
  The install layout is `{host}/{org}/{repo}`, with optional `installed.json`
  and `cache.json` manifests alongside.
- VS Code agent plugins on a remote host (Remote-SSH, Codespaces, Dev
  Containers, WSL): `~/.vscode-server/data/agentPlugins`. VS Code syncs the
  enabled skills from your local client into a synthetic "VS Code Synced
  Data" plugin materialized at
  `~/.vscode-server/data/agentPlugins/{sanitizedUri}/{nonce}/skills/...`, and
  records each synced bundle in `~/.vscode-server/data/agentPlugins/cache.json`.
- Claude Code plugins: `~/.claude/plugins/installed_plugins.json`
- Claude Code plugins on a remote host (SSH/remote sessions):
  `~/.claude/remote/plugins/installed_plugins.json`
- **Agent Plugins 1.0.0 packages** distributed via npm. opencode installs npm
  plugins into its own cache (`~/.cache/opencode/packages/...`), not the
  project's `node_modules`, and a `skills.paths` entry relative to the project
  dir silently resolves to nothing. This plugin scans both the opencode plugin
  cache and the project's `node_modules` for packages carrying a root
  `plugin.json` whose `$schema` is `https://agent-plugins.org/schemas/...`,
  and registers their `skills/` with **absolute** paths — so an npm-distributed
  Agent Plugins package (e.g. `@dodopayments/opencode-plugin`) just works with
  `"plugin": ["opencode-skill-autodiscovery"]` and nothing else.

Each points at plugin directories that contain `SKILL.md` files. This plugin
reads the manifests (including the remote `cache.json` LRU), resolves each
entry to its on-disk skill directories, and registers them with opencode.
When a discovered package carries a conformant root `plugin.json`, that manifest
is preferred (its `skills/` children are registered as-is); otherwise the plugin
falls back to a tree walk so legacy layouts keep working.

### MCP servers (opt-in)

With the `mcp` option, the plugin also reads each discovered package's `mcp.json`
and maps it onto opencode's `config.mcp`:

| Agent Plugins server | opencode entry |
|---|---|
| `{ "type": "stdio", "command", "args", "env" }` | `{ "type": "local", "command": [...], "environment": {...} }` |
| `{ "type": "streamable-http", "url" }` | `{ "type": "remote", "url" }` |
| `{ "type": "sse" }` | skipped (opencode has no SSE transport) |

`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` placeholders are expanded in `args`/`env`,
and both variables are injected into each stdio server's environment
(`PLUGIN_DATA` points at
`{opencode state}/plugin-data/{packageName}`). Invalid entries are skipped
per-entry, never fatally. `sse` servers and stdio `cwd` (which opencode cannot
represent) are dropped with a log line.

### Agents (opt-in)

Agent Plugins 1.0.0 has no portable "agents" component type (only skills and
MCP servers), so agents are contributed through the spec's client-extension
mechanism. With the `agents` option, the plugin reads agents from four
sources, in order:

1. `plugin.json` → `extensions["dev.opencode"].agents` (a map of agent name →
   opencode `agent` config).
2. A `dev.opencode/agents/<name>.json` extension directory (one opencode agent
   config per file).
3. A legacy Claude Code plugin shim: `.claude-plugin/plugin.json` `agents`,
   mapping `description` and `systemPrompt` (or the `agents/<name>/AGENTS.md`
   body) onto an opencode agent.
4. Flat `agents/<name>.md` files (the agency-agents layout) — one agent per
   file, keyed by filename, with `description`/`color` from frontmatter and the
   markdown body as the prompt.

Agents discovered without an explicit `mode` default to opencode's `all`, so
they are both Tab-selectable and spawnable as subagents.

Discovered agents are registered as `config.agent.<name>` with the same rules
as commands: user-defined agents are never overwritten, same-source mirrors are
collapsed, and cross-source collisions become `<package>-<agent>`.

**Trust note:** a package-supplied `permission` block is always dropped — agent
permissions are too powerful to inherit from a package by default. If you need
one, define the agent yourself in `opencode.json` (which always wins).

### Slash commands

opencode treats skills and slash commands as separate mechanisms: skills are
only loaded on demand via the `skill` tool. To make a discovered skill
invocable as `/name`, the plugin also registers a command for it (via
`config.command`) whose template loads the skill and forwards your arguments:

```markdown
Load the `spec` skill and follow its instructions.
Context: $ARGUMENTS
```

So `/spec plan the migration` loads the `spec` skill and runs it against
`plan the migration`. The command's description is taken from the skill's
frontmatter; existing commands with the same name are never overwritten (a
colliding skill from a different source is registered as `/package-skill`).

## Install

Add the package name to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-skill-autodiscovery"]
}
```

Use the tuple form to configure options:

```json
{
  "plugin": [
    [
      "opencode-skill-autodiscovery",
      {
        "extraRoots": ["/home/user/.vscode-server"],
        "scanCache": true,
        "scanNodeModules": true,
        "mcp": false,
        "agents": false
      }
    ]
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `extraRoots` | `[]` | Extra root directories to scan (e.g. a non-standard VS Code data location on a remote host). |
| `scanCache` | `true` | Scan opencode's plugin cache (`~/.cache/opencode/packages/*`) for Agent Plugins packages. |
| `scanNodeModules` | `false` | Scan the project's `node_modules` (incl. `@scope/*`) for Agent Plugins packages. |
| `mcp` | `false` | Also register MCP servers from discovered packages' `mcp.json`. |
| `agents` | `false` | Also register agents from packages (see "Agents" above). |

## VPS / remote hosts (SSH sessions)

Discovery is **machine-local**: a remote session only sees the skills, agents,
and packages installed **on that host**. So opencode (and this plugin) must be
installed on each remote machine, and you run opencode inside the SSH session —
not from a local client terminal.

**On each remote host:**

```sh
# 1. Install opencode if it isn't there yet
npm install -g opencode-ai

# 2. Install this plugin globally. The -g flag targets the machine-wide config;
#    without it, opencode writes a project-scoped .opencode/opencode.json
#    instead (easy to miss, because the plugin looks installed but only for
#    that one directory).
opencode plugin opencode-skill-autodiscovery -g

# 3. Restart opencode. It fetches the latest published version into the
#    remote's own cache.
```

Or hand-edit the remote's global config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": [["opencode-skill-autodiscovery", { "mcp": true, "agents": true }]]
}
```

**What a remote session discovers** (that host's own installs):
- VS Code Remote-SSH synced skills from `~/.vscode-server/data/agentPlugins/`
  (read via the `cache.json` LRU).
- Claude Code remote plugins from `~/.claude/remote/plugins/`.
- Agent Plugins packages in the remote's opencode cache
  (`~/.cache/opencode/packages/*`) and the project's `node_modules`.

**Caveats:**
- Run opencode **on the remote**. A local client terminal reads the local
  machine's manifests, not the remote's.
- VS Code only syncs **enabled** skills to the server as a flattened "VS Code
  Synced Data" bundle; marketplace clones (including their `agents/*.md`
  files) are generally not copied. Install the pack on the remote too if you
  want its agents there.
- To force a re-fetch of a new release on a remote, clear the cached copy and
  restart (opencode re-downloads the latest):
  ```sh
  rm -rf ~/.cache/opencode/packages/opencode-skill-autodiscovery*
  ```

## Notes

- Discovery is inherently **machine-local**: it reads manifests from the home
  directory of the machine opencode is running on. Remote sessions on a
  different machine will discover that machine's skills.
- On a remote host, VS Code does **not** copy your marketplace plugins over.
  It syncs only the enabled skills/agents/etc. from your client as a single
  flattened "VS Code Synced Data" bundle under
  `~/.vscode-server/data/agentPlugins/`. That is why you won't see the
  original `{org}/{repo}` layout on the remote — the skill directories are
  named after the skills instead. This plugin reads `cache.json` to locate
  those materialized bundles.
- Newer VS Code layouts have no `installed.json` at all; marketplaces are
  cloned directly under the agent plugin dir. The plugin falls back to a tree
  walk only when no manifest is present, so it never surfaces skills from
  cloned-but-uninstalled marketplaces on setups that do have a manifest.
- VS Code account sync only syncs your marketplace extension list; each machine
  still has its own `installed.json`/`cache.json` that this plugin reads.
- A package is only treated as an Agent Plugins package when its root
  `plugin.json` declares a `$schema` under `https://agent-plugins.org/schemas/`.
  Everything else is ignored by the cache/node_modules scanners and falls back
  to the tree walk elsewhere. This check identifies format only — never
  provenance or safety: any package can copy the literal schema URL, so a
  conformant manifest does not make scanning an untrusted directory safe.
  Content is trusted based on where it came from (host-installed manifests vs.
  side-effect locations), not on its shape.
- The same plugin can be materialised in several VS Code layouts at once
  (local clone + synced bundle + marketplace clone). `skills.paths` keeps all
  paths; slash commands and MCP servers are de-duplicated so mirrors don't
  create a wall of `/mirror-of-...` junk.
- The plugin is a no-op when no manifests or conformant packages exist, or when
  they contain no skills.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # build + node --test (fixture-based unit tests)
```

Publish:

```sh
npm publish --access public
```
