# Local TradingView MCP modifications

The bundled `tradingview-mcp` source comes from:

`https://github.com/tradesdontlie/tradingview-mcp.git`

The exported source intentionally includes the locally verified changes used by the live-order drawing workflow:

- `src/core/drawing.js`: `listDrawings`, `getProperties`, `removeOne`, and `clearAll` resolve injected/default chart dependencies correctly.
- `package-lock.json`: records the `tv` CLI binary from `package.json`.

`node_modules` and `.git` are excluded. Run `INSTALL.ps1` or `npm ci` inside `tradingview\tradingview-mcp`.
