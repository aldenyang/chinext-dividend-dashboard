# -*- coding: utf-8 -*-
"""用提取的规则复刻: 小规模+中价+已进转股期, Top10等权月度轮动"""
import json, math, statistics as st
from pathlib import Path
from datetime import datetime
ROOT = Path("/Users/bobyang/WorkBuddy/2026-10-23-19-55-56/chinext-dividend-dashboard")
CB = ROOT / "data" / "cb"
TD, RF, COST = 244, 0.015, 0.001

uni_rows = json.loads((CB / "universe.json").read_text())
uni = {}
for u in uni_rows:
    code = u.get("SECURITY_CODE", "")
    if code[:2] not in ("11", "12"): continue
    uni[code] = {"listing": (u.get("LISTING_DATE") or "")[:10],
                 "tstart": (u.get("TRANSFER_START_DATE") or "")[:10],
                 "scale": u.get("ACTUAL_ISSUE_SCALE"),
                 "name": u.get("SECURITY_NAME_ABBR", "")}

raw_db = {}
def raw_of(code):
    if code not in raw_db:
        p = CB / "raw" / f"{code}.json"
        raw_db[code] = json.loads(p.read_text()) if p.exists() else None
    return raw_db[code]

cal = sorted({r["date"] for r in json.loads((ROOT / "data" / "sh000832.json").read_text())})
START, END = "2022-03-07", "2026-10-26"
cal = [d for d in cal if START <= d <= END]
rebal_days = set()
seen = set()
for d in cal:
    if d[:7] not in seen: seen.add(d[:7]); rebal_days.add(d)

def backtest(sort_key, scale_max=5.0, band=(120, 135), topn=10, label=""):
    idx_of, ser = {}, {}
    for c, u in uni.items():
        s = raw_of(c)
        if s and len(s) > 30:
            ser[c] = s
            idx_of[c] = {r[0]: i for i, r in enumerate(s)}
    hold, vals, rs, pending, dates_used = [], [1.0], [], None, []
    w = 1 / topn
    for d in cal:
        if pending is not None:
            picks = pending; pending = None
            turned = len(set(hold) ^ set(picks)) / max(len(set(hold) | set(picks)), 1)
            vals[-1] *= (1 - COST * turned * 2)
            hold = picks
        r = 0.0
        for c in hold:
            s = ser.get(c)
            if not s: continue
            ii = idx_of[c].get(d)
            if ii is not None and ii > 0:
                r += w * (s[ii][1] / s[ii-1][1] - 1)
        vals.append(vals[-1] * (1 + r)); rs.append(r); dates_used.append(d)
        if d in rebal_days:
            cands = []
            for c, u in uni.items():
                sc = u["scale"]
                if not sc or sc > scale_max: continue
                if u["tstart"] and d < u["tstart"]: continue
                s = ser.get(c)
                if not s: continue
                ii = idx_of[c].get(d)
                if ii is None or ii < 20: continue
                px, prem = s[ii][1], s[ii][3]
                if prem is None or not (band[0] <= px <= band[1]): continue
                key = {"scale": sc, "price": px, "prem": prem}[sort_key]
                cands.append((key, c))
            cands.sort()
            pending = [c for _, c in cands[:topn]]
    days = len(dates_used) - 1
    total = vals[-1]
    cagr = total ** (TD / max(days, 1)) - 1
    peak, mdd = 1.0, 0.0
    for v in vals:
        peak = max(peak, v); mdd = max(mdd, 1 - v / peak)
    vol = st.stdev(rs) * math.sqrt(TD) if len(rs) > 2 else 0
    sharpe = (cagr - RF) / vol if vol > 0 else 0
    print(f"{label:34s} CAGR {cagr*100:6.2f}%  MDD {mdd*100:5.1f}%  夏普 {sharpe:.2f}  期末 {total:.2f}x")
    return dates_used, vals

print("官方组合: CAGR 22.52%  MDD 10.39%  夏普 1.60   |   中证转债: CAGR 2.96%  MDD 15.64%")
backtest("scale", label="S 规模最小Top10 (120-135, <5亿)")
backtest("price", label="P 价格最低Top10 (120-135, <5亿)")
backtest("prem",  label="Q 溢价最低Top10 (120-135, <5亿)")
backtest("scale", scale_max=3.0, label="S2 规模最小Top10 (<3亿, 120-135)")
backtest("scale", scale_max=8.0, band=(110, 140), label="S3 规模最小Top10 (<8亿, 110-140)")
backtest("scale", scale_max=5.0, band=(105, 130), topn=20, label="S4 规模最小Top20 (<5亿, 105-130)")
