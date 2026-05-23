const { BitgetClient, getDefaultTradingConfig } = require('../lib/bitgetClient');
const { parseArgs } = require('../lib/cli');

function parseSymbols(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sideDepth(levels, ref, pct, side) {
  const limit = side === 'bid' ? ref * (1 - pct / 100) : ref * (1 + pct / 100);
  let base = 0;
  let quote = 0;
  for (const row of levels || []) {
    const price = num(row[0]);
    const qty = num(row[1]);
    if (!price || !qty) continue;
    if (side === 'bid' && price < limit) continue;
    if (side === 'ask' && price > limit) continue;
    base += qty;
    quote += price * qty;
  }
  return { base, quote };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getDefaultTradingConfig();
  const productType = args.productType || cfg.productType;
  const symbols = parseSymbols(args.symbols || args.symbol || cfg.defaultSymbol);
  const limit = args.limit || '50';
  const client = new BitgetClient();
  const rows = [];

  for (const symbol of symbols) {
    const row = { symbol, productType, ok: false, capturedAt: new Date().toISOString() };
    try {
      const tickerResp = await client.request('GET', '/api/v2/mix/market/ticker', {
        query: { symbol, productType },
        auth: false,
      });
      const ticker = Array.isArray(tickerResp?.data) ? tickerResp.data[0] : tickerResp?.data || {};
      const depthResp = await client.request('GET', '/api/v2/mix/market/orderbook', {
        query: { symbol, productType, limit },
        auth: false,
      });
      const depth = depthResp?.data || {};
      const bid = num(ticker.bidPr || ticker.bidPrice);
      const ask = num(ticker.askPr || ticker.askPrice);
      const last = num(ticker.lastPr || ticker.last);
      const mark = num(ticker.markPrice || ticker.markPr);
      const ref = mark || last || ((bid && ask) ? (bid + ask) / 2 : 0);
      const spread = bid && ask ? ask - bid : 0;
      const bids = depth.bids || [];
      const asks = depth.asks || [];
      const d05b = sideDepth(bids, ref, 0.5, 'bid');
      const d05a = sideDepth(asks, ref, 0.5, 'ask');
      const d1b = sideDepth(bids, ref, 1.0, 'bid');
      const d1a = sideDepth(asks, ref, 1.0, 'ask');
      const d2b = sideDepth(bids, ref, 2.0, 'bid');
      const d2a = sideDepth(asks, ref, 2.0, 'ask');
      Object.assign(row, {
        ok: true,
        requestTime: tickerResp?.requestTime || depthResp?.requestTime,
        last,
        mark,
        bid,
        ask,
        spread,
        spreadBps: ref ? (spread / ref) * 10000 : 0,
        high24h: num(ticker.high24h),
        low24h: num(ticker.low24h),
        change24h: num(ticker.change24h),
        baseVolume24h: num(ticker.baseVolume),
        quoteVolume24h: num(ticker.quoteVolume || ticker.usdtVolume),
        holdingAmount: num(ticker.holdingAmount),
        depthLimit: limit,
        bidDepth05Base: d05b.base,
        bidDepth05Quote: d05b.quote,
        askDepth05Base: d05a.base,
        askDepth05Quote: d05a.quote,
        bidDepth1Base: d1b.base,
        bidDepth1Quote: d1b.quote,
        askDepth1Base: d1a.base,
        askDepth1Quote: d1a.quote,
        bidDepth2Base: d2b.base,
        bidDepth2Quote: d2b.quote,
        askDepth2Base: d2a.base,
        askDepth2Quote: d2a.quote,
        rawTicker: ticker,
      });
    } catch (err) {
      row.error = err.message || String(err);
    }
    rows.push(row);
  }

  console.log(JSON.stringify({
    ok: rows.every((r) => r.ok),
    generatedAt: new Date().toISOString(),
    productType,
    symbols,
    rows,
  }, null, 2));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
