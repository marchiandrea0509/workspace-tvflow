#!/usr/bin/env python3
"""Strict finalization gate for Discord deep-analysis delivery.

This is intentionally stricter than render_deep_analysis_chat_reply.py. It is the
single command to run before answering Andrea's "Analyse SYMBOL" requests.

The recurring regression is not report generation; it is delivery bypass: the
assistant saves or thinks through an analysis, then manually sends a compressed
Discord summary. This gate makes the delivery artifact explicit and fails closed
unless the saved report and rendered chat chunks both pass the structural rules.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_deep_analysis_report import validate  # noqa: E402
from render_deep_analysis_chat_reply import chunk_text, render_chat_reply  # noqa: E402


def write_chunks(reply: str, chunk_dir: Path, limit: int) -> list[Path]:
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for old in chunk_dir.glob("chunk_*.md"):
        old.unlink()
    chunks = chunk_text(reply, limit)
    paths: list[Path] = []
    for i, chunk in enumerate(chunks, start=1):
        # IMPORTANT: chunk files are user-visible delivery artifacts. Keep them
        # clean. Do not prepend control markers/instructions here; those belong
        # in the manifest only. A previous version wrote
        # "VERBATIM_DEEP_ANALYSIS_CHUNK ..." into chunk_*.md and the assistant
        # correctly followed "send verbatim", leaking internal delivery metadata
        # into Discord and making the first-shot format ugly.
        text = f"{chunk.rstrip()}\n"
        path = chunk_dir / f"chunk_{i:02d}.md"
        path.write_text(text, encoding="utf-8")
        paths.append(path)
    return paths


def validate_rendered_chunks(paths: list[Path]) -> dict:
    combined_parts: list[str] = []
    failures: list[str] = []
    for p in paths:
        text = p.read_text(encoding="utf-8-sig")
        if "VERBATIM_DEEP_ANALYSIS_CHUNK" in text:
            failures.append(f"{p}: contains user-visible internal chunk marker")
        combined_parts.append(text)
    combined = "\n".join(combined_parts)
    result = validate(combined)
    if not result["ok"]:
        for f in result["failures"]:
            failures.append(f"combined chunks: {f['key']}: {f['message']}")
    return {"ok": not failures, "failures": failures, "combined_checks": result}


def main() -> int:
    ap = argparse.ArgumentParser(description="Finalize validated deep-analysis delivery chunks")
    ap.add_argument("--report", required=True, help="Canonical deep-analysis markdown report")
    ap.add_argument("--out", help="Rendered full reply path; default <report>.discord_reply.md")
    ap.add_argument("--chunk-dir", help="Chunk output dir; default <report>.discord_chunks")
    ap.add_argument("--manifest", help="Manifest JSON path; default <chunk-dir>/manifest.json")
    ap.add_argument("--chunk-limit", type=int, default=1800, help="Discord-safe chunk length before marker")
    ap.add_argument("--no-path", action="store_true", help="Do not include saved report path in rendered reply")
    args = ap.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        print(f"ERROR: report not found: {report_path}", file=sys.stderr)
        return 2

    report_text = report_path.read_text(encoding="utf-8-sig")
    report_result = validate(report_text)
    if not report_result["ok"]:
        print(f"ERROR: report fails deep-analysis validator: {report_path}", file=sys.stderr)
        for f in report_result["failures"]:
            print(f"- {f['key']}: {f['message']}", file=sys.stderr)
        print("\nDo not answer with a manual summary. Fix the report first.", file=sys.stderr)
        return 3

    reply = render_chat_reply(report_text, report_path, include_path=not args.no_path)
    reply_result = validate(reply)
    if not reply_result["ok"]:
        print("ERROR: rendered reply fails deep-analysis validator", file=sys.stderr)
        for f in reply_result["failures"]:
            print(f"- {f['key']}: {f['message']}", file=sys.stderr)
        return 4

    out_path = Path(args.out) if args.out else report_path.with_suffix(report_path.suffix + ".discord_reply.md")
    chunk_dir = Path(args.chunk_dir) if args.chunk_dir else report_path.with_suffix(report_path.suffix + ".discord_chunks")
    manifest_path = Path(args.manifest) if args.manifest else chunk_dir / "manifest.json"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(reply, encoding="utf-8")
    chunk_paths = write_chunks(reply, chunk_dir, args.chunk_limit)
    chunk_result = validate_rendered_chunks(chunk_paths)
    if not chunk_result["ok"]:
        print("ERROR: rendered chunks failed delivery validation", file=sys.stderr)
        for f in chunk_result["failures"]:
            print(f"- {f}", file=sys.stderr)
        return 5

    manifest = {
        "status": "PASS",
        "rule": "Send clean chunk_*.md content verbatim and in order. Do not include internal marker text. Do not write a compressed manual summary.",
        "report": str(report_path),
        "reply": str(out_path),
        "chunkDir": str(chunk_dir),
        "chunks": [str(p) for p in chunk_paths],
        "chunkCount": len(chunk_paths),
        "chunkLimit": args.chunk_limit,
        "userVisibleChunksAreClean": True,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    print("PASS deep-analysis delivery finalized")
    print(f"report: {report_path}")
    print(f"reply: {out_path}")
    print(f"chunks: {chunk_dir}")
    print(f"manifest: {manifest_path}")
    print("NEXT ACTION: send clean chunk_*.md content verbatim, in order. Do not summarize and do not add marker text.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
