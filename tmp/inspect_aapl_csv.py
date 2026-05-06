import csv, json
p=r'C:\Users\anmar\.openclaw\workspace\tradingview\reports\strategy_test_watchlist_csv\BITGET_TRADFI_2026-05-04T19-55-25-616Z\AAPLUSDT.P_strategy_test_4h.csv'
with open(p,encoding='utf-8-sig',newline='') as f:
    reader=csv.DictReader(f)
    rows=list(reader)
print('strategy rows',len(rows))
print('strategy cols', reader.fieldnames[:120])
print('strategy last:')
for k,v in list(rows[-1].items())[:120]:
    print(f'{k} = {v}')

p2=r'C:\Users\anmar\.openclaw\workspace\tradingview\reports\pine_screener\pine_screener_2026-05-01T12-08-35-838Z.csv'
with open(p2,encoding='utf-8-sig',newline='') as f:
    srows=list(csv.DictReader(f))
print('\nscreener rows', len(srows))
print('screener cols', list(srows[0].keys()))
for row in srows:
    vals=' '.join(str(x) for x in row.values()).upper()
    if 'AAPL' in vals:
        print('screener AAPL row')
        print(json.dumps(row,indent=2))
        break
