#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""退出规则反事实检验: 在历史每个持仓段上模拟不同退出规则, 对比实际卖出效果
规则A(实际): 管理员真实卖出点
规则B(移动止盈): 段内涨幅曾≥+5%触发脉冲后, 从峰值回撤≥5%卖出
规则C(时间+弱势): 持有30交易日仍无脉冲(段内max<+2%)则退出
规则D(移动止盈B + 兜底C组合), 且叠加绝对止损-10%
"""
import json, os, datetime, statistics as st

BASE = os.path.join(os.path.dirname(__file__), '..', 'data', 'cb')

def load_raw(code):
    p = os.path.join(BASE, 'raw', f'{code}.json')
    return json.load(open(p)) if os.path.exists(p) else None

rebal = json.load(open(os.path.join(BASE, 'xq_rebalancing.json')))
events = []
for rb in rebal:
    d = datetime.datetime.fromtimestamp(rb['created_at']/1000 + 8*3600).strftime('%Y-%m-%d')
    for h in rb.get('rebalancing_histories') or []:
        code = (h.get('stock_symbol') or '')[-6:]
        if not code.startswith(('11', '12')): continue
        pw, tw, px = h.get('prev_weight'), h.get('target_weight'), h.get('price')
        if pw is None or tw is None or px in (None, 0): continue
        events.append({'date': d, 'code': code, 'name': h['stock_name'], 'pw': pw, 'tw': tw, 'price': px})
events.sort(key=lambda x: x['date'])

episodes_out = []
eps = {}
for e in events:
    c = e['code']
    ep = eps.setdefault(c, {'pos': 0.0, 'cost': 0.0, 'start': None})
    dw = e['tw'] - e['pw']
    if dw > 0.01:
        if ep['pos'] <= 0.01:
            ep.update({'start': e['date'], 'cost': e['price'], 'pos': e['tw']})
        else:
            ep['cost'] = (ep['cost']*ep['pos'] + e['price']*dw) / (ep['pos']+dw)
            ep['pos'] = e['tw']
    elif dw < -0.01 and ep['pos'] > 0.01:
        episodes_out.append({'code': c, 'name': e['name'], 'start': ep['start'],
                             'entry': ep['cost'], 'exit_date': e['date'], 'exit_price': e['price']})
        ep['pos'] = 0.0 if e['tw'] <= 0.01 else e['tw']
        if e['tw'] <= 0.01: ep.update({'start': None})

def simulate(hist, j0, jend, entry, rule):
    """在[j0, jend]上模拟规则退出, 返回(卖出日idx, 卖出价)或None(持到实际结束)"""
    peak = hist[j0][1]
    for j in range(j0, jend+1):
        px = hist[j][1]
        peak = max(peak, px)
        gain = px/entry - 1
        dd = 1 - px/peak if peak else 0
        if rule in ('B', 'D', 'E') and gain >= 0.05 and dd >= 0.05:
            return j, px
        if rule in ('C', 'D', 'E'):
            seg_max = max(hist[k][1] for k in range(j0, j+1)) / entry - 1
            if j - j0 >= 30 and seg_max < 0.02:
                return j, px
        if rule == 'D' and gain <= -0.10:
            return j, px
    return None

stats = {r: [] for r in ('A', 'B', 'C', 'D', 'E')}
for ep in episodes_out:
    hist = load_raw(ep['code'])
    if not hist: continue
    dates = [r[0] for r in hist]; idx = {d: i for i, d in enumerate(dates)}
    j0, je = idx.get(ep['start']), idx.get(ep['exit_date'])
    if j0 is None or je is None or je <= j0: continue
    entry = ep['entry']
    actual = (ep['exit_price']/entry - 1) * 100
    stats['A'].append(actual)
    for rule in ('B', 'C', 'D', 'E'):
        res = simulate(hist, j0, je, entry, rule)
        px = res[1] if res else hist[je][1]  # 未触发则持到实际结束日
        stats[rule].append((px/entry - 1) * 100)

n = len(stats['A'])
print(f"持仓段样本: {n}")
print(f"{'规则':<28}{'均收益':>9}{'中位':>9}{'胜率':>8}{'最差':>9}")
labels = {'A': 'A 实际卖出', 'B': 'B 脉冲后峰值回撤5%止盈', 'C': 'C 30日无脉冲退出',
          'D': 'D B+C+止损-10%', 'E': 'E B+C组合(无绝对止损)'}
for r in ('A', 'B', 'C', 'D', 'E'):
    v = stats[r]
    print(f"{labels[r]:<28}{st.mean(v):>+8.1f}%{st.median(v):>+8.1f}%{100*sum(1 for x in v if x>0)/n:>7.0f}%{min(v):>+8.1f}%")
print()
print("说明: 各规则均在同一段内窗口模拟, 未触发则持到实际结束日; 未计入再投资差异。")
json.dump(stats, open(os.path.join(BASE, 'exit_counterfactual.json'), 'w'))
