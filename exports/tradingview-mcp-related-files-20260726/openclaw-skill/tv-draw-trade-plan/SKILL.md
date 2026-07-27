---
name: tv-draw-trade-plan
description: Draw TradingView Desktop MCP visual trade plans or ladders for BITGET symbols. Use when the user asks to draw, visualize, mark up, or render a trade plan, live order plan, Entry/SL/TP levels, or ladder on the active TradingView Desktop chart using C:\Users\anmar\tools\tv_draw_trade_plan.ps1.
---

# TradingView MCP Trade Plan Drawing

Use this skill to draw Entry / SL / TP line segments on the active TradingView Desktop chart. This is visual-only chart markup and must not be treated as order execution.

## Guardrails

- Do not place, cancel, or modify exchange orders with this skill.
- Use only when the user requests a visual drawing/markup or when a BITGET live order/trade-plan workflow should be accompanied by chart visualization.
- If any order price, side, symbol, timeframe, SL, or TP is ambiguous, ask before drawing.
- Use only TradingView Desktop MCP on port `9222`; do not attempt browser/Chrome TradingView drawing.

## MCP readiness check

Before writing the plan or running the drawing script, check whether TradingView Desktop MCP is active:

```powershell
curl.exe http://127.0.0.1:9222/json/version
```

- If the response contains `webSocketDebuggerUrl`, TradingView Desktop MCP is ready; continue.
- If port `9222` is not reachable, do not fail immediately. Start TradingView Desktop with:

```powershell
C:\Users\anmar\tools\start-tv-debug-detached.cmd
```

Then wait 8-12 seconds and check again:

```powershell
curl.exe http://127.0.0.1:9222/json/version
```

- If the second response contains `webSocketDebuggerUrl`, continue.
- If TradingView still cannot be reached, stop and tell the user exactly:

```text
TradingView Desktop MCP is not reachable on port 9222. Please check whether TradingView Desktop opened correctly.
```

## Workflow

1. Create the temporary JSON plan file here:

```text
C:\Users\anmar\tools\trade_plan_from_oc.json
```

2. Use this JSON shape:

```json
{
  "symbol": "BITGET:GOOGLUSDT.P",
  "timeframe": "4H",
  "side": "long",
  "length_bars": 4,
  "arrow": {
    "enabled": true,
    "length_bars": 2,
    "mode": "single"
  },
  "orders": [
    {
      "name": "Order 1",
      "entry": 385.12,
      "sl": 350.00,
      "tp": 391.91,
      "order_time": "2026-06-02T06:45:00Z",
      "arrow_price": 382.40,
      "kind": "live",
      "lineStyle": "solid"
    }
  ],
  "style": {
    "entry": {
      "color": "#FFD700",
      "width": 3
    },
    "sl": {
      "color": "#FF3333",
      "width": 3
    },
    "tp": {
      "color": "#00CC66",
      "width": 3
    },
    "arrow": {
      "color": "#FFFFFF",
      "width": 2,
      "shape": "arrow"
    }
  }
}
```

3. For ladder plans, include one object per order. The script shifts each order one candle to the right. Use `kind="live"` / `lineStyle="solid"` for real exchange orders and `kind="virtual"` / `lineStyle="dashed"` for alert-only or conditional virtual plans. The script also auto-dashes orders whose `kind`, `status`, or `mode` contains `virtual`, `alert`, `watch`, or `conditional`.

4. For post-live trade drawings, include `order_time` on each order when available. Acceptable aliases are `order_time`, `live_order_time`, `placed_at`, `placedAt`, or `timestamp`; values may be ISO timestamps or Unix seconds/milliseconds. The white arrow is a placement/current-price marker, not an entry marker: include `arrow_price`, `current_price`, or `placement_price` from the live order-placement moment, and the arrow tip will be drawn at that time and price. Use `arrow.mode="single"` for ladder/trade-group drawings so only one white right-pointing horizontal placement arrow is drawn at the first/top-level order time/price. Use `arrow.mode="per_order"` only when the user explicitly wants one arrow per ladder leg. Default arrow length is `2` x chart candles (on 4H this is 8 hours). If no placement/current price is provided, the script falls back to entry price for backward compatibility; future live drawings should provide `arrow_price` explicitly.

5. Run:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\anmar\tools\tv_draw_trade_plan.ps1" -PlanPath "C:\Users\anmar\tools\trade_plan_from_oc.json"
```

## Defaults

- Symbol format: `BITGET:<SYMBOL>USDT.P` unless the user specifies otherwise.
- Timeframe: use the plan timeframe; default to `4H` only when clearly implied by the current TradingView/BITGET workflow.
- Side: `long` or `short` exactly as the trade plan says.
- `length_bars`: default `4` unless the user requests another duration.
- Entry color: yellow `#FFD700`, width `3`.
- SL color: red `#FF3333`, width `3`.
- TP color: green `#00CC66`, width `3`.
- Placement arrow: enabled by default, white `#FFFFFF`, width `2`, shape `arrow`, length `2` candles. For live ladder drawings prefer `arrow.mode="single"` (one group arrow) and provide `arrow_price` / `current_price` / `placement_price` at the live order-placement moment. Use `arrow.mode="per_order"` only when explicitly requested. Set top-level `arrow.enabled=false` to disable it for a plan.
- Line style convention: real/live exchange orders use solid lines; virtual/alert-only/conditional plans use dashed lines. Set `lineStyle="solid"`, `lineStyle="dashed"`, or `lineStyle="dotted"` per order when needed.

## Verification

After running, confirm:

- symbol
- timeframe
- number of orders drawn
- each order's Entry / SL / TP values
- real/live orders are solid; virtual/alert-only orders are dashed when requested
- for post-live drawings, the single/group white placement arrow tip is at the first/top-level order time and placement/current price unless `arrow.mode="per_order"` was explicitly requested
- whether the script returned success
