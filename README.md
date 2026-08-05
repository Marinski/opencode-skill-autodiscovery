# opencode-skill-autodiscovery

An [opencode](https://opencode.ai) plugin that auto-discovers skills installed by
VS Code agent plugins and Claude Code plugins on the current machine, and
registers them with opencode's `skills.paths` so they appear in every session.

## Why

Skills live in different places depending on the tool that installed them:

- VS Code agent plugins: `~/.vscode/agent-plugins/installed.json`
- VS Code agent plugins on a remote host (Remote-SSH, Codespaces, Dev
  Containers): `~/.vscode-server/agent-plugins/installed.json`,
  `~/.vscode-server-insiders/...`, or `~/.vscode-remote/...`
- Claude Code plugins: `~/.claude/plugins/installed_plugins.json`

Each points at plugin directories that contain `SKILL.md` files. This plugin
walks those manifests, finds every skill directory, and adds them to the
opencode config.

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
- VS Code account sync only syncs your marketplace extension list; each machine
  still has its own `installed.json` that this plugin reads.
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
