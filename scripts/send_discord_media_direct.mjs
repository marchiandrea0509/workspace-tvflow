import { pathToFileURL } from 'node:url';
import { t as sendMessage } from 'file:///C:/Users/anmar/AppData/Roaming/npm/node_modules/openclaw/dist/message-uu04Edjj.js';

const mediaPath = 'C:/Users/anmar/.openclaw/workspace-tvflow/reports/bitget_exports/NVDAUSDT_usdt-futures_4H_bitget_full_history_20260611T062142Z.zip';
const content = 'NVDAUSDT.P Bitget API 4H full history export attached. Rows: 1,768. Range: 2025-08-19 04:00 UTC to 2026-06-11 00:00 UTC. Includes CSV + metadata JSON inside the ZIP.';
const result = await sendMessage({
  channel: 'discord',
  to: 'channel:1514514116931354735',
  content,
  mediaUrl: pathToFileURL(mediaPath).href,
  replyToId: '1514514122782277773',
  bestEffort: true,
  accountId: 'default',
});
console.log(JSON.stringify(result, null, 2));
setTimeout(() => process.exit(0), 250);
