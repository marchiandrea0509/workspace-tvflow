#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = ROOT.parent
TRADINGVIEW_ROOT = WORKSPACE_ROOT / 'tradingview'
REPORTS_DIR = TRADINGVIEW_ROOT / 'reports' / 'pine_screener'
CAPTURE_JS = TRADINGVIEW_ROOT / 'scripts' / 'capture_live.js'
PROMPT_DEFAULT = ROOT / 'prompts' / 'bitget_single_market_deep_dive_prompt.md'
STRUCTURE_URL = 'https://www.tradingview.com/chart/0ZPSKaZ4/'
FLOW_URL = 'https://www.tradingview.com/chart/FTMP9zKR/'
OUT_DIR = ROOT / 'reports' / 'bitget_llm_packets'
BITGET_BASE = 'https://api.bitget.com'


def latest_report_json() -> Path:
    files = sorted(REPORTS_DIR.glob('pine_screener_*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        raise SystemExit(f'No pine screener JSON reports found in {REPORTS_DIR}')
    return files[0]


def load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def pick_row(report: dict, symbol: str | None) -> dict:
    top5 = report.get('top5') or []
    if symbol:
        wanted = symbol.upper()
        for row in top5:
            if str(row.get('symbol') or '').upper() == wanted:
                return row
        raise SystemExit(f'Symbol {wanted} not found in report top5.')
    if not top5:
        raise SystemExit('Report has no top5 rows.')
    return top5[0]


def to_api_symbol(symbol: str) -> str:
    return str(symbol).replace('.P', '').upper()


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={'User-Agent': 'OpenClaw/bitget-packet-builder'})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode('utf-8'))
    if payload.get('code') not in (None, '00000'):
        raise RuntimeError(f"Bitget error {payload.get('code')}: {payload.get('msg')}")
    return payload


def fetch_candles(api_symbol: str, granularity: str, limit: int) -> list[list[str]]:
    params = urllib.parse.urlencode({
        'symbol': api_symbol,
        'productType': 'USDT-FUTURES',
        'granularity': granularity,
        'limit': limit,
    })
    url = f'{BITGET_BASE}/api/v2/mix/market/candles?{params}'
    payload = fetch_json(url)
    rows = payload.get('data') or []
    return sorted(rows, key=lambda row: int(row[0]))


def write_ohlcv_csv(path: Path, rows: list[list[str]], symbol: str, timeframe: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow([
            'symbol', 'timeframe', 'open_time_ms', 'open_time_utc', 'open', 'high', 'low', 'close', 'base_volume', 'quote_volume'
        ])
        for row in rows:
            ts = int(row[0])
            writer.writerow([
                symbol,
                timeframe,
                row[0],
                datetime.utcfromtimestamp(ts / 1000).isoformat() + 'Z',
                row[1], row[2], row[3], row[4], row[5], row[6],
            ])
    return path


def run_capture(symbol: str, timeframe: str, layout: str, chart_url: str, outdir: Path, log_path: Path, panel_shot: bool = False) -> str | None:
    cmd = [
        'node', str(CAPTURE_JS),
        '--symbol', symbol,
        '--timeframe', timeframe,
        '--layout', layout,
        '--chartUrl', chart_url,
        '--preset', 'deep',
        '--panelShot', 'true' if panel_shot else 'false',
        '--outdir', str(outdir),
        '--log', str(log_path),
    ]
    try:
        subprocess.run(cmd, check=True, cwd=WORKSPACE_ROOT)
    except Exception:
        return None
    suffix = '_panels.png' if panel_shot else '.png'
    candidate = outdir / f'{symbol}_{timeframe}_{layout}{suffix}'
    return str(candidate) if candidate.exists() else None


def style_from_row(raw: dict) -> str:
    winner_dir = str(raw.get('48 Winner Dir') or '').strip()
    family = str(raw.get('49 Winner Family Code') or '').strip()
    if winner_dir == '1' and family == '2':
        return 'BREAKOUT'
    if winner_dir == '-1' and family == '2':
        return 'SELL_RALLY'
    if winner_dir == '1' and family == '1':
        return 'DIP_LADDER'
    if winner_dir == '-1' and family == '1':
        return 'SELL_RALLY'
    return 'AUTO'


def direction_from_row(raw: dict) -> str:
    winner_dir = str(raw.get('48 Winner Dir') or '').strip()
    if winner_dir == '1':
        return 'LONG'
    if winner_dir == '-1':
        return 'SHORT'
    return 'AUTO'


def main() -> int:
    parser = argparse.ArgumentParser(description='Build a Bitget OHLCV-first deep-analysis packet from the latest Pine screener winner.')
    parser.add_argument('--report-json', help='Optional explicit pine screener JSON report path')
    parser.add_argument('--symbol', help='Optional explicit screener symbol like NVDAUSDT.P')
    parser.add_argument('--risk-usdt', type=float, default=100.0)
    parser.add_argument('--max-margin', type=float, default=1500.0)
    parser.add_argument('--timezone', default='Europe/Berlin')
    parser.add_argument('--limit-4h', type=int, default=200)
    parser.add_argument('--limit-1d', type=int, default=200)
    args = parser.parse_args()

    report_path = Path(args.report_json) if args.report_json else latest_report_json()
    report = load_report(report_path)
    row = pick_row(report, args.symbol)
    raw = row.get('raw') or {}
    symbol = str(row.get('symbol'))
    api_symbol = to_api_symbol(symbol)

    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    packet_dir = OUT_DIR / stamp
    packet_dir.mkdir(parents=True, exist_ok=True)
    log_path = packet_dir / 'capture.log'

    ohlcv_4h_rows = fetch_candles(api_symbol, '4H', args.limit_4h)
    ohlcv_1d_rows = fetch_candles(api_symbol, '1D', args.limit_1d)
    ohlcv_4h_path = write_ohlcv_csv(packet_dir / f'{symbol}_4H_bitget_ohlcv.csv', ohlcv_4h_rows, symbol, '4H')
    ohlcv_1d_path = write_ohlcv_csv(packet_dir / f'{symbol}_1D_bitget_ohlcv.csv', ohlcv_1d_rows, symbol, '1D')

    shot_4h = run_capture(symbol, '4H', 'Openclaw-structure', STRUCTURE_URL, packet_dir, log_path, panel_shot=False)
    shot_1d = run_capture(symbol, '1D', 'Openclaw-structure', STRUCTURE_URL, packet_dir, log_path, panel_shot=False)
    flow_4h = run_capture(symbol, '4H', 'Openclaw-flow', FLOW_URL, packet_dir, log_path, panel_shot=True)

    packet_path = packet_dir / f'bitget_llm_packet_{symbol.replace('.', '_')}.md'
    packet = f'''# Bitget LLM Deep Analysis Packet (OHLCV-first)

- Generated: {datetime.now().isoformat()}
- Prompt: {PROMPT_DEFAULT}
- Screener report: {report_path}
- Symbol: {symbol}
- Exchange: BITGET
- Product: USDT perpetual futures
- OHLCV truth source: Bitget REST API
- 4H OHLCV CSV: {ohlcv_4h_path}
- 1D OHLCV CSV: {ohlcv_1d_path}
- Dashboard screenshot: {report.get('screenshotPath')}
- 4H chart screenshot (optional validation): {shot_4h}
- 1D chart screenshot (optional validation): {shot_1d}
- 4H flow screenshot (optional validation): {flow_4h}
- Capture log: {log_path}

## Filled inputs
- Timezone: {args.timezone}
- Horizon: next 5 trading days
- Direction bias: {direction_from_row(raw)}
- Preferred execution style: {style_from_row(raw)}
- Risk Budget $: {args.risk_usdt}
- Max total margin implication: {args.max_margin}
- 4H lookback bars: {len(ohlcv_4h_rows)}
- 1D lookback bars: {len(ohlcv_1d_rows)}

## Screener row
- Best Setup Code: {raw.get('02 Best Setup Code')}
- Best Score: {raw.get('03 Best Score')}
- Final Long Score: {raw.get('04 Final Long Score')}
- Final Short Score: {raw.get('05 Final Short Score')}
- Conviction State: {raw.get('10 Conviction State')}
- Trend Dir: {raw.get('11 Trend Dir')}
- Macro Dir 1D: {raw.get('12 Macro Dir 1D')}
- Verdict State: {raw.get('27 Verdict State')}
- Signed Conviction: {raw.get('29 Signed Conviction')}
- Winner Dir: {raw.get('48 Winner Dir')}
- Winner Family Code: {raw.get('49 Winner Family Code')}
- Winner Margin: {raw.get('50 Winner Margin')}
- Winner Base Score: {raw.get('51 Winner Base Score')}
- Winner Penalty: {raw.get('52 Winner Penalty')}
- Winner Tactical: {raw.get('53 Winner Tactical')}
- Winner Macro: {raw.get('54 Winner Macro')}
- Winner Structure: {raw.get('55 Winner Structure')}
- Winner ADX Fit: {raw.get('56 Winner ADX Fit')}
- Winner Lifecycle: {raw.get('57 Winner Lifecycle')}
- Winner Context Boost: {raw.get('58 Winner Context Boost')}
- Winner Family Edge: {raw.get('59 Winner Family Edge')}
'''
    packet_path.write_text(packet, encoding='utf-8')

    print(json.dumps({
        'prompt': str(PROMPT_DEFAULT),
        'packet': str(packet_path),
        'symbol': symbol,
        'ohlcv_4h': str(ohlcv_4h_path),
        'ohlcv_1d': str(ohlcv_1d_path),
        'dashboard_screenshot': report.get('screenshotPath'),
        'shot_4h': shot_4h,
        'shot_1d': shot_1d,
        'flow_4h': flow_4h,
        'log': str(log_path),
    }, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
