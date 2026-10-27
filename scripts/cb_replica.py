# -*- coding: utf-8 -*-
"""可转债多因子轮动策略(ZH3068836)公开因子复刻
数据: 东财数据中心 RPT_BOND_CB_LIST(全量含退市) + RPTA_WEB_KZZ_LS(单只全历史价格/转股价值/溢价率)
策略: 双低(价格+溢价率)Top10 等权, 月度首个交易日选债 T+1 收盘调仓
"""
import json, os, time, math, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests

ROOT = Path("/Users/bobyang/WorkBuddy/2026-10-23-19-55-56/chinext-dividend-dashboard")
CB_DIR = ROOT / "data" / "cb"
RAW_DIR = CB_DIR / "raw"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
TOKEN = "894050c76af8597a853f5b408b759f5d"
TD = 244
RF = 0.015

def fetch_universe():
    rows, page = [], 1
    while True:
        r = requests.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={"reportName": "RPT_BOND_CB_LIST", "columns": "ALL",
                    "pageSize": 500, "pageNumber": page, "source": "WEB", "client": "WEB"},
            headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}, timeout=20)
        d = r.json()["result"]
        rows += d["data"]
        if page >= d["pages"]:
            break
        page += 1
    return rows

def fetch_one(code: str):
    """单只转债全历史: [(date, close, swapvalue, swapor%), ...]"""
    r = requests.get(
        "https://datacenter-web.eastmoney.com/api/data/get",
        params={"sty": "ALL", "token": TOKEN, "st": "date", "sr": "1",
                "source": "WEB", "type": "RPTA_WEB_KZZ_LS",
                "filter": f'(zcode="{code}")', "p": "1", "ps": "8000"},
        headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}, timeout=30)
    d = r.json().get("result") or {}
    out = []
    for row in d.get("data", []):
        dt = (row.get("DATE") or "")[:10]
        close = row.get("FCLOSE")
        sv, so = row.get("SWAPVALUE"), row.get("SWAPOR")
        if not dt or close in (None, ""):
            continue
        out.append([dt, round(float(close), 3),
                    None if sv in (None, "") else round(float(sv), 3),
                    None if so in (None, "") else round(float(so), 3)])
    return code, out

def build_dataset():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    uni_path = CB_DIR / "universe.json"
    if uni_path.exists():
        universe = json.loads(uni_path.read_text())
    else:
        universe = fetch_universe()
        uni_path.write_text(json.dumps(universe, ensure_ascii=False))
    # 保留: 债券代码/简称/上市日期/退市日期/正股代码/评级
    uni = [{"code": u["SECURITY_CODE"], "name": u.get("SECURITY_NAME_ABBR", ""),
            "listing": (u.get("LISTING_DATE") or "")[:10],
            "delist": (u.get("DELIST_DATE") or "")[:10] or None,
            "stock": u.get("CONVERT_STOCK_CODE"), "rating": u.get("RATING")}
           for u in universe if u.get("SECURITY_CODE")]
    # 上市日期过滤: 只留 2021-01-01 前上市或之后上市的都留(运行时按日判断), 但去掉无上市日期的
    uni = [u for u in uni if u["listing"]]
    print(f"universe: {len(uni)} bonds")
    # 逐只抓历史
    todo = [u["code"] for u in uni if not (RAW_DIR / f"{u['code']}.json").exists()]
    print(f"to fetch: {len(todo)}")
    errs = []
    def work(code):
        for attempt in range(3):
            try:
                _, series = fetch_one(code)
                (RAW_DIR / f"{code}.json").write_text(json.dumps(series))
                return code, len(series)
            except Exception as e:
                time.sleep(1 + attempt)
        return code, -1
    done = 0
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(work, c): c for c in todo}
        for f in as_completed(futs):
            code, n = f.result()
            done += 1
            if n < 0:
                errs.append(code)
            if done % 200 == 0:
                print(f"  fetched {done}/{len(todo)}")
    if errs:
        print("FAILED:", errs[:20], "total", len(errs))
    return uni

# ---------------- 回测 ----------------
def load_series(code):
    p = RAW_DIR / f"{code}.json"
    if not p.exists():
        return None
    rows = json.loads(p.read_text())
    if len(rows) < 30:
        return None
    return rows  # [[date, close, swapvalue, swapor], ...] 已按日期升序

def metrics(dates, vals, rs):
    n = len(dates)
    days = max((n - 1), 1)
    total = vals[-1]
    cagr = total ** (TD / days) - 1
    peak, mdd = 1.0, 0.0
    for v in vals:
        peak = max(peak, v)
        mdd = max(mdd, 1 - v / peak)
    mean = sum(rs) / len(rs)
    vol = math.sqrt(sum((x - mean) ** 2 for x in rs) / (len(rs) - 1)) * math.sqrt(TD)
    sharpe = (cagr - RF) / vol if vol > 0 else 0
    calmar = cagr / mdd if mdd > 0 else 0
    return {"cagr": cagr, "vol": vol, "mdd": mdd, "sharpe": sharpe, "calmar": calmar,
            "total": total, "start": dates[0], "end": dates[-1]}

def backtest(uni, calendar, start, end, topn=10, band=None, cost=0.001, min_days=20, weekly=False):
    """band=(lo,hi) 价格过滤; 调仓: weekly=False 月度首个交易日, True 每周首个交易日"""
    ser = {}
    for u in uni:
        s = load_series(u["code"])
        if s:
            ser[u["code"]] = s
    cal = [d for d in calendar if start <= d <= end]
    # 每只债: date->index 映射与上市日期
    listing = {u["code"]: u["listing"] for u in uni}
    idx_of = {c: {r[0]: i for i, r in enumerate(s)} for c, s in ser.items()}
    # 调仓日: monthly=每月首个交易日, weekly=每周首个交易日
    rebal_flags = set()
    seen = set()
    for d in cal:
        if weekly:
            key = d[:7] + "-W" + str((int(d[8:10]) + 6) // 7)
        else:
            key = d[:7]
        if key not in seen:
            seen.add(key)
            rebal_flags.add(d)
    hold, weights = [], 1.0 / topn
    vals, rs, dates_used = [1.0], [], []
    last_px = {}
    pending = None  # (signal_date, picks) 待 T+1 执行
    for t, d in enumerate(cal):
        # 1) 执行昨日信号(今日收盘成交)
        day_ret = None
        if pending is not None:
            sig_d, picks = pending
            pending = None
            # 换手成本
            old = set(hold)
            new = set(picks)
            turned = len(old ^ new) / max(len(old) | len(new), 1)
            v = vals[-1] * (1 - cost * turned * 2)  # 双边
            vals[-1] = v
            hold = picks
        # 2) 当日收益 = 持仓等权日收益
        r = 0.0
        live = 0
        for c in hold:
            s = ser.get(c)
            if s is None:
                continue
            ii = idx_of[c].get(d)
            if ii is not None and ii > 0:
                px = ser[c][ii][1]
                prev_px = ser[c][ii - 1][1]
                r += weights * (px / prev_px - 1)
                live += 1
            # 停牌/退市当日: 贡献 0
        vals.append(vals[-1] * (1 + r))
        rs.append(r)
        dates_used.append(d)
        # 3) 产生调仓信号(T 收盘选, T+1 执行)
        if d in rebal_flags:
            cands = []
            for c, s in ser.items():
                if listing.get(c, "9999") > d:
                    continue
                ii = idx_of[c].get(d)
                if ii is None or ii < min_days:
                    continue
                px, so = s[ii][1], s[ii][3]
                if px is None or so is None:
                    continue
                if band and not (band[0] <= px <= band[1]):
                    continue
                cands.append((px + so, c, px))
            cands.sort()
            pending = (d, [c for _, c, _ in cands[:topn]])
    m = metrics(dates_used, vals, rs)
    return m, dates_used, vals

def yearly_table(dates, vals, extra=None):
    out = {}
    for i, d in enumerate(dates):
        y = d[:4]
        if y not in out:
            out[y] = vals[i]  # 年内第一点
        out[y + "_end"] = vals[i]
    return out

def main():
    uni = build_dataset()
    # 只保留沪深正常交易板块的转债(110/111/113/118/123/127/128...)，
    # 剔除 404xxx 等退市后老三板债(价格数据为脏数据且个人投资者不可正常交易)
    uni = [u for u in uni if u["code"][:2] in ("11", "12")]
    print(f"tradeable universe: {len(uni)}")
    # 主交易日历: 用中证转债(已在项目缓存) 或聚合所有债的日期
    idx_path = ROOT / "data" / "sh000832.json"
    cal = sorted({r["date"] for r in json.loads(idx_path.read_text())})
    START, END = "2022-03-07", "2026-10-26"
    print(f"\n=== 复刻回测 {START} ~ {END} ===\n")
    results = {}
    for label, kw in [
        ("A_纯双低Top10_月度", dict()),
        ("B_中价105-130双低Top10_月度", dict(band=(105, 130))),
        ("C_双低Top20_月度", dict(topn=20)),
        ("D_中价105-130双低Top10_周度", dict(band=(105, 130), weekly=True)),
        ("E_纯双低Top10_月度_成本0.2%", dict(cost=0.002)),
        ("F_中价双低Top10_月度_成本0.3%", dict(band=(105, 130), cost=0.003)),
    ]:
        m, dates, vals = backtest(uni, cal, START, END, **kw)
        results[label] = m
        print(f"{label:32s} CAGR {m['cagr']*100:6.2f}%  波动 {m['vol']*100:5.1f}%  回撤 {m['mdd']*100:6.1f}%  夏普 {m['sharpe']:.2f}  Calmar {m['calmar']:.2f}  期末 {m['total']:.2f}x")
    # 最优变体的年度收益 vs 中证转债
    m, dates, vals = backtest(uni, cal, START, END, band=(105, 130))
    ytab = yearly_table(dates, vals)
    idx = {r["date"]: r["close"] for r in json.loads(idx_path.read_text())}
    print("\n年度收益(变体B 中价双低Top10) vs 中证转债:")
    ys = sorted(set(d[:4] for d in dates))
    all_d = sorted(idx)
    for y in ys:
        y0 = f"{y}_end"
        prev = ytab.get(f"{int(y)-1}_end", 1.0)
        strat = ytab.get(y0, 1.0) / prev - 1
        iys = [d for d in dates if d.startswith(y)]
        pd0 = next((x for x in reversed(all_d) if x < iys[0]), iys[0])
        i_r = idx[iys[-1]] / idx[pd0] - 1
        print(f"  {y}: 策略 {strat*100:7.2f}%   指数 {i_r*100:7.2f}%   超额 {(strat-i_r)*100:+7.2f}pp")
    (CB_DIR / "backtest-replica-result.json").write_text(json.dumps(
        {"window": [START, END], "results": results}, ensure_ascii=False, indent=1))
    print("\nsaved -> data/cb/backtest-replica-result.json")

if __name__ == "__main__":
    main()
