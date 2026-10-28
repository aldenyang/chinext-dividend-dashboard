#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可转债"小规模+溢价扩张"策略模拟盘
规则(源自ZH3068836规律提取+介入区间回测):
  选债画像: 发行规模≤5亿 / 价格110-145 / 已进转股期 / 非ST / 非老三板
  介入信号: 5日溢价扩张>3pp 且 前3日涨幅<5%(未起飞)
  退出规则: 持有≥20交易日 / 5日溢价收缩>5pp / 价格≥150 / 较成本-10%止损
  执行规范: T日收盘出信号 -> T+1收盘成交, 单边成本0.15%, 等权最多10只
用法: python3 scripts/cb_paper_trading.py   (每个交易日收盘后跑一次, 幂等)
"""
import json, os, time, sys, datetime
from concurrent.futures import ThreadPoolExecutor
import requests

ROOT = os.path.join(os.path.dirname(__file__), '..')
PAPER = os.path.join(ROOT, 'data', 'cb', 'paper')
CACHE = os.path.join(ROOT, 'data', 'cb', 'paper_cache')
REPORT = os.path.join(ROOT, 'reports', 'cb_paper_latest.md')
os.makedirs(PAPER, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
# 清理过期缓存(只留当日)
_today = datetime.date.today().isoformat()
for f in os.listdir(CACHE):
    if not f.startswith(_today):
        os.remove(os.path.join(CACHE, f))
CFG = json.load(open(os.path.join(PAPER, 'config.json')))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
TOKEN = "894050c76af8597a853f5b408b759f5d"
H = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}

# ---------- 数据 ----------
def cached(name, fn):
    p = os.path.join(CACHE, f'{_today}_{name}')
    if os.path.exists(p):
        return json.load(open(p))
    v = fn()
    json.dump(v, open(p, 'w'), ensure_ascii=False)
    return v

def fetch_universe():
    rows, page = [], 1
    while True:
        r = requests.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={"reportName": "RPT_BOND_CB_LIST", "columns": "ALL", "pageSize": 500,
                    "pageNumber": page, "source": "WEB", "client": "WEB"}, headers=H, timeout=20)
        d = r.json()["result"]; rows += d["data"]
        if page >= d["pages"]: break
        page += 1
    return rows

def fetch_hist(code, days=60):
    def _f():
        r = requests.get("https://datacenter-web.eastmoney.com/api/data/get",
            params={"sty": "ALL", "token": TOKEN, "st": "date", "sr": "1", "source": "WEB",
                    "type": "RPTA_WEB_KZZ_LS", "filter": f'(zcode="{code}")', "p": "1", "ps": "8000"},
            headers=H, timeout=30)
        d = r.json().get("result") or {}
        out = []
        for row in d.get("data", []):
            dt = (row.get("DATE") or "")[:10]
            c, so = row.get("FCLOSE"), row.get("SWAPOR")
            if not dt or c in (None, ""): continue
            out.append([dt, round(float(c), 3), None if so in (None, "") else round(float(so), 2)])
        return out[-days:]
    return cached(f'h_{code}.json', _f)

def fetch_bm(code):
    def _f():
        try:
            r = requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                params={"param": f"{code},day,,,10,qfq"}, headers=H, timeout=20)
            d = r.json()["data"][code]
            k = d.get("qfqday") or d.get("day")
            return [[x[0], float(x[2])] for x in k]
        except Exception:
            return []
    return cached(f'bm_{code}.json', _f)

# ---------- 指标 ----------
def metrics(series):
    if len(series) < 11: return None
    i = len(series) - 1
    px = series[i][1]; prem = series[i][2]
    def ret(k):
        j = i - k
        return (px / series[j][1] - 1) * 100 if j >= 0 and series[j][1] else None
    def premchg(k):
        j = i - k
        if j < 0 or prem is None or series[j][2] is None: return None
        return prem - series[j][2]
    return {"date": series[i][0], "price": px, "prem": prem,
            "r3": None if ret(3) is None else round(ret(3), 1),
            "r5": None if ret(5) is None else round(ret(5), 1),
            "p5": None if premchg(5) is None else round(premchg(5), 1),
            "p10": None if premchg(10) is None else round(premchg(10), 1)}

# ---------- 状态 ----------
def load(n, default):
    p = os.path.join(PAPER, n)
    return json.load(open(p)) if os.path.exists(p) else default

def save(n, v):
    json.dump(v, open(os.path.join(PAPER, n), 'w'), ensure_ascii=False, indent=1)

def log_trade(t):
    tr = load('trades.json', [])
    tr.append(t); save('trades.json', tr)

def close_on(hist, d):
    for row in hist:
        if row[0] == d: return row[1]
    return None

# ---------- 主流程 ----------
def main():
    uni = cached('universe.json', fetch_universe)
    listed = [u for u in uni if not u.get("DELIST_DATE") and u.get("LISTING_DATE")
              and (u.get("SECURITY_CODE") or "").startswith(("11", "12"))]
    pool = []
    for u in listed:
        scale = u.get("ACTUAL_ISSUE_SCALE")
        if scale is None or float(scale) > CFG["scale_max"]: continue
        if (u.get("TRANSFER_START_DATE") or "9999")[:10] > "2026-12-31": continue
        rating = u.get("RATING") or ""
        pool.append({"code": u["SECURITY_CODE"], "name": u.get("SECURITY_NAME_ABBR", ""),
                     "scale": round(float(scale), 2), "rating": rating,
                     "st": "sti" in rating if CFG["exclude_st"] else False})
    with ThreadPoolExecutor(max_workers=8) as ex:
        hists = dict(zip([c["code"] for c in pool], ex.map(fetch_hist, [c["code"] for c in pool])))
    # 处理日 = 全池最新交易日
    today = max((h[-1][0] for h in hists.values() if h), default=None)
    if not today:
        print("无行情数据"); return
    state = load('state.json', None)
    if state is None:
        state = {"cash": CFG["initial_cash"], "positions": {}, "pending": [],
                 "last_date": None, "started": today}
    if state["last_date"] == today:
        print(f"{today} 已处理过, 幂等退出"); return

    mets = {}
    for c in pool:
        h = hists[c["code"]]
        m = metrics(h)
        if m: mets[c["code"]] = {**c, **m}

    # ---- 1) 成交昨日挂单 (T+1收盘) ----
    fills, still_pending = [], []
    for od in state["pending"]:
        px = close_on(hists.get(od["code"], []), today)
        if px is None:
            still_pending.append(od); continue  # 停牌顺延
        if od["action"] == "buy":
            amt = od["amount"]
            shares = int(amt / (px * (1 + CFG["cost_rate"])) / 10) * 10
            if shares < 10:
                still_pending.append(od); continue
            cost = shares * px * (1 + CFG["cost_rate"])
            if cost > state["cash"] + 1:
                still_pending.append(od); continue
            state["cash"] -= cost
            pos = state["positions"].get(od["code"], {"code": od["code"], "name": od["name"],
                                                      "shares": 0, "cost_avg": 0, "entry_date": today})
            tot = pos["shares"] + shares
            pos["cost_avg"] = (pos["cost_avg"] * pos["shares"] + cost) / tot if tot else 0
            pos["shares"] = tot; pos["entry_date"] = od.get("entry_date") or today
            state["positions"][od["code"]] = pos
            fills.append({**od, "fill_date": today, "fill_price": px, "shares": shares, "amount": cost})
            log_trade({"date": today, **od, "fill_price": px, "shares": shares, "amount": round(cost, 2)})
        else:  # sell
            pos = state["positions"].get(od["code"])
            if not pos:
                continue
            proceeds = pos["shares"] * px * (1 - CFG["cost_rate"])
            state["cash"] += proceeds
            fills.append({**od, "fill_date": today, "fill_price": px, "shares": pos["shares"],
                          "amount": round(proceeds, 2)})
            log_trade({"date": today, **od, "fill_price": px, "shares": pos["shares"],
                       "amount": round(proceeds, 2), "pnl": round(proceeds - pos["cost_avg"] * pos["shares"], 2)})
            del state["positions"][od["code"]]
    state["pending"] = still_pending

    # ---- 2) 检查持仓退出信号 (今日出信号, 明日成交) ----
    pending_new = []
    for code, pos in state["positions"].items():
        m = mets.get(code); h = hists.get(code, [])
        if not m:
            continue
        idx = {r[0]: k for k, r in enumerate(h)}
        hold_days = idx.get(today, 0) - idx.get(pos["entry_date"], 0)
        reason = None
        if hold_days >= CFG["exit_hold_days"]: reason = f"持有满{hold_days}日"
        elif (m["p5"] or 0) < CFG["exit_prem_shrink"]: reason = f"溢价5日收缩{m['p5']:.0f}pp"
        elif m["price"] >= CFG["exit_price_hi"]: reason = f"价格起飞至{m['price']:.1f}"
        elif (m["price"] / pos["cost_avg"] - 1) * 100 < CFG["stop_loss"]: reason = "止损"
        if reason:
            pending_new.append({"action": "sell", "code": code, "name": pos["name"],
                                "reason": reason, "signal_date": today})

    # ---- 3) 生成新买入信号 ----
    held = set(state["positions"]) | {o["code"] for o in pending_new if o["action"] == "sell"}
    queued_buys = sum(1 for o in state["pending"] if o["action"] == "buy")
    slots = CFG["max_holdings"] - len(state["positions"]) - queued_buys - sum(1 for o in pending_new if o["action"] == "sell")
    if slots > 0:
        buys = [m for c, m in mets.items()
                if c not in held and not m["st"]
                and CFG["price_min"] <= m["price"] <= CFG["price_max"]
                and (m["prem"] if m["prem"] is not None else 999) <= CFG["prem_max"]
                and (m["p5"] or 0) > CFG["prem_exp_min"]
                and (m["r3"] or 0) < CFG["takeoff_r3"]]
        buys.sort(key=lambda x: -(x["p5"] or 0))
        cash_per_slot = state["cash"] / max(slots, 1)
        for b in buys[:max(slots, 0)]:
            pending_new.append({"action": "buy", "code": b["code"], "name": b["name"],
                                "amount": round(cash_per_slot, 2), "reason": f"溢价5日+{b['p5']:.0f}pp",
                                "signal_date": today})

    state["pending"] += pending_new
    state["last_date"] = today

    # ---- 4) 净值 ----
    pos_value = sum(close_on(hists[c], today) * p["shares"]
                    for c, p in state["positions"].items() if close_on(hists[c], today))
    nav = state["cash"] + pos_value
    bm = fetch_bm(CFG["benchmark"])
    bm_row = next((x for x in bm if x[0] == today), None)
    navs = load('nav.json', [])
    base_nav = CFG["initial_cash"]
    navs.append({"date": today, "nav": round(nav, 2),
                 "ret": round((nav / base_nav - 1) * 100, 2),
                 "bm_close": bm_row[1] if bm_row else None})
    save('nav.json', navs); save('state.json', state)

    # ---- 5) 报告 ----
    first_bm = bm[0][1] if bm else None
    lines = [f"# 可转债模拟盘日报  {today}", "",
             f"- 净值: **{nav:,.0f}** ({(nav/CFG['initial_cash']-1)*100:+.2f}%)  现金 {state['cash']:,.0f}",
             f"- 基准(中证转债): {bm_row[1] if bm_row else 'N/A'}", "",
             "## 持仓", "", "| 代码 | 名称 | 张数 | 成本 | 现价 | 盈亏% | 溢价% | 5日溢价Δ |", "|---|---|---|---|---|---|---|---|"]
    for c, p in sorted(state["positions"].items()):
        px = close_on(hists.get(c, []), today) or 0
        m = mets.get(c, {})
        pnl = (px / p["cost_avg"] - 1) * 100 if p["cost_avg"] else 0
        lines.append(f"| {c} | {p['name']} | {p['shares']} | {p['cost_avg']:.2f} | {px:.2f} | {pnl:+.1f} | {m.get('prem','-')} | {m.get('p5','-')} |")
    lines += ["", "## 明日待成交", "", "| 动作 | 代码 | 名称 | 金额/理由 |", "|---|---|---|---|"]
    for od in state["pending"]:
        lines.append(f"| {od['action']} | {od['code']} | {od['name']} | {od.get('amount', od.get('reason',''))} |")
    open(REPORT, 'w').write("\n".join(lines))

    print(f"=== {today} 已处理 ===")
    print(f"净值 {nav:,.0f} ({(nav/CFG['initial_cash']-1)*100:+.2f}%)  持仓 {len(state['positions'])}  待成交 {len(state['pending'])}")
    for f in fills:
        print(f"  成交: {f['action'].upper():4s} {f['name']} {f['shares']}张 @{f['fill_price']} ({f.get('reason','')})")
    for od in pending_new:
        print(f"  挂单: {od['action'].upper():4s} {od['name']} ({od.get('reason','')})")

if __name__ == '__main__':
    main()
