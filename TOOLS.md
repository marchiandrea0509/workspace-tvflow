# TOOLS.md

## Discord file / ZIP delivery (general rule)

For Discord file exports/attachments, do **not** rely on a final assistant `MEDIA:<path>` line. It has repeatedly failed to attach ZIP/output files in this workspace.

Use the proven direct Discord media-send route instead:

```powershell
openclaw message send --channel discord --target 1487602980093165658 --reply-to <discord_message_id> --message "File attached: <short summary>." --media <absolute_file_path> --json --verbose
```

Operational rule:
- create the artifact first and verify it exists/has nonzero size
- send with `openclaw message send --media` using the current Discord channel id and triggering message id
- verify the command returns a Discord `messageId` / success JSON before saying it was attached
- only use a final `MEDIA:<path>` line as a fallback for web UI, never as the primary Discord delivery path

Known-good historical proof: 2026-04-30 direct media send worked after `MEDIA:` failed for Strategy Test ZIP delivery; messageId `1499525125626663062` in channel `1487602980093165658`. See `memory/2026-04-30.md`.

## TradingView Strategy Test ZIP delivery

For Strategy Test chart-data exports, use the wrapper/direct Discord media-send path for zip delivery. Do **not** rely on a final assistant `MEDIA:<zip>` line for Discord zip attachments; it has failed to deliver in this workflow.

Preferred command path:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\anmar\.openclaw\workspace\tradingview\scripts\run_bitget_tradfi_strategy_export.ps1 -ReplyTo <discord_message_id>
```

For ad-hoc subsets, use the wrapper's `-Symbols` or `-SymbolsFile` options and keep sending enabled:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\anmar\.openclaw\workspace\tradingview\scripts\run_bitget_tradfi_strategy_export.ps1 -SymbolsFile <path> -ReplyTo <discord_message_id>
```

If a zip was already created manually, send it with the proven direct route:

```powershell
openclaw message send --channel discord --target 1487602980093165658 --reply-to <discord_message_id> --message "Strategy Test CSV export zip attached: <summary>." --media <zip_path> --json --verbose
```
