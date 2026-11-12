# @wonderhate/lrhelper

MCP server bridging Claude / Codex / Cursor to Adobe Lightroom Classic via a bundled Lua plugin.

The preset round-trip tools can inspect and compare historical Develop presets, create versioned plugin-managed checkpoints from an edited representative photo, and export a preset backing file without overwriting an existing file. Plugin checkpoints are hidden from Lightroom's Develop panel by Adobe SDK design.

## Install

For the Windows installer, see the [LRhelper releases](https://github.com/wonderhate/LRhelper/releases/latest).

To use the MCP bridge directly, run the following from the repository root with Node.js 20 or later:

```bash
npm --prefix server ci
node server/dist/index.js install-plugin
```

Restart Lightroom Classic after installing the plugin.

### Codex CLI

```bash
codex mcp add lightroom -- node /absolute/path/to/LRhelper/server/dist/index.js
```

### Cursor / Windsurf / VS Code

Add the server to your MCP configuration, using the absolute path to your checkout:

```json
{
  "mcpServers": {
    "lightroom": {
      "command": "node",
      "args": ["/absolute/path/to/LRhelper/server/dist/index.js"]
    }
  }
}
```

## Commands

```
lightroom-mcp [stdio]            Run MCP over stdio (default)
lightroom-mcp install-plugin     Copy plugin into Lightroom Modules folder
```

## Docs and source

Full documentation, architecture notes, and the Lightroom plugin live at
<https://github.com/wonderhate/LRhelper>. The bridge is based on
[Automaat/lightroom-mcp](https://github.com/Automaat/lightroom-mcp).

## License

MIT
