# -*- coding: utf-8 -*-
"""介入区间胜率/赔率分析
对ZH3068836的每笔买入(370笔), 按买入时点因子区间分桶:
  胜率 = 前向收益>0占比;  赔率 = 平均盈利/平均亏损;  期望 = 胜率*均盈 - (1-胜率)*均亏
对照: 同一批买入日期, 全市场转债池等权介入(剔除时间/大盘水分), 及超额胜率
前向窗口: 10 / 20 / 60 交易日, 收盘价口径
"""
import json, math
from pathlib import Path
from collections import defaultdict

ROOT = Path("/Users/bobyang/WorkBuddy/2026-10-23-19-55-56/chinext-dividend-dashboard")
CB = ROOT / "data" / "cb"
RAW = CB / "raw"

# ---------- 加载 ----------
uni_raw = json.loads((CB / "universe.json").read_text())
uni = [u for u in uni_raw if (u.get("SECURITY_CODE") or "")[:2] in ("11", "12")]
scale_of = {}
for u in uni:
    try:
        scale_of[u["SECURITY_CODE"]] = float(u.get("ACTUAL_ISSUE_SCALE") or 0)
    except (TypeError, ValueError):
        scale_of[u["SECURITY_CODE"]] = None

ser, idx = {}, {}
for u in uni:
    p = RAW / f"{u['SECURITY_CODE']}.json"
    if not p.exists():
        continue
    rows = json.loads(p.read_text())
    ser[u["SECURITY_CODE"]] = rows
    idx[u["SECURITY_CODE"]] = {r[0]: i for i, r in enumerate(rows) if r[1]}

# 指数基准(超额用)
idx_rows = json.loads((ROOT / "data" / "sh000832.json").read_text())
IDX = {r["date"]: r["close"] for r in idx_rows}
IDX_DATES = sorted(IDX)
IDX_POS = {d: i for i, d in enumerate(IDX_DATES)}

# 买入事件
reb = json.loads((CB / "xq_rebalancing.json").read_text())
buys = []
for r in reb:
        ts = (r.get("created_at") or 0) / 1000
        from datetime import datetime, timezone, timedelta
        d = datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))).date().isoformat()
        for h in r.get("rebalancing_histories") or []:
            if (h.get("target_weight") or 0) > 0 and (h.get("prev_weight") or 0) <= 0:
                code = h["stock_symbol"].replace("SH", "").replace("SZ", "")
                buys.append({"code": code, "date": d, "name": h["stock_name"]})
# 同日同债去重(等权组合一次买入算一次)
seen, events = set(), []
for b in buys:
    k = (b["code"], b["date"])
    if k not in seen:
        seen.add(k)
        events.append(b)

print(f"去重后买入事件: {len(events)}")

# ---------- 前向收益 ----------
HORIZONS = [10, 20, 60]

def fwd(code, d, H):
    """收盘买入口径: close(d+H)/close(d)-1; 数据不足返回None"""
    m = idx.get(code)
    if not m or d not in m:
        return None
    i = m[d]
    rows = ser[code]
    j = i + H
    if j >= len(rows) or not rows[j][1]:
        return None
    return rows[j][1] / rows[i][1] - 1

def fwd_ex(code, d, H):
    r = fwd(code, d, H)
    if r is None:
        return None
    p = IDX_POS.get(d)
    if p is None or p + H >= len(IDX_DATES):
        return None
    ir = IDX[IDX_DATES[p + H]] / IDX[d] - 1
    return r - ir

# ---------- 分桶 ----------
BUCKETS = {
    "价格": [("≤110", lambda p, s, o, sv: p <= 110), ("110-120", lambda p, s, o, sv: 110 < p <= 120),
            ("120-130", lambda p, s, o, sv: 120 < p <= 130), ("130-145", lambda p, s, o, sv: 130 < p <= 145),
            (">145", lambda p, s, o, sv: p > 145)],
    "溢价率%": [("≤10", lambda p, s, o, sv: o is not None and o <= 10), ("10-30", lambda p, s, o, sv: o is not None and 10 < o <= 30),
              ("30-50", lambda p, s, o, sv: o is not None and 30 < o <= 50), ("50-80", lambda p, s, o, sv: o is not None and 50 < o <= 80),
              (">80", lambda p, s, o, sv: o is not None and o > 80)],
    "规模亿": [("≤2", lambda p, s, o, sv: s is not None and s <= 2), ("2-3", lambda p, s, o, sv: s is not None and 2 < s <= 3),
             ("3-5", lambda p, s, o, sv: s is not None and 3 < s <= 5), ("5-10", lambda p, s, o, sv: s is not None and 5 < s <= 10),
             (">10", lambda p, s, o, sv: s is not None and s > 10)],
    "转股价值": [("≤85", lambda p, s, o, sv: sv is not None and sv <= 85), ("85-100", lambda p, s, o, sv: sv is not None and 85 < sv <= 100),
              ("100-115", lambda p, s, o, sv: sv is not None and 100 < sv <= 115), (">115", lambda p, s, o, sv: sv is not None and sv > 115)],
}

def stats(rets, exs):
    """rets/exs: list of (raw, excess) 有效样本"""
    n = len(rets)
    if n < 8:
        return None
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    wr = len(wins) / n
    aw = sum(wins) / len(wins) if wins else 0
    al = abs(sum(losses) / len(losses)) if losses else 1e-9
    payoff = aw / al if al > 0 else float("inf")
    ev = wr * aw - (1 - wr) * al
    ewr = len([e for e in exs if e > 0]) / n
    return {"n": n, "wr": wr, "payoff": payoff, "ev": ev, "avg": sum(rets) / n, "ewr": ewr, "exavg": sum(exs) / n}

def factor_of(code, d):
    m = idx.get(code)
    if not m or d not in m:
        return None
    row = ser[code][m[d]]
    p, sv, o = row[1], row[2], row[3]
    return p, scale_of.get(code), o, sv

for H in HORIZONS:
    print(f"\n{'='*72}\n前向窗口 {H} 个交易日")
    # 基线: 买入日全池
    base_raw, base_ex = [], []
    for b in events:
        d = b["date"]
        for c, m in idx.items():
            if d in m:
                r, e = fwd(c, d, H), fwd_ex(c, d, H)
                if r is not None:
                    base_raw.append(r)
                if e is not None:
                    base_ex.append(e)
    bs = stats(base_raw, base_ex)
    if bs:
        print(f"基线(买入日全池随机): N={bs['n']} 胜率{bs['wr']*100:.1f}% 赔率{bs['payoff']:.2f} 均值{bs['avg']*100:+.2f}% | 超额胜率{bs['ewr']*100:.1f}% 超额均值{bs['exavg']*100:+.2f}%")
    for fname, buckets in BUCKETS.items():
        print(f"-- {fname}")
        groups = defaultdict(lambda: ([], []))
        for b in events:
            f = factor_of(b["code"], b["date"])
            if not f:
                continue
            for label, fn in buckets:
                if fn(*f):
                    r, e = fwd(b["code"], b["date"], H), fwd_ex(b["code"], b["date"], H)
                    if r is not None:
                        groups[label][0].append(r)
                        groups[label][1].append(e)
        for label, _ in buckets:
            s = stats(*groups[label]) if label in groups else None
            if s:
                print(f"   {label:8s} N={s['n']:3d} 胜率{s['wr']*100:5.1f}% 赔率{s['payoff']:4.2f} 期望{s['ev']*100:+5.2f}% 均值{s['avg']*100:+6.2f}% | 超额胜率{s['ewr']*100:5.1f}%")
