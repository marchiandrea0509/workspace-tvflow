# Bitget Futures Harness

A local Node.js harness to test **Bitget futures API trading**, starting safely with **demo trading**.

## What this does

- verifies API connectivity
- reads futures account state
- reads open positions
- can set margin mode and leverage
- can place/cancel futures orders
- can execute a JSON signal payload as the base for automation

## Strong recommendation

Start with **demo API keys only**.

Bitget's docs indicate demo trading is supported via API using a **Demo API Key** and the request header **`paptrading: 1`**. This harness defaults to that safe setup.

## Where to paste your keys

Paste them into this file on disk:

`C:\Users\anmar\.openclaw\workspace-tvflow\bitget-futures-harness\.env.local`

Do **not** paste API keys into Discord/chat.

## Key fields in `.env.local`

- `BITGET_API_KEY`
- `BITGET_API_SECRET`
- `BITGET_API_PASSPHRASE`

For demo trading keep:

- `BITGET_ENV=demo`
- `BITGET_PAPTRADING=1`
- `BITGET_ALLOW_ORDER_PLACEMENT=false` initially
- `BITGET_ALLOW_LIVE_TRADING=false`

## First tests

Open a terminal in:

`C:\Users\anmar\.openclaw\workspace-tvflow\bitget-futures-harness`

Then run:

```powershell
node scripts/account.js
node scripts/positions.js
```

If those work, you have authenticated connectivity.

## Safe order workflow

1. Keep `.env.local` on demo keys.
2. Review the example signal at `examples\open-long.market.json`.
3. Dry-run it first:

```powershell
node scripts/execute-signal.js --signal examples/open-long.market.json
```

4. Only when ready, enable sending in `.env.local`:

```text
BITGET_ALLOW_ORDER_PLACEMENT=true
```

5. Then send the order:

```powershell
node scripts/execute-signal.js --signal examples/open-long.market.json --send
```

## Live-trading safety

The harness refuses live order placement unless **both** are true:

- `BITGET_ENV=live`
- `BITGET_ALLOW_LIVE_TRADING=true`

That prevents accidental live execution if demo/live keys are mixed up.

## Core commands

### Account

```powershell
node scripts/account.js
```

### Positions

```powershell
node scripts/positions.js
```

### Set margin mode

```powershell
node scripts/set-margin-mode.js --symbol BTCUSDT --marginMode isolated
```

### Set leverage

```powershell
node scripts/set-leverage.js --symbol BTCUSDT --leverage 3
```

### Place one order directly

```powershell
node scripts/place-order.js --symbol BTCUSDT --side buy --tradeSide open --orderType market --size 0.001 --send
```

### Cancel one order

```powershell
node scripts/cancel-order.js --symbol BTCUSDT --orderId YOUR_ORDER_ID
```

## Signal format

Example signal file:

```json
{
  "symbol": "BTCUSDT",
  "productType": "USDT-FUTURES",
  "marginCoin": "USDT",
  "marginMode": "isolated",
  "leverage": "3",
  "side": "buy",
  "tradeSide": "open",
  "orderType": "market",
  "size": "0.001"
}
```

## Notes

- This harness is intentionally minimal and explicit.
- It is a good base for the next step: receiving TradingView/Pine webhooks or routing screener outputs into execution rules.
- If you want, I can extend this next into a webhook receiver + rule engine for specific Pine signals.
