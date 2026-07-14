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


def _split_h2_sections(text: str) -> list[tuple[str, str]]:
    """Return (heading, body) pairs for markdown H2 sections."""
    matches = list(re.finditer(r"^##\s+.+$", text, flags=re.M))
    if not matches:
        return [("", text)]
    sections: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[m.start():end].strip()
        lines = block.splitlines()
        sections.append((lines[0].strip(), "\n".join(lines[1:]).strip()))
    return sections


def _table_blocks(body: str) -> list[str]:
    blocks: list[str] = []
    cur: list[str] = []
    for line in body.splitlines():
        if line.lstrip().startswith("|"):
            cur.append(line.rstrip())
        else:
            if cur:
                blocks.append("\n".join(cur))
                cur = []
    if cur:
        blocks.append("\n".join(cur))
    return blocks


def _first_para(body: str, max_chars: int = 420) -> str:
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    for p in paras:
        if p.startswith("|") or p.startswith("###") or p.lower().startswith("**status:**"):
            continue
        p = re.sub(r"\s+", " ", p).strip()
        if len(p) > max_chars:
            p = p[: max_chars - 1].rstrip() + "…"
        return p
    return ""


def _status_line(body: str) -> str:
    m = re.search(r"^\*\*Status:\*\*.*$", body, flags=re.I | re.M)
    return m.group(0).strip() if m else ""


def _bullet_lines(body: str, limit: int = 6) -> list[str]:
    out: list[str] = []
    for line in body.splitlines():
        s = line.strip()
        if not s.startswith("-"):
            continue
        out.append(s)
        if len(out) >= limit:
            break
    return out


def _shorten_cell(cell: str, max_chars: int) -> str:
    cell = re.sub(r"\s+", " ", cell.strip())
    if len(cell) > max_chars:
        return cell[: max_chars - 1].rstrip() + "…"
    return cell


def _compact_table(table: str, heading: str) -> str:
    """Trim oversized markdown table cells for Discord while preserving square form."""
    lines = [ln for ln in table.splitlines() if ln.strip()]
    if len(lines) < 2:
        return table
    hnorm = heading.lower()

    parsed = [ln.strip().strip("|").split("|") for ln in lines if ln.lstrip().startswith("|")]
    headers = [_shorten_cell(c, 80).lower() for c in parsed[0]] if parsed else []

    # Context table: preserve the three timeframe interpretations, but do not
    # ship the whole verbose evidence prose to Discord.
    if "context and state" in hnorm and len(parsed) >= 3:
        rows = []
        for cells in parsed[2:]:
            if not cells:
                continue
            tf = _shorten_cell(cells[0], 12)
            state = _shorten_cell(cells[1] if len(cells) > 1 else "", 50)
            meaning = _shorten_cell(cells[3] if len(cells) > 3 else (cells[2] if len(cells) > 2 else ""), 95)
            rows.append(f"| {tf} | {state} | {meaning} |")
            if len(rows) >= 4:
                break
        return "\n".join(["| TF | State | Execution meaning |", "|---|---|---|", *rows])

    # Level map: keep a compact actionable map. Source prose remains in the
    # full saved report.
    if ("detected level" in hnorm or "key levels" in hnorm) and len(parsed) >= 3:
        rows = []
        for cells in parsed[2:]:
            if len(cells) < 2:
                continue
            level = _shorten_cell(cells[0], 18)
            typ = _shorten_cell(cells[1], 38)
            use = _shorten_cell(cells[3] if len(cells) > 3 else cells[-1], 72)
            rows.append(f"| {level} | {typ} | {use} |")
            if len(rows) >= 9:
                break
        return "\n".join(["| Level | Type | Plan use |", "|---|---|---|", *rows])

    max_cell = 70
    max_rows: int | None = None
    if "orderability" in hnorm or "liquidity" in hnorm:
        max_cell = 48
    elif re.search(r"^##\s+[abc]", heading, flags=re.I):
        max_cell = 68
    elif "risk sizing" in hnorm:
        max_cell = 62
    elif "pullback impulse" in hnorm:
        max_cell = 62
    elif "input" in hnorm:
        max_cell = 62

    out: list[str] = []
    data_seen = 0
    for idx, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            out.append(line)
            continue
        if idx >= 2:
            data_seen += 1
            if max_rows is not None and data_seen > max_rows:
                continue
        cells = line.strip().strip("|").split("|")
        # Separator row must remain a separator, not be shortened.
        if idx == 1 and all(re.fullmatch(r"\s*:?-{3,}:?\s*", c) for c in cells):
            out.append(line.rstrip())
            continue
        out.append("| " + " | ".join(_shorten_cell(c, max_cell) for c in cells) + " |")
    return "\n".join(out)


def _compact_section(heading: str, body: str) -> str:
    """Compact user-visible section while preserving validator-critical evidence.

    The saved report remains the full source of truth. This compact profile is
    for Discord latency/noise: keep all required headings, status lines, square
    ticket and traffic-light tables, risk table, and final verdict, while
    removing long explanatory prose that duplicates those tables.
    """
    hnorm = heading.lower()
    parts: list[str] = [heading]

    # Final verdict should stay human-readable, not table-only.
    if "final verdict" in hnorm:
        bullets = _bullet_lines(body, limit=8)
        parts.extend(bullets or [_first_para(body, 700)])
        return "\n\n".join(p for p in parts if p).strip()

    status = _status_line(body)
    if status:
        parts.append(status)

    # Preserve subsections for C1/C2 and orderability A/B/C gates.
    subheads = list(re.finditer(r"^###\s+.+$", body, flags=re.M))
    if subheads:
        pre = body[: subheads[0].start()].strip()
        p = _first_para(pre, 280)
        if p:
            parts.append(p)
        for i, m in enumerate(subheads):
            end = subheads[i + 1].start() if i + 1 < len(subheads) else len(body)
            block = body[m.start():end].strip()
            lines = block.splitlines()
            sh = lines[0].strip()
            sb = "\n".join(lines[1:]).strip()
            subparts = [sh]
            st = _status_line(sb)
            if st:
                subparts.append(st)
            para = _first_para(sb, 260)
            if para:
                subparts.append(para)
            tables = [_compact_table(t, sh) for t in _table_blocks(sb)]
            subparts.extend(tables)
            if not tables:
                subparts.extend(_bullet_lines(sb, limit=3))
            parts.append("\n\n".join(p for p in subparts if p))
        return "\n\n".join(p for p in parts if p).strip()

    # Tables are the compact delivery contract: ticket tables, traffic-light
    # tables, input audit, level map, and risk summary stay square-formatted.
    tables = [_compact_table(t, heading) for t in _table_blocks(body)]
    if tables:
        para = _first_para(body, 260)
        # For long option sections, the status + table is more useful than prose.
        if para and not re.search(r"^##\s+[ABCD]\s", heading, flags=re.I) and "risk sizing" not in hnorm:
            parts.append(para)
        parts.extend(tables)
        return "\n\n".join(p for p in parts if p).strip()

    # Required non-table sections: keep compact bullets/first paragraph.
    bullets = _bullet_lines(body, limit=5)
    if bullets:
        parts.extend(bullets)
    else:
        para = _first_para(body, 420)
        if para:
            parts.append(para)
    return "\n\n".join(p for p in parts if p).strip()


def render_chat_reply(report_text: str, report_path: Path, include_path: bool = True, delivery_profile: str = "compact") -> str:
    """Return a chat-ready reply that preserves mandatory sections/tables."""
    title_match = re.search(r"^#\s+(.+?)\s*$", report_text, flags=re.M)
    title = title_match.group(1).strip() if title_match else report_path.stem

    start_match = CANONICAL_START.search(report_text)
    body = report_text[start_match.start():].strip() if start_match else report_text.strip()

    if delivery_profile not in {"compact", "full"}:
        raise ValueError(f"unsupported delivery profile: {delivery_profile}")

    # Keep the output as a real report, not a loose manual summary. The report
    # title remains useful in chat, while local packet paths can stay in the
    # saved file.
    if delivery_profile == "compact":
        body = "\n\n".join(_compact_section(h, b) for h, b in _split_h2_sections(body))

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
    ap.add_argument("--delivery-profile", choices=["compact", "full"], default="compact", help="Discord delivery profile. compact keeps required square tables/final summary; full sends the whole rendered report.")
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

    reply = render_chat_reply(report_text, report_path, include_path=not args.no_path, delivery_profile=args.delivery_profile)
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
