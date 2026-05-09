# Tool Prompt — Bitget Semi-Auto Journal Update

Intended runner: **nano subagent** (`gpt-nano`, minimal thinking). Escalate to Mini only if the wrapper fails or output is clearly inconsistent.

## Purpose
Refresh the Bitget semi-auto trade journal from Bitget API history/state. This mirrors past trades plus current active orders/positions. It is read/report only.

## Run command
From `C:\Users\anmar\.openclaw\workspace-tvflow`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1 -NoSend
```

If explicitly asked to post to the Bitget trades thread and posting is allowed in the runtime:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1
```

After a confirmed auto-trade, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_bitget_journal_update.ps1 -MessagePrefix "Journal refreshed after Bitget auto-trade."
```

## Expected final JSON
The wrapper prints JSON with:
- `ok`
- `historySummary`
- `workbook`
- `csv`
- `messages`
- `sent`
- `sentMessageIds`

## Handling rules
- If `ok: true`, report concise success with history counts and artifact paths.
- If `sent: true`, include Discord message ids.
- If `sent: false`, say artifacts/messages are ready but not posted.
- Do not inspect or print secrets.
- Do not place/cancel/modify orders.
- Do not debug Bitget API or rewrite scripts as nano; escalate to Mini with the first clear error line.
