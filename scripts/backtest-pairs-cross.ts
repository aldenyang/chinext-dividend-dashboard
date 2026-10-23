/**
 * 跨市场资产对子回测：检验"比值 + 滚动分位切换"能否推广到跨市场资产
 *
 * 数据与口径：
 * - 两腿用场内 ETF 前复权日收盘（腾讯财经接口），前复权近似全收益
 * - QDII/商品 ETF 以人民币计价，汇率已内嵌（对国内投资者即真实可得回报）
 * - 已知噪声：QDII ETF 溢价波动（尤其纳指 ETF）、ETF 跟踪误差、样本仅约 13 年
 *
 * 对子（共同历史 2013-07-29 起，滚动 5 年窗口后评估期约 8 年）：
 *   X1 股与美股：沪深300ETF(510300) / 纳指ETF(513100)
 *   X2 股与金：沪深300ETF(510300) / 黄金ETF(518880)
 *   X3 美股与金：纳指ETF(513100) / 黄金ETF(518880)
 *
 * 信号：两腿比值滚动 1220 交易日分位 <20% 持分子腿 / >80% 持分母腿
 * 执行：T 收盘信号 T+1 持仓，换仓单边成本 0.15%
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest-pairs-cross-result.json');

const API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const COST = 0.0015;
const TRADING_DAYS = 244;
const ROLL_WINDOW = 1220;
const ROLL_LOW = 0.2;
const ROLL_HIGH = 0.8;
const RF = 0.015;

interface Quote {
  date: string;
  close: number;
}
type Leg = 'growth' | 'dividend' | 'mix';

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 腾讯前复权日收盘，按 3 年分片抓全历史 */
async function loadQfq(symbol: string): Promise<Quote[]> {
  const cachePath = path.join(DATA_DIR, `${symbol}-qfq.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Quote[];
    console.log(`[cache] ${symbol}: ${cached.length} 条（${cached[0].date} ~ ${cached[cached.length - 1].date}）`);
    return cached;
  }
  const out: Quote[] = [];
  let segBegin = '2012-01-01';
  const segEnd = new Date().toISOString().slice(0, 10);
  while (segBegin <= segEnd) {
    const y = Number(segBegin.slice(0, 4)) + 3;
    const segLast = `${y}${segBegin.slice(4)}` < segEnd ? `${y}${segBegin.slice(4)}` : segEnd;
    const json = (await fetchJson(`${API}?param=${symbol},day,${segBegin},${segLast},800,qfq`)) as {
      code: number;
      data: Record<string, { qfqday?: string[][]; day?: string[][] }>;
    };
    if (json.code !== 0) throw new Error(`${symbol} code=${json.code}`);
    const rows = json.data[symbol]?.qfqday ?? json.data[symbol]?.day ?? [];
    for (const r of rows) {
      const close = Number(r[2]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(close) && close > 0) {
        out.push({ date: r[0], close });
      }
    }
    segBegin = `${y + 1}-01-01`;
  }
  // 去重排序
  const seen = new Set<string>();
  const merged = out.filter((r) => !seen.has(r.date) && seen.add(r.date));
  merged.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(cachePath, JSON.stringify(merged));
  console.log(`[fetch] ${symbol}: ${merged.length} 条（${merged[0].date} ~ ${merged[merged.length - 1].date}）`);
  return merged;
}

function rollingSignals(ratio: number[]): (Leg | null)[] {
  const sig: (Leg | null)[] = [];
  for (let i = 0; i < ratio.length; i++) {
    if (i + 1 < ROLL_WINDOW) {
      sig.push(null);
      continue;
    }
    let count = 0;
    for (let j = i - ROLL_WINDOW + 1; j <= i; j++) {
      if (ratio[j] <= ratio[i]) count++;
    }
    const p = count / ROLL_WINDOW;
    sig.push(p < ROLL_LOW ? 'growth' : p > ROLL_HIGH ? 'dividend' : null);
  }
  return sig;
}

function positionsFromSignals(signals: (Leg | null)[]): Leg[] {
  const pos: Leg[] = ['mix'];
  let desired: Leg = 'mix';
  for (let i = 1; i < signals.length; i++) {
    const s = signals[i - 1];
    if (s !== null) desired = s;
    pos.push(desired);
  }
  return pos;
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

interface Metrics {
  name: string;
  cagr: number;
  vol: number;
  sharpe0: number;
  sharpeRf: number;
  maxDrawdown: number;
  switches: number;
  finalMultiple: number;
}

function evaluate(
  name: string,
  dates: string[],
  aRet: number[],
  bRet: number[],
  positions: Leg[],
  startIdx: number,
): Metrics {
  let value = 1;
  let peak = 1;
  let maxDd = 0;
  let switches = 0;
  const rets: number[] = [];
  for (let i = startIdx; i < dates.length; i++) {
    const pos = positions[i];
    if (i > startIdx && pos !== positions[i - 1]) {
      value *= 1 - COST;
      switches++;
    }
    const r =
      pos === 'growth' ? aRet[i] : pos === 'dividend' ? bRet[i] : 0.5 * aRet[i] + 0.5 * bRet[i];
    value *= 1 + r;
    rets.push(r);
    if (value > peak) peak = value;
    const dd = 1 - value / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const days = dates.length - startIdx;
  const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  return {
    name,
    cagr,
    vol,
    sharpe0: vol > 0 ? cagr / vol : 0,
    sharpeRf: vol > 0 ? (cagr - RF) / vol : 0,
    maxDrawdown: maxDd,
    switches,
    finalMultiple: value,
  };
}

function evaluateRebalance(dates: string[], aRet: number[], bRet: number[], startIdx: number): Metrics {
  let value = 1;
  let peak = 1;
  let maxDd = 0;
  let wa = 0.5;
  let wb = 0.5;
  let curYear = dates[startIdx].slice(0, 4);
  const rets: number[] = [];
  for (let i = startIdx; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    if (y !== curYear) {
      curYear = y;
      wa = 0.5;
      wb = 0.5;
    }
    const r = wa * aRet[i] + wb * bRet[i];
    wa = (wa * (1 + aRet[i])) / (1 + r);
    wb = (wb * (1 + bRet[i])) / (1 + r);
    value *= 1 + r;
    rets.push(r);
    if (value > peak) peak = value;
    const dd = 1 - value / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const days = dates.length - startIdx;
  const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  return {
    name: '基准：50/50 年度再平衡',
    cagr,
    vol,
    sharpe0: cagr / vol,
    sharpeRf: (cagr - RF) / vol,
    maxDrawdown: maxDd,
    switches: 0,
    finalMultiple: value,
  };
}

const PAIRS = [
  { key: 'X1', label: 'X1 境内外股：沪深300ETF / 纳指ETF', symA: 'sh510300', nameA: '沪深300ETF', symB: 'sh513100', nameB: '纳指ETF' },
  { key: 'X2', label: 'X2 股与金：沪深300ETF / 黄金ETF', symA: 'sh510300', nameA: '沪深300ETF', symB: 'sh518880', nameB: '黄金ETF' },
  { key: 'X3', label: 'X3 美股与金：纳指ETF / 黄金ETF', symA: 'sh513100', nameA: '纳指ETF', symB: 'sh518880', nameB: '黄金ETF' },
];

const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  caliber: 'ETF前复权收盘（近似全收益），腾讯财经；汇率内嵌；QDII溢价噪声未剔除',
  pairs: {},
};

const cache = new Map<string, Quote[]>();

for (const p of PAIRS) {
  console.log(`\n================ ${p.label} ================`);
  for (const s of [p.symA, p.symB]) {
    if (!cache.has(s)) cache.set(s, await loadQfq(s));
  }
  const a = cache.get(p.symA)!;
  const b = cache.get(p.symB)!;
  const bMap = new Map(b.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const closeA: number[] = [];
  const closeB: number[] = [];
  for (const r of a) {
    const cb = bMap.get(r.date);
    if (cb === undefined) continue;
    dates.push(r.date);
    closeA.push(r.close);
    closeB.push(cb);
  }
  console.log(`[align] ${dates.length} 个交易日（${dates[0]} ~ ${dates[dates.length - 1]}）`);
  if (dates.length < ROLL_WINDOW + 100) {
    console.log('[skip] 共同历史不足');
    continue;
  }

  const aRet: number[] = [0];
  const bRet: number[] = [0];
  for (let i = 1; i < dates.length; i++) {
    aRet.push(closeA[i] / closeA[i - 1] - 1);
    bRet.push(closeB[i] / closeB[i - 1] - 1);
  }
  const ratio = dates.map((_, i) => closeA[i] / closeB[i]);

  const corrAll = corr(aRet.slice(1), bRet.slice(1));
  const n5 = Math.min(1212, aRet.length - 1);
  const corr5y = corr(aRet.slice(-n5), bRet.slice(-n5));
  console.log(`[跷跷板检验] 相关性：全窗口 ${corrAll.toFixed(3)}｜近5年 ${corr5y.toFixed(3)}`);

  const pos = positionsFromSignals(rollingSignals(ratio));
  const startIdx = Math.min(ROLL_WINDOW, dates.length - 2);

  const rows: Metrics[] = [
    evaluate(`轮动：${p.nameA}/${p.nameB} 比值分位20/80`, dates, aRet, bRet, pos, startIdx),
    evaluateRebalance(dates, aRet, bRet, startIdx),
    evaluate(`基准：100% ${p.nameA}`, dates, aRet, bRet, dates.map(() => 'growth' as Leg), startIdx),
    evaluate(`基准：100% ${p.nameB}`, dates, aRet, bRet, dates.map(() => 'dividend' as Leg), startIdx),
  ];

  const w = [40, 9, 8, 9, 9, 9, 7, 9];
  console.log(`=== 评估窗口（${dates[startIdx]} ~ ${dates[dates.length - 1]}，${dates.length - startIdx} 个交易日）===`);
  console.log(['策略', 'CAGR', '波动', '夏普0', '夏普rf', '最大回撤', '换手', '期末倍数'].map((h, i) => h.padEnd(w[i])).join(''));
  for (const m of rows) {
    console.log(
      [
        m.name,
        `${(m.cagr * 100).toFixed(2)}%`,
        `${(m.vol * 100).toFixed(2)}%`,
        m.sharpe0.toFixed(2),
        m.sharpeRf.toFixed(2),
        `${(m.maxDrawdown * 100).toFixed(2)}%`,
        m.switches,
        m.finalMultiple.toFixed(3),
      ]
        .map((c, i) => String(c).padEnd(w[i]))
        .join(''),
    );
  }

  const trades: string[] = [];
  let openLeg: 'growth' | 'dividend' | null = null;
  let openIdx = 0;
  for (let i = startIdx; i < dates.length; i++) {
    if (pos[i] === pos[i - 1]) continue;
    if (openLeg && pos[i] !== openLeg) {
      const ret = openLeg === 'growth' ? closeA[i] / closeA[openIdx] - 1 : closeB[i] / closeB[openIdx] - 1;
      trades.push(`${openLeg === 'growth' ? p.nameA : p.nameB} ${dates[openIdx]}→${dates[i]} ${(ret * 100).toFixed(1)}%`);
      openLeg = null;
    }
    if (pos[i] === 'growth' || pos[i] === 'dividend') {
      openLeg = pos[i] as 'growth' | 'dividend';
      openIdx = i;
    }
  }
  if (openLeg) {
    const last = dates.length - 1;
    const ret = openLeg === 'growth' ? closeA[last] / closeA[openIdx] - 1 : closeB[last] / closeB[openIdx] - 1;
    trades.push(`${openLeg === 'growth' ? p.nameA : p.nameB} ${dates[openIdx]}→持仓中 ${(ret * 100).toFixed(1)}%`);
  }
  console.log(`[交易明细] ${trades.length} 笔`);
  for (const t of trades) console.log('  ' + t);

  (results.pairs as Record<string, unknown>)[p.key] = {
    label: p.label,
    corrAll,
    corr5y,
    window: [dates[startIdx], dates[dates.length - 1]],
    metrics: rows,
    trades,
  };
}

fs.writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
console.log(`\n[done] ${path.relative(ROOT, RESULT_PATH)}`);
