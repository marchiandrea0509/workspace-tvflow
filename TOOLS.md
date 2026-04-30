# TOOLS.md

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
