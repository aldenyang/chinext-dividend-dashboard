# -*- coding: utf-8 -*-
"""雪球ZH3068836法证分析: 净值复算 + 调仓画像 + 因子反推 + 执行检验"""
import json, math, statistics as st
from pathlib import Path
from datetime import datetime
ROOT = Path("/Users/bobyang/WorkBuddy/2026-10-23-19-55-56/chinext-dividend-dashboard")
CB = ROOT / "data" / "cb"
TD, RF = 244, 0.015

# ---------- 1) 净值复算 ----------
nav = json.loads((CB / "xq_nav.json").read_text())
strat = next(x for x in nav if x["symbol"] == "ZH3068836")
rows = strat["list"]
vals = [r["value"] for r in rows]
dates = [r["date"] for r in rows]
rs = [vals[i] / vals[i-1] - 1 for i in range(1, len(vals))]
days = len(vals) - 1
total = vals[-1]
cagr = total ** (TD / days) - 1
peak, mdd = 1.0, 0.0
for v in vals:
    peak = max(peak, v); mdd = max(mdd, 1 - v / peak)
vol = st.stdev(rs) * math.sqrt(TD)
sharpe = (cagr - RF) / vol
print("=== A. 官方净值独立复算 ===")
print(f"区间 {dates[0]} ~ {dates[-1]} ({days}个交易日)  期末净值 {total:.4f}")
print(f"CAGR {cagr*100:.2f}%  波动 {vol*100:.1f}%  MDD {mdd*100:.2f}%  夏普 {sharpe:.2f}  Calmar {cagr/mdd:.2f}")
print("报告口径: CAGR 22.86%  MDD -10.39%  夏普 1.57")

idx = {r["date"]: r["close"] for r in json.loads((ROOT / "data" / "sh000832.json").read_text())}
print("\n=== B. 年度收益 ===")
for y in sorted(set(d[:4] for d in dates)):
    yr = [i for i, d in enumerate(dates) if d.startswith(y)]
    v0, v1 = vals[yr[0] - 1] if yr[0] > 0 else vals[0], vals[yr[-1]]
    strat_r = v1 / v0 - 1
    yd = [d for d in dates if d.startswith(y)]
    all_idx_d = sorted(idx)
    import bisect
    p = all_idx_d[bisect.bisect_left(all_idx_d, yd[0]) - 1] if bisect.bisect_left(all_idx_d, yd[0]) > 0 else all_idx_d[0]
    cb_r = idx[yd[-1]] / idx[p] - 1
    print(f"  {y}: 策略 {strat_r*100:7.2f}%   中证转债 {cb_r*100:7.2f}%   超额 {(strat_r-cb_r)*100:+7.2f}pp")

# ---------- 2) 调仓记录 ----------
reb = json.loads((CB / "xq_rebalancing.json").read_text())
trades, reb_dates = [], []
for r in reb:
    ts = r["created_at"] / 1000
    d = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    reb_dates.append(d)
    for h in r.get("rebalancing_histories") or []:
        pw = h.get("prev_weight") or 0
        tw = h.get("target_weight") or 0
        trades.append({"date": d, "code": h["stock_symbol"].replace("SH", "").replace("SZ", ""),
                       "name": h["stock_name"], "price": h["price"],
                       "buy": tw > 0 and pw <= 0,
                       "sell": tw <= 0 and pw > 0,
                       "adj": tw > 0 and pw > 0})
buys = [t for t in trades if t["buy"]]
sells = [t for t in trades if t["sell"]]
from collections import Counter
mc = Counter(d[:7] for d in reb_dates)
print("\n=== C. 调仓画像 ===")
print(f"调仓 {len(reb)} 次, 区间 {min(reb_dates)} ~ {max(reb_dates)}, 月均 {len(reb)/len(mc):.1f} 次")
print(f"买入事件 {len(buys)}, 卖出事件 {len(sells)}, 调仓内调权重 {len(trades)-len(buys)-len(sells)}")
freq = Counter((t["code"], t["name"]) for t in trades)
print("交易次数Top10:", ", ".join(f"{n}({c})x{k}" for (c, n), k in freq.most_common(10)))

# ---------- 3) 因子画像 ----------
def load_series(code):
    p = CB / "raw" / f"{code}.json"
    if not p.exists(): return None
    return json.loads(p.read_text())
series_cache = {}
def factor_at(code, date):
    if code not in series_cache:
        series_cache[code] = load_series(code)
    s = series_cache[code]
    if not s: return None
    prev = None
    for row in s:
        if row[0] > date:
            break
        prev = row
    if not prev: return None
    d, close, _, so = prev
    return {"date": d, "price": close, "prem": so, "dl": (close + so) if so is not None else None}

def stats_of(items, key):
    xs = [x[key] for x in items if x[key] is not None]
    if not xs: return None
    xs.sort()
    q = lambda p: xs[min(int(len(xs)*p), len(xs)-1)]
    return {"p25": q(0.25), "med": q(0.5), "p75": q(0.75), "mean": sum(xs)/len(xs)}

buy_f = [dict(t, **(factor_at(t["code"], t["date"]) or {})) for t in buys]
sell_f = [dict(t, **(factor_at(t["code"], t["date"]) or {})) for t in sells]
print("\n=== D. 买入/卖出因子画像 (买入时点) ===")
for key, label in [("price", "价格"), ("prem", "溢价率%"), ("dl", "双低")]:
    b = stats_of(buy_f, key); s = stats_of(sell_f, key)
    fmt = lambda x: f"{x:.1f}" if x is not None else "-"
    print(f"  {label}: 买入 P25~P75 {fmt(b and b['p25'])}~{fmt(b and b['p75'])} (中位 {fmt(b and b['med'])})   卖出中位 {fmt(s and s['med'])}")
low_prem = sum(1 for x in buy_f if x["prem"] is not None and x["prem"] < 10) / max(sum(1 for x in buy_f if x["prem"] is not None), 1)
in_105_130 = sum(1 for x in buy_f if 105 <= (x["price"] or 0) <= 130) / max(len(buy_f), 1)
print(f"  买入时溢价率<10% 占比 {low_prem*100:.0f}%   价格在105-130 占比 {in_105_130*100:.0f}%")

# ---------- 4) 执行检验 ----------
print("\n=== E. 执行检验: 成交价 vs 当日市场收盘 ===")
devs = []
for t in buy_f + sell_f:
    if t.get("date") and t["price"] and t.get("price") and series_cache.get(t["code"]) is not None:
        s = series_cache[t["code"]]
        row = next((r for r in s if r[0] == t["date"]), None)
        if row and row[1]:
            devs.append(t["price"] / row[1] - 1)
if devs:
    devs_abs = sorted(abs(x) for x in devs)
    print(f"  样本 {len(devs)} 笔: 偏差中位 {devs_abs[len(devs_abs)//2]*100:.2f}%  P25 {devs_abs[len(devs_abs)//4]*100:.2f}%  P75 {devs_abs[len(devs_abs)*3//4]*100:.2f}%")

# ---------- 5) 保存分析产物 ----------
out = {"nav_metrics": {"cagr": cagr, "mdd": mdd, "vol": vol, "sharpe": sharpe, "total": total,
                       "start": dates[0], "end": dates[-1], "days": days},
       "rebalancing": {"count": len(reb), "trades": len(trades), "buys": len(buys), "sells": len(sells)},
       "buy_profile": {"low_prem_ratio": low_prem, "price_105_130_ratio": in_105_130,
                        "price_med": stats_of(buy_f, "price"), "prem_med": stats_of(buy_f, "prem")},
       "exec_dev": {"n": len(devs), "med": devs_abs[len(devs_abs)//2] if devs else None}}
(CB / "xq_forensics.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("\nsaved -> data/cb/xq_forensics.json")
