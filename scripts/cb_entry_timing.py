#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
介入时机检验：组合买入一只债之前，它是否已经在涨/溢价扩张？
- 苗头派：买入前 3/5 日已有明显异动（追涨介入）
- 埋伏派：买入前静默，仅凭画像（规模/价格/转股期）提前进场
方法：取每笔买入，用买入日 T（按收盘成交）之前的 K 日收益与溢价变化分组，
      再比较两组的买入后 5/10/20 日前向收益。
"""
import json, os, datetime, statistics as st

BASE = os.path.join(os.path.dirname(__file__), '..', 'data', 'cb')

def load_raw(code):
    p = os.path.join(BASE, 'raw', f'{code}.json')
    if not os.path.exists(p):
        return None
    rows = json.load(open(p))
    # row = [date, close, conv_value, premium]
    return {r[0]: r for r in rows}

def prev_trade_dates(dates, i, k):
    """i 之前（不含 i）的第 k 个交易日"""
    j = i - k
    return j if j >= 0 else None

rebal = json.load(open(os.path.join(BASE, 'xq_rebalancing.json')))
buys = []
for rb in rebal:
    d = datetime.datetime.fromtimestamp(rb['created_at']/1000 + 8*3600).strftime('%Y-%m-%d')
    for h in rb.get('rebalancing_histories') or []:
        if (h.get('volume') or 0) > 0 and (h.get('price') or 0) > 0:
            sym = h['stock_symbol']  # e.g. SZ123250
            code = sym[-6:]
            if code.startswith(('4', '8')):  # 老三板剔除
                continue
            buys.append({'date': d, 'code': code, 'name': h['stock_name'],
                         'price': h['price'], 'weight': h.get('target_weight') or 10})
print(f'有效买入样本: {len(buys)} 笔')

records = []
for b in buys:
    hist = load_raw(b['code'])
    if not hist or b['date'] not in hist:
        continue
    dates = sorted(hist.keys())
    i = dates.index(b['date'])
    if i < 21:
        continue
    rowT = hist[b['date']]
    close_T = rowT[1]
    prem_T = rowT[3]

    def ret(k):
        j = i - k
        if j < 0:
            return None
        c0 = hist[dates[j]][1]
        return (close_T / c0 - 1) * 100 if c0 else None

    def prem_chg(k):
        j = i - k
        if j < 0:
            return None
        p0 = hist[dates[j]][3]
        if p0 is None or prem_T is None:
            return None
        return prem_T - p0

    r1, r3, r5, r10 = ret(1), ret(3), ret(5), ret(10)
    p5 = prem_chg(5)
    if r3 is None:
        continue

    def fwd(k):
        j = i + k
        if j >= len(dates):
            j = len(dates) - 1
            if j <= i:
                return None
        return (hist[dates[j]][1] / close_T - 1) * 100

    records.append({
        'date': b['date'], 'code': b['code'], 'name': b['name'],
        'r1': r1, 'r3': r3, 'r5': r5, 'r10': r10, 'p5': p5,
        'f5': fwd(5), 'f10': fwd(10), 'f20': fwd(20),
    })

print(f'有完整历史可分析的样本: {len(records)} 笔')

def grp_stats(rs, label):
    n = len(rs)
    if n == 0:
        return
    def mean(key):
        vals = [r[key] for r in rs if r[key] is not None]
        return st.mean(vals) if vals else float('nan')
    def win(key):
        vals = [r[key] for r in rs if r[key] is not None]
        return 100 * sum(1 for v in vals if v > 0) / len(vals) if vals else float('nan')
    print(f'\n【{label}】 n={n}')
    print(f'  买入前: 1日收益均值 {mean("r1"):+.2f}% | 3日 {mean("r3"):+.2f}% | 5日 {mean("r5"):+.2f}% | 10日 {mean("r10"):+.2f}%')
    print(f'  买入前5日溢价变化均值 {mean("p5"):+.1f}pp')
    print(f'  买入后: 5日均收益 {mean("f5"):+.2f}% (胜率 {win("f5"):.0f}%) | 10日 {mean("f10"):+.2f}% ({win("f10"):.0f}%) | 20日 {mean("f20"):+.2f}% ({win("f20"):.0f}%)')

# ---- 分组标准 ----
# 苗头已现: 买入前3日涨幅 >= +3%（妖债启动的典型信号）
miao = [r for r in records if r['r3'] >= 3]
qianfu = [r for r in records if r['r3'] < 3]
grp_stats(miao, '苗头已现（前3日涨幅≥+3%）')
grp_stats(qianfu, '静默埋伏（前3日涨幅<+3%）')

# 更严格：前5日涨幅>=5%
miao5 = [r for r in records if (r['r5'] or 0) >= 5]
grp_stats(miao5, '强苗头（前5日涨幅≥+5%）')

# ---- 整体分布：买入前3日收益的分位数 ----
r3s = sorted(r['r3'] for r in records)
n = len(r3s)
print('\n—— 全部买入：买入前3日收益分布 ——')
for q in [0.1, 0.25, 0.5, 0.75, 0.9]:
    print(f'  P{int(q*100)}: {r3s[int(q*n)]:+.2f}%')
print(f'  前3日涨幅≥3%的买入占比: {100*len(miao)/n:.0f}%')
print(f'  前3日涨幅≤0（完全没启动）占比: {100*sum(1 for x in r3s if x<=0)/n:.0f}%')

# ---- 按年份看：策略是否从埋伏转向追苗头 ----
print('\n—— 分年份：买入前3日均值涨幅 / 苗头占比 ——')
years = {}
for r in records:
    y = r['date'][:4]
    years.setdefault(y, []).append(r)
for y in sorted(years):
    rs = years[y]
    m = [r for r in rs if r['r3'] >= 3]
    print(f'  {y}: n={len(rs):3d}  前3日均涨 {st.mean([r["r3"] for r in rs]):+.2f}%  苗头占比 {100*len(m)/len(rs):.0f}%')

# ---- 当前持仓检验 ----
print('\n—— 当前持仓（2026-09-23 建仓的10只）：买入时是否已有苗头 ——')
latest = {}
for rb in rebal:
    for h in rb.get('rebalancing_histories') or []:
        latest[h['stock_symbol']] = h
hold = [b for b in buys if b['date'] >= '2026-09-01']
for b in sorted(hold, key=lambda x: x['date']):
    rec = next((r for r in records if r['code'] == b['code'] and r['date'] == b['date']), None)
    if rec:
        flag = '苗头' if rec['r3'] >= 3 else ('温和' if rec['r3'] >= 0 else '静默')
        print(f"  {b['date']} {b['name']}({b['code']}) 买前3日 {rec['r3']:+.1f}% 5日 {rec['r5']:+.1f}% 溢价5日 {rec['p5']:+.0f}pp → {flag}")
