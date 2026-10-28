#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZH3068836 卖出时机法证
问题: 1) 是否在债券启动后才卖? 2) 是否有止损机制?
方法: 按债重建持仓段(episode), 对每笔卖出计算:
  - 卖出时盈亏(vs 段内加权入场成本)
  - 持有天数(交易日)
  - 段内最大涨幅 / 卖出价在段内"最低-峰值"区间的位置(0=最低,1=峰值)
  - 卖出前 3/5 日动量; 卖出后 5/10/20 日前向收益(卖飞 or 卖在顶)
聚合: 盈亏分布(找止损簇) / 赢家输家持有期对比 / 卖出后走势
"""
import json, os, datetime, statistics as st

BASE = os.path.join(os.path.dirname(__file__), '..', 'data', 'cb')

def load_raw(code):
    p = os.path.join(BASE, 'raw', f'{code}.json')
    return json.load(open(p)) if os.path.exists(p) else None

rebal = json.load(open(os.path.join(BASE, 'xq_rebalancing.json')))
# 按时间排序的全部调仓
events = []
for rb in rebal:
    d = datetime.datetime.fromtimestamp(rb['created_at']/1000 + 8*3600).strftime('%Y-%m-%d')
    for h in rb.get('rebalancing_histories') or []:
        code = (h.get('stock_symbol') or '')[-6:]
        if not code.startswith(('11', '12')):
            continue
        pw, tw, px = h.get('prev_weight'), h.get('target_weight'), h.get('price')
        if pw is None or tw is None or px in (None, 0):
            continue
        events.append({'date': d, 'code': code, 'name': h['stock_name'],
                       'pw': pw, 'tw': tw, 'price': px})
events.sort(key=lambda x: x['date'])
print(f"交易事件: {len(events)} (含买卖)")

# 重建持仓段
episodes = {}  # code -> dict(pos_weight, entry_cost, start_date, trades)
sells = []
for e in events:
    c = e['code']
    ep = episodes.setdefault(c, {'pos': 0.0, 'cost': 0.0, 'start': None})
    dw = e['tw'] - e['pw']
    if dw > 0.01:  # 买入/加仓
        if ep['pos'] <= 0.01:
            ep['start'] = e['date']; ep['cost'] = e['price']; ep['pos'] = e['tw']
        else:
            ep['cost'] = (ep['cost'] * ep['pos'] + e['price'] * dw) / (ep['pos'] + dw)
            ep['pos'] = e['tw']
    elif dw < -0.01 and ep['pos'] > 0.01:  # 卖出
        sells.append({'date': e['date'], 'code': c, 'name': e['name'],
                      'price': e['price'], 'entry': ep['cost'],
                      'start': ep['start'], 'full': e['tw'] <= 0.01})
        ep['pos'] = e['tw']
        if e['tw'] <= 0.01:
            ep['pos'] = 0.0; ep['start'] = None

print(f"卖出事件: {len(sells)}")

# 关联价格历史
out = []
for s in sells:
    hist = load_raw(s['code'])
    if not hist: continue
    dates = [r[0] for r in hist]; idx = {d: i for i, d in enumerate(dates)}
    if s['date'] not in idx: continue
    i = idx[s['date']]
    px = s['price']; entry = s['entry']
    if not entry: continue
    pnl = (px / entry - 1) * 100
    # 段内窗口
    j0 = idx.get(s['start'])
    if j0 is None or j0 >= i: continue
    seg = hist[j0:i+1]
    seg_closes = [r[1] for r in seg]
    peak, low = max(seg_closes), min(seg_closes)
    max_gain = (peak / entry - 1) * 100
    # 卖出位置: 相对段内低点-峰值
    exit_pos = (px - low) / (peak - low) if peak > low else 0.5
    def ret(k, ref_i, ref_px):
        j = ref_i + k
        j = min(j, len(hist) - 1)
        return (hist[j][1] / ref_px - 1) * 100 if j > ref_i else None
    def pre(k):
        j = i - k
        return (px / hist[j][1] - 1) * 100 if j >= 0 and hist[j][1] else None
    def prem_chg(k):
        j = i - k
        if j < 0 or hist[i][3] is None or hist[j][3] is None: return None
        return hist[i][3] - hist[j][3]
    out.append({'date': s['date'], 'code': s['code'], 'name': s['name'], 'full': s['full'],
                'pnl': pnl, 'hold_days': i - j0, 'max_gain': max_gain,
                'exit_pos': exit_pos, 'pre3': pre(3), 'pre5': pre(5),
                'p5': prem_chg(5),
                'post5': ret(5, i, px), 'post10': ret(10, i, px), 'post20': ret(20, i, px)})

print(f"可分析卖出: {len(out)}\n")

def mean(key, rs=None):
    rs = rs or out
    v = [r[key] for r in rs if r.get(key) is not None]
    return st.mean(v) if v else float('nan')

def pct(key, p, rs=None):
    rs = rs or out
    v = sorted(x for x in (r.get(key) for r in rs) if x is not None)
    return v[int(p * len(v))] if v else float('nan')

print("========== 1) 卖出时的盈亏分布(找止损簇) ==========")
pnls = sorted(r['pnl'] for r in out)
n = len(pnls)
for q in [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]:
    print(f"  P{int(q*100)}: {pnls[int(q*n)]:+.1f}%")
loss = [r for r in out if r['pnl'] < 0]
win = [r for r in out if r['pnl'] >= 0]
print(f"  亏损卖出占比: {100*len(loss)/n:.0f}%  亏损中位 {st.median([r['pnl'] for r in loss]):+.1f}%  最深 {pnls[0]:+.1f}%")
print(f"  亏损超过-8%的笔数: {sum(1 for p in pnls if p < -8)} / 超过-12%: {sum(1 for p in pnls if p < -12)}")

print("\n========== 2) 赢家 vs 输家 ==========")
print(f"  {'':6s}{'笔数':>5}{'持有天数':>9}{'段内最大涨幅':>10}{'卖出前5日涨':>9}{'卖出位置':>8}")
for label, rs in [('盈利', win), ('亏损', loss)]:
    print(f"  {label:<6}{len(rs):>5}{mean('hold_days', rs):>9.0f}{mean('max_gain', rs):>10.1f}%{mean('pre5', rs):>9.1f}%{mean('exit_pos', rs):>8.2f}")

print("\n========== 3) 卖出后走势: 卖飞还是卖在顶 ==========")
print(f"  卖出后5日均涨 {mean('post5'):+.1f}% | 10日 {mean('post10'):+.1f}% | 20日 {mean('post20'):+.1f}%")
print(f"  (正=卖出后继续涨=卖飞; 负=卖在相对高位)")
print(f"  卖出价在段内[低点-峰值]区间位置: 均值 {mean('exit_pos'):.2f} (1=卖在峰值)")
print(f"  卖出前5日涨幅中位: {pct('pre5', 0.5):+.1f}%  (正=卖入强势, 负=卖入弱势)")

print("\n========== 4) 持有天数分布 ==========")
hd = sorted(r['hold_days'] for r in out)
for q in [0.1, 0.25, 0.5, 0.75, 0.9]:
    print(f"  P{int(q*100)}: {hd[int(q*len(hd))]} 个交易日")

print("\n========== 5) 亏损卖出明细(最差15笔, 看止损痕迹) ==========")
for r in sorted(out, key=lambda x: x['pnl'])[:15]:
    print(f"  {r['date']} {r['name']:<8} 盈亏{r['pnl']:+6.1f}% 持有{r['hold_days']:3d}日 "
          f"段内最大{r['max_gain']:+6.1f}% 卖出位置{r['exit_pos']:.2f} 前5日{r['pre5']:+5.1f}% 后10日{r['post10']:+6.1f}%")

print("\n========== 6) 盈利卖出明细(最好15笔, 看止盈模式) ==========")
for r in sorted(out, key=lambda x: -x['pnl'])[:15]:
    print(f"  {r['date']} {r['name']:<8} 盈亏{r['pnl']:+6.1f}% 持有{r['hold_days']:3d}日 "
          f"段内最大{r['max_gain']:+6.1f}% 卖出位置{r['exit_pos']:.2f} 前5日{r['pre5']:+5.1f}% 后10日{r['post10']:+6.1f}%")

json.dump(out, open(os.path.join(BASE, 'exit_forensics.json'), 'w'), ensure_ascii=False, indent=1)
print("\nsaved -> data/cb/exit_forensics.json")
