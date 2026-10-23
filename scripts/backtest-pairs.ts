/**
 * 多对子风格轮动回测：检验"比值 + 滚动分位切换"思路能否推广到其他指数对
 *
 * 方法（与 S6 完全同框架）：
 * - 两腿都用全收益指数（TR），比值本身无股息漂移失真
 * - 信号：比值滚动 1220 交易日分位 <20% 持腿A（分子） / >80% 持腿B（分母） / 区间维持
 * - 执行：T 收盘信号 T+1 持仓，换仓单边成本 0.15%
 * - 基准：50/50 年度再平衡；100% 各腿
 * - 附加检验：两腿日收益相关系数（验证"跷跷板"前提）
 *
 * 对子：
 *   P1 大小盘：沪深300全收益(H00300) / 中证1000全收益(H00852)
 *   P2 成长价值：300成长全收益(H00918) / 300价值全收益(H00919)
 *
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCsindexDailyClose } from './datasource/csindex.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest-pairs-result.json');

const COST = 0.0015;
const TRADING_DAYS = 244;
const ROLL_WINDOW = 1220; // 约5年
const ROLL_LOW = 0.2;
const ROLL_HIGH = 0.8;
const RF = 0.015;

interface Quote {
  date: string;
  close: number;
}
type Leg = 'growth' | 'dividend' | 'mix'; // growth=分子腿, dividend=分母腿

async function loadIndex(code: string): Promise<Quote[]> {
  const cachePath = path.join(DATA_DIR, `${code}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Quote[];
    console.log(`[cache] ${code}: ${cached.length} 条（${cached[0].date} ~ ${cached[cached.length - 1].date}）`);
    return cached;
  }
  console.log(`[fetch] ${code} 全历史（中证官网）...`);
  const full = await fetchCsindexDailyClose(code, '20041231', '20991231');
  fs.writeFileSync(cachePath, JSON.stringify(full));
  console.log(`[fetch] ${code}: ${full.length} 条（${full[0].date} ~ ${full[full.length - 1].date}）`);
  return full;
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
  calmar: number;
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
    calmar: maxDd > 0 ? cagr / maxDd : 0,
    switches,
    finalMultiple: value,
  };
}

function evaluateRebalance(
  dates: string[],
  aRet: number[],
  bRet: number[],
  startIdx: number,
): Metrics {
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
    calmar: maxDd > 0 ? cagr / maxDd : 0,
    switches: 0,
    finalMultiple: value,
  };
}

const PAIRS: Array<{ key: string; label: string; codeA: string; nameA: string; codeB: string; nameB: string }> = [
  { key: 'P1', label: 'P1 大小盘：沪深300 / 中证1000', codeA: 'H00300', nameA: '沪深300全收益', codeB: 'H00852', nameB: '中证1000全收益' },
  { key: 'P2', label: 'P2 成长价值：300成长 / 300价值', codeA: 'H00918', nameA: '300成长全收益', codeB: 'H00919', nameB: '300价值全收益' },
];

const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), pairs: {} };

for (const p of PAIRS) {
  console.log(`\n================ ${p.label} ================`);
  const [a, b] = await Promise.all([loadIndex(p.codeA), loadIndex(p.codeB)]);
  const bMap = new Map(b.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const closeA: number[] = [];
  const closeB: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const cb = bMap.get(a[i].date);
    if (cb === undefined || !Number.isFinite(a[i].close) || !Number.isFinite(cb)) continue;
    dates.push(a[i].date);
    closeA.push(a[i].close);
    closeB.push(cb);
  }
  if (dates.length < ROLL_WINDOW + 100) {
    console.log(`[skip] 对齐后仅 ${dates.length} 条，滚动窗口不足，无法回测`);
    continue;
  }
  console.log(`[align] ${dates.length} 个交易日（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  const aRet: number[] = [0];
  const bRet: number[] = [0];
  for (let i = 1; i < dates.length; i++) {
    aRet.push(closeA[i] / closeA[i - 1] - 1);
    bRet.push(closeB[i] / closeB[i - 1] - 1);
  }
  const ratio = dates.map((_, i) => closeA[i] / closeB[i]);

  // 跷跷板检验：两腿相关性（全窗口 + 近5年）
  const corrAll = corr(aRet.slice(1), bRet.slice(1));
  const n5 = Math.min(1212, aRet.length - 1);
  const corr5y = corr(aRet.slice(-n5), bRet.slice(-n5));
  console.log(`[跷跷板检验] 两腿日收益相关系数：全窗口 ${corrAll.toFixed(3)}｜近5年 ${corr5y.toFixed(3)}（越低越对立，>0.85 则对子失效）`);

  const pos = positionsFromSignals(rollingSignals(ratio));
  const startIdx = Math.min(ROLL_WINDOW, dates.length - 2);

  const rows: Metrics[] = [
    evaluate(`轮动：${p.nameA}/比值分位20/80`, dates, aRet, bRet, pos, startIdx),
    evaluateRebalance(dates, aRet, bRet, startIdx),
    evaluate(`基准：100% ${p.nameA}`, dates, aRet, bRet, dates.map(() => 'growth' as Leg), startIdx),
    evaluate(`基准：100% ${p.nameB}`, dates, aRet, bRet, dates.map(() => 'dividend' as Leg), startIdx),
  ];

  const w = [34, 9, 8, 9, 9, 9, 8, 7, 9];
  console.log(`=== 评估窗口（${dates[startIdx]} ~ ${dates[dates.length - 1]}，${dates.length - startIdx} 个交易日）===`);
  console.log(['策略', 'CAGR', '波动', '夏普0', '夏普rf', '最大回撤', '卡玛', '换手', '期末倍数'].map((h, i) => h.padEnd(w[i])).join(''));
  for (const m of rows) {
    console.log(
      [
        m.name,
        `${(m.cagr * 100).toFixed(2)}%`,
        `${(m.vol * 100).toFixed(2)}%`,
        m.sharpe0.toFixed(2),
        m.sharpeRf.toFixed(2),
        `${(m.maxDrawdown * 100).toFixed(2)}%`,
        m.calmar.toFixed(2),
        m.switches,
        m.finalMultiple.toFixed(3),
      ]
        .map((c, i) => String(c).padEnd(w[i]))
        .join(''),
    );
  }

  // 窗口内交易明细
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
