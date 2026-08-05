# opencode-skill-autodiscovery

An [opencode](https://opencode.ai) plugin that auto-discovers skills installed by
VS Code agent plugins and Claude Code plugins on the current machine, and
registers them with opencode's `skills.paths` so they appear in every session.
Each discovered skill is also exposed as a `/skill-name` slash command that
loads the skill and routes the rest of your message through it.

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

Each points at plugin directories that contain `SKILL.md` files. This plugin
reads the manifests (including the remote `cache.json` LRU), resolves each
entry to its on-disk skill directories, and registers them with opencode.

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
frontmatter; existing commands with the same name are left untouched.

## Install

Add the package name to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-skill-autodiscovery"]
}
```

Use the tuple form to add extra root directories to scan (e.g. a non-standard
VS Code data location on a remote host):

```json
{
  "plugin": [
    [
      "opencode-skill-autodiscovery",
      { "extraRoots": ["/home/user/.vscode-server"] }
    ]
  ]
}
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
- The plugin is a no-op when no VS Code or Claude plugin manifests exist, or
  when they contain no skills.

## Development

```sh
npm install
npm run build   # tsc -> dist/
```

Publish:

```sh
npm publish --access public
```
