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
    """按日缓存; 但当日 15:10(北京时间) 前取的快照在收盘后失效, 避免盘中午跑挡住收盘数据"""
    p = os.path.join(CACHE, f'{_today}_{name}')
    tz = datetime.timezone(datetime.timedelta(hours=8))
    if os.path.exists(p):
        try:
            box = json.load(open(p))
            if box.get('d') == _today:
                ts = box.get('ts', 0)
                hour = datetime.datetime.fromtimestamp(ts, tz=tz).hour
                if hour >= 15 or datetime.datetime.now(tz).hour < 15:
                    return box['v']
        except Exception:
            pass
    v = fn()
    json.dump({'d': _today, 'ts': time.time(), 'v': v}, open(p, 'w'), ensure_ascii=False)
    return v

def _retry(fn, attempts=4, wait=2):
    """网络请求统一重试: 偶发读超时不应杀死整个引擎"""
    last = None
    for k in range(attempts):
        try:
            return fn()
        except Exception as e:
            last = e
            time.sleep(wait * (k + 1))
    raise last

def fetch_universe():
    rows, page = [], 1
    while True:
        r = _retry(lambda: requests.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={"reportName": "RPT_BOND_CB_LIST", "columns": "ALL", "pageSize": 500,
                    "pageNumber": page, "source": "WEB", "client": "WEB"}, headers=H, timeout=20))
        d = r.json()["result"]; rows += d["data"]
        if page >= d["pages"]: break
        page += 1
    return rows

def fetch_hist(code, days=60):
    def _f():
        r = _retry(lambda: requests.get("https://datacenter-web.eastmoney.com/api/data/get",
            params={"sty": "ALL", "token": TOKEN, "st": "date", "sr": "1", "source": "WEB",
                    "type": "RPTA_WEB_KZZ_LS", "filter": f'(zcode="{code}")', "p": "1", "ps": "8000"},
            headers=H, timeout=30))
        d = r.json().get("result") or {}
        out = []
        for row in d.get("data", []):
            dt = (row.get("DATE") or "")[:10]
            c, so = row.get("FCLOSE"), row.get("SWAPOR")
            if not dt or c in (None, ""): continue
            out.append([dt, round(float(c), 3), None if so in (None, "") else round(float(so), 2)])
        return out[-days:]
    return cached(f'h_{code}.json', _f)

def fetch_bm(code, count=250):
    def _f():
        r = _retry(lambda: requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
            params={"param": f"{code},day,,,{count},qfq"}, headers=H, timeout=20))
        d = r.json()["data"][code]
        k = d.get("qfqday") or d.get("day")
        return [[x[0], float(x[2])] for x in k]
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
    # 数据毛刺防护: 丢弃任何晚于北京当前日期的历史行(接口异常时会偶发未来日期, 污染处理日)
    _bj_date = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
    hists = {c: [r for r in h if r[0] <= _bj_date] for c, h in hists.items()}
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
    # 规则(源自卖出法证+反事实验证, 规则E):
    #   1) 脉冲移动止盈: 持有期涨幅曾≥pulse_gain 后, 从峰值回撤≥exit_pullback -> 卖
    #   2) 无脉冲时间退出: 持有≥nopulse_days 且段内峰值涨幅<nopulse_max_gain -> 卖
    #   无绝对止损(反事实显示止损拖累收益且规则2已收窄尾部风险)
    pending_new = []
    for code, pos in state["positions"].items():
        m = mets.get(code); h = hists.get(code, [])
        if not m:
            continue
        px = m["price"]
        pos["peak"] = max(pos.get("peak") or px, px)
        gain_peak = pos["peak"] / pos["cost_avg"] - 1 if pos["cost_avg"] else 0
        pullback = 1 - px / pos["peak"] if pos["peak"] else 0
        idx = {r[0]: k for k, r in enumerate(h)}
        hold_days = idx.get(today, 0) - idx.get(pos["entry_date"], 0)
        reason = None
        if gain_peak >= CFG["pulse_gain"] and pullback >= CFG["exit_pullback"]:
            reason = f"脉冲止盈: 峰值+{gain_peak*100:.0f}%后回撤{pullback*100:.0f}%"
        elif hold_days >= CFG["nopulse_days"] and gain_peak < CFG["nopulse_max_gain"]:
            reason = f"{hold_days}日无脉冲(峰值+{gain_peak*100:.1f}%)"
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
    BMS = CFG.get("benchmarks") or {CFG.get("benchmark", "sh000832"): "中证转债"}
    bms = {}
    for bm_code in BMS:
        try:
            bm = fetch_bm(bm_code)
            row = next((x for x in bm if x[0] == today), None)
            if row:
                bms[bm_code] = row[1]
        except Exception:
            pass  # 单个基准失败不阻塞模拟盘
    navs = load('nav.json', [])
    base_nav = CFG["initial_cash"]
    navs.append({"date": today, "nav": round(nav, 2),
                 "ret": round((nav / base_nav - 1) * 100, 2),
                 "bm": bms, "bm_close": bms.get("sh000832")})
    save('nav.json', navs); save('state.json', state)

    # ---- 5.5) 导出 dashboard 数据 ----
    pub = {"updated": today, "config": CFG, "benchmarks": BMS,
           "nav": navs,
           "cash": round(state["cash"], 2),
           "nav_now": round(nav, 2),
           "positions": [{"code": c, "name": p["name"], "shares": p["shares"],
                          "cost": round(p["cost_avg"], 2),
                          "price": close_on(hists.get(c, []), today),
                          "pnl_pct": round((close_on(hists.get(c, []), today) or 0) / p["cost_avg"] * 100 - 100, 1)
                          if p["cost_avg"] else 0,
                          "entry_date": p["entry_date"]} for c, p in state["positions"].items()],
           "pending": state["pending"],
           "trades": load('trades.json', [])[-50:]}
    json.dump(pub, open(os.path.join(ROOT, 'public', 'cb_paper.json'), 'w'), ensure_ascii=False)

    # ---- 5) 报告 ----
    lines = [f"# 可转债模拟盘日报  {today}", "",
             f"- 净值: **{nav:,.0f}** ({(nav/CFG['initial_cash']-1)*100:+.2f}%)  现金 {state['cash']:,.0f}",
             f"- 基准收盘: " + "  ".join(f"{BMS[c]} {v:.2f}" for c, v in bms.items()), "",
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
