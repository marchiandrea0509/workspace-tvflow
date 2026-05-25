#!/usr/bin/env python3
"""Create a v0 deep-analysis feedback record.

This helper is intentionally lightweight: it creates a structured JSON record
for later comparison, prompt/tool patching, and optional journal outcome review.
It does not place orders and does not modify journal artifacts.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_ISSUE_TAGS = {
    "missed_support_resistance",
    "wrong_impulse_selection",
    "level_map_incomplete",
    "ignored_1h_refinement",
    "bad_entry_quality",
    "bad_ladder_spacing",
    "sl_too_tight",
    "sl_too_wide",
    "tp_unrealistic",
    "weak_rr_accepted",
    "valid_trade_overfiltered",
    "orderability_misjudged",
    "liquidity_or_slippage_issue",
    "margin_or_leverage_issue",
    "prompt_format_issue",
    "tool_packet_issue",
    "execution_followup_issue",
    "journal_outcome_learning",
}


def read_text(path: str | None) -> str:
    if not path:
        return ""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return p.read_text(encoding="utf-8", errors="replace")


def ticket(raw_text: str = "", summary: str = "", verdict: str | None = None) -> dict[str, Any]:
    return {
        "verdict": verdict,
        "summary": summary,
        "legs": [],
        "rawText": raw_text,
    }


def score_item() -> dict[str, Any]:
    return {"score": None, "note": ""}


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a deep-analysis feedback JSON record")
    parser.add_argument("--symbol", required=True, help="Bitget symbol, e.g. AAPLUSDT")
    parser.add_argument("--side", choices=["LONG", "SHORT", "AUTO"], default=None)
    parser.add_argument("--family", default=None, help="Optional family/context, e.g. LC, SC, A/B/C/D")
    parser.add_argument("--status", default="draft", choices=["draft", "waiting_for_gpt", "waiting_for_journal_outcome", "ready_for_patch", "patched", "archived_no_action"])
    parser.add_argument("--tvflow-report", default=None)
    parser.add_argument("--packet-dir", default=None)
    parser.add_argument("--gpt-source", default=None, help="File containing GPT analysis/ticket text")
    parser.add_argument("--live-execution-summary", default=None)
    parser.add_argument("--journal-snapshot", default=None)
    parser.add_argument("--screenshot", action="append", default=[])
    parser.add_argument("--preferred-source", choices=["tvflow", "gpt", "hybrid", "user_manual", "none"], default=None)
    parser.add_argument("--issue-tag", action="append", default=[])
    parser.add_argument("--summary", default="")
    parser.add_argument("--lesson", default="")
    parser.add_argument("--gpt-better", action="append", default=[])
    parser.add_argument("--tvflow-better", action="append", default=[])
    parser.add_argument("--notes", default="")
    parser.add_argument("--output-dir", default="reports/deep_analysis_feedback")
    parser.add_argument("--output", default=None, help="Explicit output JSON path")
    parser.add_argument("--pretty", action="store_true", help="Print created record to stdout")
    args = parser.parse_args()

    unknown = sorted(set(args.issue_tag) - VALID_ISSUE_TAGS)
    if unknown:
        raise SystemExit(f"Unknown issue tag(s): {', '.join(unknown)}")

    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")
    symbol = args.symbol.upper()
    feedback_id = f"{ts}_{symbol}_feedback"

    gpt_text = read_text(args.gpt_source)

    record: dict[str, Any] = {
        "schemaVersion": "deep_analysis_feedback_v0",
        "feedbackId": feedback_id,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "updatedAt": now.isoformat().replace("+00:00", "Z"),
        "symbol": symbol,
        "side": args.side,
        "family": args.family,
        "status": args.status,
        "sourceArtifacts": {
            "tvflowReport": args.tvflow_report,
            "packetDir": args.packet_dir,
            "gptSource": args.gpt_source,
            "liveExecutionSummary": args.live_execution_summary,
            "journalSnapshot": args.journal_snapshot,
            "screenshots": args.screenshot,
        },
        "tickets": {
            "tvflowProposed": ticket(summary="Extract from tvflow report if needed."),
            "gptProposed": ticket(raw_text=gpt_text, summary="Raw GPT text captured; extract legs if needed." if gpt_text else ""),
            "userPreferred": ticket(summary="Fill when Andrea chooses/edits final ticket."),
            "actuallyPlaced": ticket(summary="Fill if a live order is placed."),
        },
        "comparison": {
            "preferredSource": args.preferred_source,
            "summary": args.summary,
            "whatGptDidBetter": args.gpt_better,
            "whatTvflowDidBetter": args.tvflow_better,
            "actionableLesson": args.lesson,
            "shouldPatchPrompt": False,
            "shouldPatchTool": False,
            "shouldPatchDocsMemory": bool(args.lesson),
        },
        "issueTags": args.issue_tag,
        "scorecard": {
            "levelMapQuality": score_item(),
            "biasRead": score_item(),
            "entryQuality": score_item(),
            "ladderConstruction": score_item(),
            "slStructure": score_item(),
            "tpRealism": score_item(),
            "riskReward": score_item(),
            "orderability": score_item(),
            "finalVerdictUsefulness": score_item(),
        },
        "journalOutcome": {
            "status": "pending" if args.live_execution_summary or args.journal_snapshot else "not_linked",
            "journalSnapshot": args.journal_snapshot,
            "linkedOrderIds": [],
            "fillResult": None,
            "realizedPnlUsdt": None,
            "plannedRiskUsdt": None,
            "plannedRewardUsdt": None,
            "maxFavorableExcursionUsdt": None,
            "maxAdverseExcursionUsdt": None,
            "slReview": "",
            "tpReview": "",
            "entryReview": "",
            "summary": "",
            "lessonsForAnalysis": [],
        },
        "improvementActions": {
            "status": "queued" if args.lesson else "none",
            "actions": ([{
                "type": "docs_patch",
                "description": "Review whether this feedback creates a durable deep-analysis rule.",
                "status": "todo",
                "artifact": None,
            }] if args.lesson else []),
        },
        "notes": args.notes,
    }

    if args.output:
        out = Path(args.output)
    else:
        out = Path(args.output_dir) / f"{feedback_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(str(out))
    if args.pretty:
        print(json.dumps(record, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
