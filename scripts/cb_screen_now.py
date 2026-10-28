#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按"小规模+中价+转股期+溢价扩张信号"画像筛选当前市场标的（v2）
行情源: RPTA_WEB_KZZ_LS 单只历史(最新行=最新收盘/转股价值/溢价率)
画像: 发行规模≤5亿、价格110-145、已进转股期、非老三板
信号: 5日溢价扩张>3pp 且 未价格起飞(前3日涨幅<5%)
"""
import json, time, requests
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
TOKEN = "894050c76af8597a853f5b408b759f5d"
H = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}
TODAY = "2026-10-28"

def fetch_universe():
    rows, page = [], 1
    while True:
        r = requests.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={"reportName": "RPT_BOND_CB_LIST", "columns": "ALL", "pageSize": 500,
                    "pageNumber": page, "source": "WEB", "client": "WEB"}, headers=H, timeout=20)
        d = r.json()["result"]
        rows += d["data"]
        if page >= d["pages"]:
            break
        page += 1
    return rows

def fetch_recent(code, days=30):
    r = requests.get("https://datacenter-web.eastmoney.com/api/data/get",
        params={"sty": "ALL", "token": TOKEN, "st": "date", "sr": "1", "source": "WEB",
                "type": "RPTA_WEB_KZZ_LS", "filter": f'(zcode="{code}")', "p": "1", "ps": "8000"},
        headers=H, timeout=30)
    d = r.json().get("result") or {}
    out = []
    for row in d.get("data", []):
        dt = (row.get("DATE") or "")[:10]
        c, sv, so = row.get("FCLOSE"), row.get("SWAPVALUE"), row.get("SWAPOR")
        if not dt or c in (None, ""):
            continue
        out.append([dt, float(c), None if sv in (None, "") else float(sv),
                    None if so in (None, "") else float(so)])
    return code, out[-days:]

uni = fetch_universe()
listed = [u for u in uni if not u.get("DELIST_DATE") and u.get("LISTING_DATE")]
print(f"在市转债(LISTING+未DELIST): {len(listed)}")

# 第一步: 静态画像初筛(减少行情请求数)
pool = []
for u in listed:
    code = u.get("SECURITY_CODE") or ""
    if not code.startswith(("11", "12")):
        continue
    scale = u.get("ACTUAL_ISSUE_SCALE")
    tstart = (u.get("TRANSFER_START_DATE") or "9999")[:10]
    if scale is None or float(scale) > 5:
        continue
    if tstart > TODAY:
        continue  # 未进转股期
    pool.append({"code": code, "name": u.get("SECURITY_NAME_ABBR", ""),
                 "scale": round(float(scale), 2), "rating": u.get("RATING"),
                 "stock": u.get("CONVERT_STOCK_CODE"), "tstart": tstart})
print(f"规模≤5亿且已进转股期: {len(pool)} 只, 拉取近30日行情...")

def work(c):
    for _ in range(3):
        try:
            code, series = fetch_recent(c["code"])
            if not series:
                return None  # 无交易(可能已停/退)
            i = len(series) - 1
            last_dt, px = series[i][0], series[i][1]
            if last_dt < "2026-10-20":
                return None  # 长期无成交
            if not (110 <= px <= 145):
                return None
            def ret(k):
                j = i - k
                return (px / series[j][1] - 1) * 100 if j >= 0 and series[j][1] else None
            def premchg(k):
                j = i - k
                if j < 0 or series[i][3] is None or series[j][3] is None:
                    return None
                return series[i][3] - series[j][3]
            c.update({"price": px, "prem": series[i][3], "conv": series[i][2],
                      "r3": ret(3), "r5": ret(5), "r20": ret(20),
                      "p5": premchg(5), "p10": premchg(10), "last_date": last_dt})
            return c
        except Exception:
            time.sleep(0.5)
    return None

with ThreadPoolExecutor(max_workers=8) as ex:
    res = list(ex.map(work, pool))
cands = [c for c in res if c]
print(f"中价带(110-145)在市: {len(cands)} 只 (数据截至 {max(c['last_date'] for c in cands) if cands else '-'})")

signal = [c for c in cands if (c["p5"] or 0) > 3 and (c["r3"] or 0) < 5]
signal.sort(key=lambda x: -(x["p5"] or 0))
quiet = [c for c in cands if not ((c["p5"] or 0) > 3 and (c["r3"] or 0) < 5)]
quiet.sort(key=lambda x: x["price"])

def line(c):
    return (f"{c['code']:<8}{c['name']:<8}{c['price']:>7.2f}{(c['prem'] if c['prem'] is not None else 0):>7.1f}"
            f"{(c['p5'] or 0):>+9.1f}{(c['p10'] or 0):>+9.1f}{(c['r3'] or 0):>+8.1f}"
            f"  {c['scale']:.1f}亿  {c['rating']}")

print("\n========== A. 画像+溢价扩张苗头(5日溢价Δ>3pp且3日未起飞) ==========")
print(f"{'代码':<8}{'名称':<8}{'价格':>7}{'溢价%':>7}{'5日溢价Δ':>9}{'10日溢价Δ':>9}{'3日涨幅':>8}  规模  评级")
for c in signal:
    print(line(c))
if not signal:
    print("  (无)")

print("\n========== B. 符合画像但静默(埋伏候选池, 按价格升序, 前25) ==========")
for c in quiet[:25]:
    print(line(c))

json.dump({"as_of": max(c["last_date"] for c in cands) if cands else None,
           "all_candidates": cands, "signal": signal},
          open("data/cb/screen_result.json", "w"), ensure_ascii=False, indent=1)
print("\nsaved -> data/cb/screen_result.json")
