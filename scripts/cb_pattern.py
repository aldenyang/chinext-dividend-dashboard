# -*- coding: utf-8 -*-
"""ZH3068836选债规律提取: 买入组 vs 当日全池百分位 + 规则覆盖度"""
import json, math, statistics as st
from pathlib import Path
from datetime import datetime
from collections import defaultdict, Counter
import requests
from concurrent.futures import ThreadPoolExecutor

ROOT = Path("/Users/bobyang/WorkBuddy/2026-10-23-19-55-56/chinext-dividend-dashboard")
CB = ROOT / "data" / "cb"
RAW = CB / "raw"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"

# ---------- 数据加载 ----------
uni = {u["SECURITY_CODE"]: u for u in json.loads((CB / "universe.json").read_text())}
reb = json.loads((CB / "xq_rebalancing.json").read_text())
trades = []
for r in reb:
    d = datetime.fromtimestamp(r["created_at"] / 1000).strftime("%Y-%m-%d")
    for h in r.get("rebalancing_histories") or []:
        pw, tw = h.get("prev_weight") or 0, h.get("target_weight") or 0
        trades.append({"date": d, "code": h["stock_symbol"].replace("SH", "").replace("SZ", ""),
                       "name": h["stock_name"], "price": h["price"],
                       "kind": "buy" if (tw > 0 and pw <= 0) else ("sell" if (tw <= 0 and pw > 0) else "adj")})
buys = [t for t in trades if t["kind"] == "buy"]
codes_traded = sorted({t["code"] for t in trades})
print(f"traded bonds: {len(codes_traded)}, buys: {len(buys)}")

# ---------- 补抓成交量(腾讯, 仅交易过的债) ----------
VOLDIR = CB / "rawvol"; VOLDIR.mkdir(exist_ok=True)
def fetch_vol(code):
    fp = VOLDIR / f"{code}.json"
    if fp.exists(): return
    pref = "sh" if code.startswith(("10", "11")) else "sz"
    try:
        r = requests.get(f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={pref}{code},day,2022-01-01,2026-12-31,2000,",
                         headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"}, timeout=20)
        d = r.json().get("data", {}).get(pref + code, {})
        day = d.get("day") or []
        out = [[row[0], float(row[5])] for row in day]  # date, volume(手)
        fp.write_text(json.dumps(out))
    except Exception as e:
        print("vol fail", code, str(e)[:60])
with ThreadPoolExecutor(10) as ex:
    list(ex.map(fetch_vol, codes_traded))
print("volume fetched")

vol_db = {c: {row[0]: row[1] for row in json.loads((VOLDIR / f"{c}.json").read_text())}
          for c in codes_traded if (VOLDIR / f"{c}.json").exists()}

# ---------- 因子函数 ----------
raw_db = {}
def raw_of(code):
    if code not in raw_db:
        p = RAW / f"{code}.json"
        raw_db[code] = json.loads(p.read_text()) if p.exists() else None
    return raw_db[code]

def factor_row(code, date):
    s = raw_of(code)
    if not s: return None
    prev = None
    for row in s:
        if row[0] > date: break
        prev = row
    if not prev or prev[3] is None: return None
    d, close, swapv, prem = prev
    i = s.index(prev)
    mom20 = close / s[max(i - 20, 0)][1] - 1 if i >= 20 else None
    u = uni.get(code, {})
    listing = (u.get("LISTING_DATE") or "")[:10]
    tstart = (u.get("TRANSFER_START_DATE") or "")[:10]
    age = (datetime.strptime(date, "%Y-%m-%d") - datetime.strptime(listing, "%Y-%m-%d")).days if listing else None
    scale = u.get("ACTUAL_ISSUE_SCALE")
    rating = u.get("RATING")
    # 成交额(手*100*价格/1e8 -> 亿元) 用当日, 无则最近
    vol = vol_db.get(code, {}).get(d)
    amount = vol * close * 100 / 1e8 if vol else None
    return {"code": code, "price": close, "prem": prem, "dl": close + prem, "swapv": swapv,
            "age": age, "scale": scale, "rating": rating, "mom20": mom20, "amount": amount,
            "in_conv": (tstart and date >= tstart)}

# ---------- 当日全池索引: date -> [codes] ----------
pool_by_date = defaultdict(list)
for code in uni:
    s = raw_of(code)
    if not s: continue
    for row in s:
        if "2022-03-01" <= row[0] <= "2026-10-26" and row[3] is not None:
            pool_by_date[row[0]].append(code)
print("pool dates:", len(pool_by_date))

# ---------- 百分位对比 ----------
def pct_rank(vals, x):
    if x is None: return None
    return sum(1 for v in vals if v <= x) / len(vals)

factors = ["price", "prem", "dl", "swapv", "age", "scale", "mom20", "amount"]
agg = {f: [] for f in factors}
conv_in = 0; conv_total = 0
buy_rows = []
for t in buys:
    f = factor_row(t["code"], t["date"])
    if not f: continue
    pool = [factor_row(c, t["date"]) for c in pool_by_date.get(t["date"], [])]
    pool = [p for p in pool if p]
    if len(pool) < 50: continue
    rec = {"date": t["date"], "name": t["name"]}
    for k in factors:
        pv = [p[k] for p in pool if p[k] is not None]
        rec[k] = f[k]
        r = pct_rank(pv, f[k])
        if r is not None: agg[k].append(r)
    conv_total += 1
    if f["in_conv"]: conv_in += 1
    buy_rows.append(rec)

print("\n=== 买入组在当日全池中的百分位(50%=随机, >50%偏向高值) ===")
for k in factors:
    xs = [x for x in agg[k] if x is not None]
    if xs:
        xs.sort()
        print(f"  {k:8s}: 均值 {st.mean(xs)*100:5.1f}%  中位 {xs[len(xs)//2]*100:5.1f}%  P25 {xs[len(xs)//4]*100:5.1f}%  P75 {xs[len(xs)*3//4]*100:5.1f}%  n={len(xs)}")
print(f"\n买入时已进转股期: {conv_in}/{conv_total} = {conv_in/max(conv_total,1)*100:.0f}%")

# 规模与评级的绝对分布
scales = [f["scale"] for f in (factor_row(t["code"], t["date"]) for t in buys) if f and f["scale"]]
if scales:
    scales.sort()
    print(f"发行规模(亿): P25 {scales[len(scales)//4]:.1f}  中位 {scales[len(scales)//2]:.1f}  P75 {scales[len(scales)*3//4]:.1f}")
ratings = Counter((factor_row(t["code"], t["date"]) or {}).get("rating") for t in buys)
print("评级分布:", dict(ratings))

# ---------- 简单规则覆盖度 ----------
print("\n=== 规则覆盖度(买入组满足率 vs 全池基率=提升度) ===")
pool_stats = {k: [] for k in factors}
for d, codes in list(pool_by_date.items())[::7]:  # 抽样1/7天降计算
    for c in codes:
        f = factor_row(c, d)
        if f:
            for k in factors:
                if f[k] is not None: pool_stats[k].append(f[k])
def base_rate(k, lo, hi):
    xs = pool_stats[k]
    return sum(1 for x in xs if lo <= x < hi) / len(xs)
def buy_rate(k, lo, hi):
    xs = [b[k] for b in buy_rows if b.get(k) is not None]
    return sum(1 for x in xs if lo <= x < hi) / len(xs)
for k, lo, hi, label in [("price", 120, 135, "价格120-135"), ("price", 110, 130, "价格110-130"),
                          ("prem", 20, 200, "溢价率>20%"), ("prem", 40, 200, "溢价率>40%"),
                          ("scale", 0, 3, "规模<3亿"), ("scale", 0, 5, "规模<5亿"),
                          ("amount", 1, 1e9, "日成交额>1亿"), ("age", 180, 1e5, "上市>180天")]:
    br, brate = buy_rate(k, lo, hi), base_rate(k, lo, hi)
    lift = br / brate if brate > 0 else 0
    print(f"  {label:14s}: 买入组 {br*100:5.1f}%   全池 {brate*100:5.1f}%   提升 {lift:.1f}x")
