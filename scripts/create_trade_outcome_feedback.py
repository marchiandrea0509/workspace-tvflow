#!/usr/bin/env python3
"""Create an outcome-first trade feedback record.

This does not place, cancel, or modify orders. It only freezes the initial thesis
and links evidence so later audits can compare the thesis against Bitget and
TradingView outcomes.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATUS_CHOICES = [
    "pretrade_frozen",
    "waiting_for_fill",
    "waiting_for_close_or_expiry",
    "manual_audit_requested",
    "ready_for_outcome_audit",
    "audited",
    "patched",
    "archived_no_lesson",
]


def read_text(path: str | None) -> str:
    if not path:
        return ""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return p.read_text(encoding="utf-8", errors="replace")


def ticket(raw_text: str = "", summary: str = "") -> dict[str, Any]:
    return {"summary": summary, "legs": [], "rawText": raw_text}


def maybe_float(value: str | None) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def review_item() -> dict[str, Any]:
    return {"score": None, "note": "", "recommendedChange": ""}


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a trade outcome feedback JSON record")
    parser.add_argument("--symbol", required=True, help="Bitget symbol, e.g. BTCUSDT")
    parser.add_argument("--side", choices=["LONG", "SHORT", "AUTO"], default=None)
    parser.add_argument("--family", default=None, help="Setup family/context, e.g. A/B/C1/VOCO")
    parser.add_argument("--timeframe", default="4H")
    parser.add_argument("--status", choices=STATUS_CHOICES, default="pretrade_frozen")

    parser.add_argument("--thesis", default="", help="Frozen pre-trade thesis summary")
    parser.add_argument("--impulse", default=None)
    parser.add_argument("--key-level", action="append", default=[])
    parser.add_argument("--entry-thesis", default="")
    parser.add_argument("--sl-thesis", default="")
    parser.add_argument("--tp-thesis", default="")
    parser.add_argument("--liquidity-thesis", default="")
    parser.add_argument("--prompt-rule", action="append", default=[])

    parser.add_argument("--tvflow-report", default=None)
    parser.add_argument("--packet-dir", default=None)
    parser.add_argument("--gpt-source", default=None)
    parser.add_argument("--live-execution-summary", default=None)
    parser.add_argument("--journal-snapshot", default=None)
    parser.add_argument("--tradingview-export", default=None)
    parser.add_argument("--screenshot", action="append", default=[])

    parser.add_argument("--tvflow-ticket-source", default=None)
    parser.add_argument("--gpt-ticket-source", default=None)
    parser.add_argument("--andrea-ticket-source", default=None)
    parser.add_argument("--placed-ticket-source", default=None)
    parser.add_argument("--tvflow-ticket-summary", default="")
    parser.add_argument("--gpt-ticket-summary", default="")
    parser.add_argument("--andrea-ticket-summary", default="")
    parser.add_argument("--placed-ticket-summary", default="")

    parser.add_argument("--planned-risk-usdt", default=None)
    parser.add_argument("--planned-reward-usdt", default=None)
    parser.add_argument("--order-id", action="append", default=[])
    parser.add_argument("--notes", default="")
    parser.add_argument("--output-dir", default="reports/deep_analysis_feedback")
    parser.add_argument("--output", default=None)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")
    symbol = args.symbol.upper()
    feedback_id = f"{ts}_{symbol}_outcome_feedback"

    record: dict[str, Any] = {
        "schemaVersion": "trade_outcome_feedback_v1",
        "feedbackId": feedback_id,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "updatedAt": now.isoformat().replace("+00:00", "Z"),
        "symbol": symbol,
        "side": args.side,
        "family": args.family,
        "timeframe": args.timeframe,
        "status": args.status,
        "preTradeThesis": {
            "summary": args.thesis,
            "impulse": args.impulse,
            "keyLevels": args.key_level,
            "entryThesis": args.entry_thesis,
            "slThesis": args.sl_thesis,
            "tpThesis": args.tp_thesis,
            "liquidityThesis": args.liquidity_thesis,
            "promptRulesUsed": args.prompt_rule,
        },
        "sourceArtifacts": {
            "tvflowReport": args.tvflow_report,
            "packetDir": args.packet_dir,
            "gptSource": args.gpt_source,
            "liveExecutionSummary": args.live_execution_summary,
            "journalSnapshot": args.journal_snapshot,
            "tradingViewExport": args.tradingview_export,
            "screenshots": args.screenshot,
        },
        "tickets": {
            "tvflowProposed": ticket(read_text(args.tvflow_ticket_source), args.tvflow_ticket_summary),
            "gptProposed": ticket(read_text(args.gpt_ticket_source or args.gpt_source), args.gpt_ticket_summary),
            "andreaPreferred": ticket(read_text(args.andrea_ticket_source), args.andrea_ticket_summary),
            "actuallyPlaced": ticket(read_text(args.placed_ticket_source), args.placed_ticket_summary),
        },
        "outcomeEvidence": {
            "status": "not_started",
            "summary": "",
            "bitgetOrderIds": args.order_id,
            "verificationSourcePolicy": {
                "executionTruth": "bitget_export_or_journal_required",
                "marketPathTruth": "tradingview_or_bitget_ohlcv_export_required",
                "screenshotsRole": "supporting_visual_only",
                "finalJudgmentRule": "defer_if_required_export_evidence_missing",
            },
            "metrics": {
                "plannedRiskUsdt": maybe_float(args.planned_risk_usdt),
                "plannedRewardUsdt": maybe_float(args.planned_reward_usdt),
                "realizedPnlUsdt": None,
                "realizedR": None,
                "mfeUsdt": None,
                "maeUsdt": None,
                "mfeR": None,
                "maeR": None,
                "timeToFillMinutes": None,
                "timeToCloseMinutes": None,
                "missedEntryDistancePct": None,
                "slippageUsdt": None,
            },
        },
        "counterfactualReplay": [
            {"candidate": "tvflow", "result": "unknown", "note": ""},
            {"candidate": "gpt", "result": "unknown", "note": ""},
            {"candidate": "andrea_manual", "result": "unknown", "note": ""},
            {"candidate": "no_trade", "result": "unknown", "note": ""},
        ],
        "ruleOutcomeAudit": [
            {"rule": rule, "effect": "unknown", "evidence": ""}
            for rule in args.prompt_rule
        ],
        "workflowReview": {
            "dataSourceQuality": review_item(),
            "methodQuality": review_item(),
            "efficiency": review_item(),
            "promptToolImprovement": review_item(),
            "summary": "",
        },
        "finalLearning": {
            "outcomeAttribution": {
                "primaryCause": "pending",
                "setupQuality": "pending",
                "improvementRoom": "pending",
                "externalCatalystChecked": False,
                "note": "",
            },
            "outcomeCategory": "pending",
            "summary": "",
            "patchDecision": "pending",
            "actions": [],
        },
        "notes": args.notes,
    }

    out = Path(args.output) if args.output else Path(args.output_dir) / f"{feedback_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(str(out))
    if args.pretty:
        print(json.dumps(record, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
