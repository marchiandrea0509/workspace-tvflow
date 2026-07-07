#!/usr/bin/env python3
"""Render deterministic deep-analysis markdown from a model decision JSON.

The optimization goal is to keep market judgment with the model while moving the
ARM-approved report structure, table columns, and Discord-delivery format into
code. The input JSON is intentionally content-focused; this renderer owns the
stable markdown layout and then runs the existing structural validator.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_deep_analysis_report import validate  # noqa: E402


TICKET_HEADERS = ["Leg", "Entry", "Type", "Qty", "Notional", "SL", "Loss", "TP", "Profit", "RR", "Trigger"]
RISK_HEADERS = ["Plan", "Status", "Risk", "Reward", "RR", "Notional", "Margin"]
GATE_HEADERS = ["Gate", "Value", "Limit / rule", "Traffic light"]


class DecisionError(ValueError):
    pass


def s(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def bullet_lines(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [s(x).strip() for x in value if s(x).strip()]
    text = s(value).strip()
    return [text] if text else []


def require_list(data: dict[str, Any], key: str, min_len: int = 1) -> list[Any]:
    value = data.get(key)
    if not isinstance(value, list) or len(value) < min_len:
        raise DecisionError(f"Missing or too-short array: {key}")
    return value


def require_dict(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise DecisionError(f"Missing object: {key}")
    return value


def md_table(headers: list[str], rows: Iterable[Iterable[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        vals = [s(x).replace("\n", "<br>") for x in row]
        if len(vals) < len(headers):
            vals += [""] * (len(headers) - len(vals))
        lines.append("| " + " | ".join(vals[: len(headers)]) + " |")
    return "\n".join(lines) + "\n"


def render_generic_tables(tables: Any) -> str:
    if not isinstance(tables, list):
        return ""
    out: list[str] = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        headers = table.get("headers")
        rows = table.get("rows")
        if not isinstance(headers, list) or not isinstance(rows, list):
            continue
        title = s(table.get("title")).strip()
        if title:
            out.append(f"\n{title}\n")
        out.append(md_table([s(h) for h in headers], rows))
    return "\n".join(out).strip() + ("\n" if out else "")


def render_ticket(rows: Any) -> str:
    if not rows:
        return ""
    if not isinstance(rows, list):
        raise DecisionError("ticket must be an array")
    normalized = []
    for r in rows:
        if not isinstance(r, dict):
            raise DecisionError("ticket rows must be objects")
        normalized.append([
            r.get("leg"), r.get("entry"), r.get("type"), r.get("qty"), r.get("notional"),
            r.get("sl"), r.get("loss"), r.get("tp"), r.get("profit"), r.get("rr"), r.get("trigger"),
        ])
    return md_table(TICKET_HEADERS, normalized)


def render_option(name: str, label: str, option: dict[str, Any], heading_level: int = 2) -> str:
    hashes = "#" * heading_level
    out = [f"{hashes} {label}\n"]
    out.append(f"**Status:** {s(option.get('status')).strip()}\n")
    for line in bullet_lines(option.get("commentary")):
        out.append(f"\n{line}\n")
    ticket = render_ticket(option.get("ticket"))
    if ticket:
        out.append("\n" + ticket)
    extra = render_generic_tables(option.get("tables"))
    if extra:
        out.append("\n" + extra)
    return "".join(out).rstrip() + "\n"


def gate_table(rows: list[Any]) -> str:
    normalized = []
    for r in rows:
        if not isinstance(r, dict):
            raise DecisionError("orderability rows must be objects")
        normalized.append([r.get("gate"), r.get("value"), r.get("limitRule"), r.get("trafficLight")])
    return md_table(GATE_HEADERS, normalized)


def render(data: dict[str, Any]) -> str:
    if data.get("schemaVersion") != "deep_analysis_decision_v1":
        raise DecisionError("schemaVersion must be deep_analysis_decision_v1")

    header = require_dict(data, "header")
    fields = require_list(header, "fields", 4)
    context = require_list(data, "contextState", 3)
    input_integrity = require_list(data, "inputIntegrity", 1)
    levels = require_list(data, "detectedLevelMap", 6)
    impulse = require_dict(data, "pullbackImpulse")
    impulse_rows = require_list(impulse, "rows", 2)
    options = require_dict(data, "options")
    orderability = require_dict(data, "orderability")
    risk = require_list(data, "riskSizing", 1)
    verdict = require_list(data, "finalVerdict", 3)

    out: list[str] = [f"# {s(data.get('title')).strip()}\n"]

    out.append("\n## Header / Classification\n\n")
    out.append(md_table(["Field", "Value"], [[r.get("field"), r.get("value")] for r in fields if isinstance(r, dict)]))

    out.append("\n## Context and State\n\n")
    out.append(md_table(
        ["TF", "State", "Evidence", "Execution meaning"],
        [[r.get("tf"), r.get("state"), r.get("evidence"), r.get("executionMeaning")] for r in context if isinstance(r, dict)],
    ))

    out.append("\n## Input screenshot audit\n\n")
    out.append(md_table(
        ["Source", "Issue", "Analysis impact"],
        [[r.get("source"), r.get("issue"), r.get("analysisImpact")] for r in input_integrity if isinstance(r, dict)],
    ))

    out.append("\n## Detected Level Map\n\n")
    out.append(md_table(
        ["Level", "Type", "Source / meaning", "Plan use"],
        [[r.get("level"), r.get("type"), r.get("source"), r.get("planUse")] for r in levels if isinstance(r, dict)],
    ))

    out.append("\n## Pullback Impulse Used\n\n")
    out.append(s(impulse.get("narrative")).strip() + "\n\n")
    out.append(md_table(
        ["Impulse", "Approx fibs / levels", "Use / decision"],
        [[r.get("impulse"), r.get("levels"), r.get("decision")] for r in impulse_rows if isinstance(r, dict)],
    ))

    out.append("\n" + render_option("A", "A — BEST QUALITY PULLBACK", require_dict(options, "A")))
    out.append("\n" + render_option("B", "B — BEST FILL-PROBABILITY PULLBACK", require_dict(options, "B")))

    out.append("\n## C — BREAKOUT / BREAKDOWN\n")
    out.append("\n" + render_option("C1", "C1 — Long breakout / retest", require_dict(options, "C1"), heading_level=3))
    out.append("\n" + render_option("C2", "C2 — Short breakdown", require_dict(options, "C2"), heading_level=3))

    out.append("\n" + render_option("D", "D — OC EXECUTION WRAPPER", require_dict(options, "D")))

    out.append("\n## Orderability / liquidity traffic-light table\n")
    out.append("\n### A. Liquidity and executable orderability\n\n")
    out.append(gate_table(require_list(orderability, "liquidity", 4)))
    out.append("\n### B. Operational safety\n\n")
    out.append(gate_table(require_list(orderability, "operationalSafety", 3)))
    out.append("\n### C. Risk and feasibility\n\n")
    out.append(gate_table(require_list(orderability, "riskFeasibility", 3)))

    out.append("\n## Risk sizing summary\n\n")
    out.append(md_table(
        RISK_HEADERS,
        [[r.get("plan"), r.get("status"), r.get("risk"), r.get("reward"), r.get("rr"), r.get("notional"), r.get("margin")] for r in risk if isinstance(r, dict)],
    ))

    evidence = data.get("evidence")
    if isinstance(evidence, list) and evidence:
        out.append("\nEvidence / saved artifacts:\n")
        for item in evidence:
            out.append(f"- {s(item)}\n")

    out.append("\n## Final verdict\n\n")
    for item in verdict:
        out.append(f"- {s(item).strip()}\n")

    return "".join(out).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Render deep-analysis markdown from decision JSON")
    ap.add_argument("--decision", required=True, help="Model decision JSON path")
    ap.add_argument("--out", required=True, help="Rendered markdown report path")
    ap.add_argument("--no-validate", action="store_true", help="Skip structural markdown validation")
    args = ap.parse_args()

    decision_path = Path(args.decision)
    out_path = Path(args.out)
    try:
        data = json.loads(decision_path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise DecisionError("decision JSON root must be an object")
        report = render(data)
    except Exception as exc:
        print(f"ERROR: cannot render decision JSON: {exc}", file=sys.stderr)
        return 2

    if not args.no_validate:
        result = validate(report)
        if not result["ok"]:
            print("ERROR: rendered report fails structural validator", file=sys.stderr)
            for failure in result["failures"]:
                print(f"- {failure['key']}: {failure['message']}", file=sys.stderr)
            return 3

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, encoding="utf-8")
    print(f"PASS rendered deep-analysis report: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
