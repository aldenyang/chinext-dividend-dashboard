#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""创业板指 vs 中证红利: 量价与资金进出规律分析
A. 量价: 各自成交量状态(放量/缩量)与涨跌组合 -> 前向收益
B. 量能联动: 两板块成交量变化的同期/领先滞后相关
C. 资金: 主力净流入(东财, 120日) -> 相关性 / 领先滞后 / 轮动差值对相对比值的预测力
"""
import json, os, time, statistics as st
import requests

ROOT = os.path.join(os.path.dirname(__file__), '..')
H = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/'}
OUT = os.path.join(ROOT, 'data', 'flow_analysis.json')

def get(url, params=None, tries=4):
    last = None
    for k in range(tries):
        try:
            return requests.get(url, params=params, headers=H, timeout=20)
        except Exception as e:
            last = e; time.sleep(2 * (k + 1))
    raise last

# ---------- 数据 ----------
def fetch_kline(code, n=1500):
    for _ in range(3):
        try:
            r = get('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
                    params={'param': f'{code},day,,,{n},qfq'})
            d = r.json()['data'][code]
            if isinstance(d, dict):
                break
        except Exception:
            time.sleep(2)
    k = d.get('qfqday') or d.get('day')
    # [date, open, close, high, low, volume, ...]
    return [(x[0], float(x[2]), float(x[5])) for x in k]

def fetch_flow(secid):
    r = get('https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get',
            params={'lmt': 0, 'klt': 101, 'secid': secid,
                    'fields1': 'f1,f2,f3,f7',
                    'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65'})
    kl = (r.json().get('data') or {}).get('klines') or []
    out = []
    for row in kl:
        p = row.split(',')
        # date, 主力净额, 小单, 中单, 大单, 超大单, 主力净占比%, 小单占比, 中单占比, 大单占比, 超大单占比, 收盘, 涨跌幅
        out.append({'date': p[0], 'main': float(p[1]), 'main_pct': float(p[6]),
                    'xl_pct': float(p[7]), 'close': float(p[11]), 'chg': float(p[12])})
    return out[:-1]  # 剔除今日盘中(未收盘)

cyb = fetch_kline('sz399006')
div = fetch_kline('sh000922')
flow_cyb = fetch_flow('0.399006')
flow_div = fetch_flow('1.000922')
print(f'K线: 创业板 {len(cyb)} 行 / 红利 {len(div)} 行; 资金流: 各 {len(flow_cyb)}/{len(flow_div)} 行')

# 对齐
pc, pd_ = dict((d, (c, v)) for d, c, v in cyb), dict((d, (c, v)) for d, c, v in div)
dates = sorted(set(pc) & set(pd_))
closes_c = [pc[d][0] for d in dates]
closes_d = [pd_[d][0] for d in dates]
vols_c = [pc[d][1] for d in dates]
vols_d = [pd_[d][1] for d in dates]
idx = {d: i for i, d in enumerate(dates)}

def fwd(arr, i, n):
    return (arr[i + n] / arr[i] - 1) * 100 if i + n < len(arr) else None

# ---------- A. 量价: 量能状态 x 涨跌 -> 前向收益 ----------
def vol_price(name, closes, vols):
    res = {}
    for up in (True, False):
        for lo, hi, lab in [(1.5, 99, '放量'), (0.7, 1.5, '常量'), (0, 0.7, '缩量')]:
            f5, f20, wins = [], [], []
            for i in range(20, len(dates) - 20):
                vr = vols[i] / (sum(vols[i-20:i]) / 20)
                if not (lo <= vr < hi): continue
                chg = closes[i] / closes[i-1] - 1
                if (chg > 0) != up: continue
                a, b = fwd(closes, i, 5), fwd(closes, i, 20)
                if a is not None: f5.append(a)
                if b is not None: f20.append(b)
                wins.append(1 if (a or 0) > 0 else 0)
            if f5:
                res[f'{lab}{"涨" if up else "跌"}'] = {
                    'n': len(f5), 'f5': round(st.mean(f5), 2),
                    'f20': round(st.mean(f20), 2), 'win5': round(100 * st.mean(wins))}
    print(f'\n== {name} 量价组合 -> 前向收益 ==')
    for k, v in res.items():
        print(f"  {k}: n={v['n']:>5}  5日 {v['f5']:+.2f}% (胜率{v['win5']}%)  20日 {v['f20']:+.2f}%")
    return res

res_a1 = vol_price('创业板指', closes_c, vols_c)
res_a2 = vol_price('中证红利', closes_d, vols_d)

# ---------- B. 量能联动 ----------
import math
def corr(x, y):
    n = min(len(x), len(y))
    x, y = x[-n:], y[-n:]
    mx, my = st.mean(x), st.mean(y)
    sx = math.sqrt(sum((a-mx)**2 for a in x)); sy = math.sqrt(sum((a-my)**2 for a in y))
    if sx == 0 or sy == 0: return 0
    return sum((a-mx)*(b-my) for a, b in zip(x, y)) / (sx*sy)

volr_c = [vols_c[i] / (sum(vols_c[i-20:i])/20) if i >= 20 else None for i in range(len(dates))]
volr_d = [vols_d[i] / (sum(vols_d[i-20:i])/20) if i >= 20 else None for i in range(len(dates))]
pairs = [(volr_c[i], volr_d[i]) for i in range(len(dates)) if volr_c[i] and volr_d[i]]
print(f'\n== 量能联动 ==')
print(f"  20日量比 同期相关: {corr([p[0] for p in pairs], [p[1] for p in pairs]):+.2f}  (n={len(pairs)})")

# 滚动120日相关的演变
roll = []
for i in range(len(dates) - 120, len(dates)):
    xs = [volr_c[j] for j in range(i-120, i) if volr_c[j] and volr_d[j]]
    ys = [volr_d[j] for j in range(i-120, i) if volr_c[j] and volr_d[j]]
    roll.append((dates[i], round(corr(xs, ys), 2)))
print(f'  滚动120日相关 近5个节点: {roll[-5:]}')

# 日收益率相关 + 领先滞后
ret_c = [(closes_c[i]/closes_c[i-1]-1)*100 for i in range(1, len(dates))]
ret_d = [(closes_d[i]/closes_d[i-1]-1)*100 for i in range(1, len(dates))]
print(f'  日收益 同期相关: {corr(ret_c, ret_d):+.2f}')

# ---------- C. 资金流(120日) ----------
fd = {x['date']: x for x in flow_div}
common = [x for x in flow_cyb if x['date'] in fd]
mc = [x['main_pct'] for x in common]
md = [fd[x['date']]['main_pct'] for x in common]
print(f'\n== 资金流 (主力净流入占比%, 东财, n={len(common)}, {common[0]["date"]} ~ {common[-1]["date"]}) ==')
print(f'  主力净占比 同期相关: {corr(mc, md):+.2f}')

# 领先滞后: 创业板流 t+k 与 红利流 t 的相关
lags = {}
for k in range(-5, 6):
    if k >= 0: x, y = mc[k:], md[:len(md)-k] if k else md
    else: x, y = mc[:k], md[-k:]
    lags[k] = round(corr(x, y), 2)
print(f'  领先滞后相关 (创业板 t%+d vs 红利 t): {lags}')

# 轮动差值 spread -> 相对比值前向收益
ratio = [closes_c[i] / closes_d[i] for i in range(len(dates))]
res_c = []
for i, x in enumerate(common):
    j = idx.get(x['date'])
    if j is None or j + 10 >= len(dates): continue
    spread = x['main_pct'] - fd[x['date']]['main_pct']
    f5 = (ratio[j+5] / ratio[j] - 1) * 100
    f10 = (ratio[j+10] / ratio[j] - 1) * 100
    res_c.append({'date': x['date'], 'spread': spread, 'f5': f5, 'f10': f10})

sp = [r['spread'] for r in res_c]
print(f'  spread(创业板-红利 主力净占比) 分布: 均值 {st.mean(sp):+.2f}, 范围 [{min(sp):+.2f}, {max(sp):+.2f}]')
# 五分位
qs = sorted(res_c, key=lambda r: r['spread'])
n = len(qs); q = n // 5
print(f'  {"spread分位":<14}{"比值5日":>10}{"比值10日":>10}{"样本":>6}')
for qi in range(5):
    seg = qs[qi*q:(qi+1)*q] if qi < 4 else qs[qi*q:]
    print(f'  Q{qi+1} ({seg[0]["spread"]:+.1f}~{seg[-1]["spread"]:+.1f})'.ljust(16)
          + f'{st.mean([r["f5"] for r in seg]):>+9.2f}%{st.mean([r["f10"] for r in seg]):>+9.2f}%{len(seg):>6}')
ic5 = corr(sp, [r['f5'] for r in res_c]); ic10 = corr(sp, [r['f10'] for r in res_c])
print(f'  IC(spread, 比值5日) = {ic5:+.2f};  IC(spread, 比值10日) = {ic10:+.2f}')

# 极端分化日样本
ext = sorted(res_c, key=lambda r: -abs(r['spread']))[:8]
print('  极端分化日样本:')
for r in ext:
    print(f"    {r['date']}  spread {r['spread']:+.2f}  -> 比值5日 {r['f5']:+.2f}% / 10日 {r['f10']:+.2f}%")

# 个向: 资金流对自身指数的预测力
for lab, flows, closes in [('创业板', mc, closes_c), ('红利', md, closes_d)]:
    xs, f5s, f20s = [], [], []
    for i, x in enumerate(common):
        j = idx.get(x['date'])
        if j is None: continue
        a, b = fwd(closes, j, 5), fwd(closes, j, 20)
        if a is None or b is None: continue
        xs.append(x['main_pct']); f5s.append(a); f20s.append(b)
    print(f'  {lab}: IC(当日主力净占比, 自身5日) = {corr(xs, f5s):+.2f};  20日 = {corr(xs, f20s):+.2f}')

json.dump({'volume_price_cyb': res_a1, 'volume_price_div': res_a2,
           'flow_common': res_c, 'ic5': ic5, 'ic10': ic10,
           'flow_corr': round(corr(mc, md), 2), 'lag_corr': lags},
          open(OUT, 'w'), ensure_ascii=False)
print(f'\n已保存 {os.path.relpath(OUT, ROOT)}')
