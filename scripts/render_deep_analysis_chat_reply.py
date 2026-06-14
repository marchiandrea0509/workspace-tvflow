#!/usr/bin/env python3
"""Render a Discord/chat-ready deep-analysis reply from a validated markdown report.

Purpose: prevent the recurring regression where the saved report passes the
structural validator but the actual chat answer is compressed into a poor
summary. This script makes the chat draft the same validated section family as
Andrea's expected 5-day swing-plan format.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Import the existing structural validator without duplicating rules.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from validate_deep_analysis_report import validate  # noqa: E402


CANONICAL_START = re.compile(r"^##\s+Header\s*/\s*Classification\s*$", re.I | re.M)


def render_chat_reply(report_text: str, report_path: Path, include_path: bool = True) -> str:
    """Return a chat-ready reply that preserves mandatory sections/tables."""
    title_match = re.search(r"^#\s+(.+?)\s*$", report_text, flags=re.M)
    title = title_match.group(1).strip() if title_match else report_path.stem

    start_match = CANONICAL_START.search(report_text)
    body = report_text[start_match.start():].strip() if start_match else report_text.strip()

    # Keep the output as a real report, not a summary. The report title remains
    # useful in chat, while local packet paths can stay in the saved file.
    header = f"# {title}\n"
    if include_path:
        header += f"\nValidated report: `{report_path.as_posix()}`\n"
    return f"{header}\n{body}\n".strip() + "\n"


def chunk_text(text: str, limit: int = 1800) -> list[str]:
    """Split on section boundaries for optional Discord-sized chunks."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    parts = re.split(r"(?=^##\s+)", text, flags=re.M)
    for part in parts:
        if not part:
            continue
        if current and len(current) + len(part) + 2 > limit:
            chunks.append(current.rstrip() + "\n")
            current = part
        else:
            current += ("\n" if current else "") + part
    if current.strip():
        chunks.append(current.rstrip() + "\n")
    # If an individual section is still too long, hard split lines.
    final: list[str] = []
    for chunk in chunks:
        if len(chunk) <= limit:
            final.append(chunk)
            continue
        buf = ""
        for line in chunk.splitlines(keepends=True):
            if buf and len(buf) + len(line) > limit:
                final.append(buf)
                buf = line
            else:
                buf += line
        if buf:
            final.append(buf)
    return final


def main() -> int:
    ap = argparse.ArgumentParser(description="Render validated deep-analysis report as chat reply")
    ap.add_argument("--report", required=True, help="Validated markdown report path")
    ap.add_argument("--out", help="Write chat draft to this path")
    ap.add_argument("--chunk-dir", help="Optional directory for Discord-sized chunks")
    ap.add_argument("--chunk-limit", type=int, default=1800, help="Chunk size for --chunk-dir")
    ap.add_argument("--allow-long-single-message", action="store_true", help="Permit a rendered reply longer than --chunk-limit without --chunk-dir. Use only outside Discord.")
    ap.add_argument("--no-path", action="store_true", help="Do not include saved report path in rendered reply")
    args = ap.parse_args()

    report_path = Path(args.report)
    report_text = report_path.read_text(encoding="utf-8-sig")

    report_result = validate(report_text)
    if not report_result["ok"]:
        print(f"ERROR: saved report fails validator: {report_path}", file=sys.stderr)
        for failure in report_result["failures"]:
            print(f"- {failure['key']}: {failure['message']}", file=sys.stderr)
        return 2

    reply = render_chat_reply(report_text, report_path, include_path=not args.no_path)
    reply_result = validate(reply)
    if not reply_result["ok"]:
        print("ERROR: rendered chat reply fails structural validator", file=sys.stderr)
        for failure in reply_result["failures"]:
            print(f"- {failure['key']}: {failure['message']}", file=sys.stderr)
        return 3

    # Discord answers must not be hand-compressed after this render step. A long
    # validated reply without chunk output is exactly how prior regressions
    # happened: the report passed, then the assistant summarized it manually.
    # Fail closed unless the caller explicitly says this is not a Discord send.
    if len(reply) > args.chunk_limit and not args.chunk_dir and not args.allow_long_single_message:
        print(
            "ERROR: rendered reply is longer than the Discord-safe chunk limit. "
            "Run again with --chunk-dir and send the generated chunks verbatim; "
            "do not replace them with a compressed summary.",
            file=sys.stderr,
        )
        print(f"reply_chars: {len(reply)}", file=sys.stderr)
        print(f"chunk_limit: {args.chunk_limit}", file=sys.stderr)
        suggested = report_path.with_suffix(report_path.suffix + ".discord_chunks")
        print(f"suggested_chunk_dir: {suggested.as_posix()}", file=sys.stderr)
        return 4

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(reply, encoding="utf-8")

    if args.chunk_dir:
        chunk_dir = Path(args.chunk_dir)
        chunk_dir.mkdir(parents=True, exist_ok=True)
        for old in chunk_dir.glob("chunk_*.md"):
            old.unlink()
        chunks = chunk_text(reply, args.chunk_limit)
        total = len(chunks)
        for i, chunk in enumerate(chunks, start=1):
            prefix = f"({i}/{total}) — validated deep-analysis reply chunk. Send chunks verbatim; do not summarize.\n" if total > 1 else ""
            (chunk_dir / f"chunk_{i:02d}.md").write_text(prefix + chunk, encoding="utf-8")

    if not args.out and not args.chunk_dir:
        print(reply, end="")
    else:
        print(f"PASS chat reply rendered from validated report: {report_path}")
        if args.out:
            print(f"reply: {args.out}")
        if args.chunk_dir:
            print(f"chunks: {args.chunk_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
