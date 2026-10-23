/**
 * 近 5 年窗口专项回测：S6 滚动5年分位20/80（价格比值信号）为主角
 *
 * 与 backtest.ts 完全同口径：
 * - 信号：价格比值（页面口径），滚动 1220 交易日分位 <20% 持创业板 / >80% 持红利 / 区间维持
 * - 可投资收益：创业板腿 399006 价格指数（近似全收益），红利腿 H00922 全收益
 * - 执行：T 收盘信号 T+1 持仓，换仓单边成本 0.15%
 * - 期初持仓沿用窗口起点时规则应有状态（滚动窗口用窗口前的真实历史数据）
 *
 * 新增指标：年化波动、夏普（rf=0 与 rf=1.5% 两口径）、卡玛（CAGR/最大回撤）
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGY } from '../src/config/strategy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORICAL_PATH = path.join(ROOT, 'public/data/historical.json');
const TR_CACHE_PATH = path.join(ROOT, 'data/h00922.json');
const RESULT_PATH = path.join(ROOT, 'data/backtest-s6-5y-result.json');

const COST = STRATEGY.execution.oneSideCost;
const TRADING_DAYS = 244;
const ROLL_WINDOW = STRATEGY.s6.windowDays;
const ROLL_LOW = STRATEGY.s6.lowPct;
const ROLL_HIGH = STRATEGY.s6.highPct;
const RF = 0.015; // 无风险利率假设：1.5%/年（夏普第二口径）

interface DailyRecord {
  date: string;
  chinextClose: number;
  dividendClose: number;
  ratio: number;
}
interface Quote {
  date: string;
  close: number;
}
type Leg = 'growth' | 'dividend' | 'mix';

interface WindowMetrics {
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

function rollingPercentile(series: number[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let count = 0;
  for (let j = i - window + 1; j <= i; j++) {
    if (series[j] <= series[i]) count++;
  }
  return count / window;
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

function rollingSignals(ratio: number[]): (Leg | null)[] {
  const sig: (Leg | null)[] = [];
  for (let i = 0; i < ratio.length; i++) {
    const p = rollingPercentile(ratio, i, ROLL_WINDOW);
    if (p === null) sig.push(null);
    else if (p < ROLL_LOW) sig.push('growth');
    else if (p > ROLL_HIGH) sig.push('dividend');
    else sig.push(null);
  }
  return sig;
}

function fixedSignals(ratio: number[], low: number, high: number): (Leg | null)[] {
  return ratio.map((r) => {
    if (r < low) return 'growth' as Leg;
    if (r > high) return 'dividend' as Leg;
    return null;
  });
}

/** 窗口评估（含夏普/卡玛） */
function evaluate(
  name: string,
  dates: string[],
  gRet: number[],
  dRet: number[],
  positions: Leg[],
  startIdx: number,
): WindowMetrics {
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
      pos === 'growth' ? gRet[i] : pos === 'dividend' ? dRet[i] : 0.5 * gRet[i] + 0.5 * dRet[i];
    value *= 1 + r;
    rets.push(r);
    if (value > peak) peak = value;
    const dd = 1 - value / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const days = dates.length - startIdx;
  const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
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

/** 50/50 年度再平衡基准（窗口评估版） */
function evaluateRebalance(
  dates: string[],
  gRet: number[],
  dRet: number[],
  startIdx: number,
): WindowMetrics {
  let value = 1;
  let peak = 1;
  let maxDd = 0;
  let wg = 0.5;
  let wd = 0.5;
  let curYear = dates[startIdx].slice(0, 4);
  const rets: number[] = [];
  for (let i = startIdx; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    if (y !== curYear) {
      curYear = y;
      wg = 0.5;
      wd = 0.5;
    }
    const r = wg * gRet[i] + wd * dRet[i];
    wg = (wg * (1 + gRet[i])) / (1 + r);
    wd = (wd * (1 + dRet[i])) / (1 + r);
    value *= 1 + r;
    rets.push(r);
    if (value > peak) peak = value;
    const dd = 1 - value / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const days = dates.length - startIdx;
  const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
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

function main(): void {
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8')) as DailyRecord[];
  const tr = JSON.parse(fs.readFileSync(TR_CACHE_PATH, 'utf8')) as Quote[];
  const trMap = new Map(tr.map((r) => [r.date, r.close]));

  const dates: string[] = [];
  const chinext: number[] = [];
  const divPrice: number[] = [];
  const divTr: number[] = [];
  for (const r of hist) {
    const c = trMap.get(r.date);
    if (
      c === undefined ||
      !Number.isFinite(r.chinextClose) ||
      !Number.isFinite(r.dividendClose) ||
      !Number.isFinite(c)
    ) {
      continue;
    }
    dates.push(r.date);
    chinext.push(r.chinextClose);
    divPrice.push(r.dividendClose);
    divTr.push(c);
  }

  const gRet: number[] = [0];
  const dRet: number[] = [0];
  for (let i = 1; i < dates.length; i++) {
    gRet.push(chinext[i] / chinext[i - 1] - 1);
    dRet.push(divTr[i] / divTr[i - 1] - 1);
  }
  const priceRatio = dates.map((_, i) => chinext[i] / divPrice[i]);

  // 窗口起点：最新交易日前推 5 个自然年
  const lastDate = dates[dates.length - 1];
  const winStart = `${Number(lastDate.slice(0, 4)) - 5}${lastDate.slice(4)}`;
  const startIdx = dates.findIndex((d) => d >= winStart);
  if (startIdx <= 0) throw new Error('窗口起点异常');

  // S6 全历史持仓序列（滚动分位用窗口前的完整真实历史），从窗口起点评估
  const s6Pos = positionsFromSignals(rollingSignals(priceRatio));
  const s4Pos = positionsFromSignals(fixedSignals(priceRatio, STRATEGY.s4.low, STRATEGY.s4.high));

  const rows: WindowMetrics[] = [
    evaluate('S6 滚动5年分位20/80（价格比值）', dates, gRet, dRet, s6Pos, startIdx),
    evaluate('S4 固定0.35/0.65（价格比值，对照）', dates, gRet, dRet, s4Pos, startIdx),
    evaluateRebalance(dates, gRet, dRet, startIdx),
    evaluate('基准：100% 创业板指', dates, gRet, dRet, dates.map(() => 'growth' as Leg), startIdx),
    evaluate('基准：100% 红利全收益', dates, gRet, dRet, dates.map(() => 'dividend' as Leg), startIdx),
  ];

  console.log(
    `=== 近5年窗口（${dates[startIdx]} ~ ${lastDate}，共 ${dates.length - startIdx} 个交易日）===`,
  );
  const w = [36, 9, 8, 9, 9, 9, 8, 7, 9];
  const head = ['策略', 'CAGR', '波动', '夏普0', '夏普rf', '最大回撤', '卡玛', '换手', '期末倍数'];
  console.log(head.map((h, i) => h.padEnd(w[i])).join(''));
  for (const m of rows) {
    const cells = [
      m.name,
      `${(m.cagr * 100).toFixed(2)}%`,
      `${(m.vol * 100).toFixed(2)}%`,
      m.sharpe0.toFixed(2),
      m.sharpeRf.toFixed(2),
      `${(m.maxDrawdown * 100).toFixed(2)}%`,
      m.calmar.toFixed(2),
      m.switches,
      m.finalMultiple.toFixed(3),
    ];
    console.log(cells.map((c, i) => String(c).padEnd(w[i])).join(''));
  }

  // S6 窗口内交易明细 + 期初带入持仓
  interface TradeRow {
    leg: string;
    signalDate: string;
    execDate: string;
    ratioAtSignal: number;
    exitExecDate: string | null;
    legReturn: number | null;
    altLegReturn: number | null;
  }
  const trades: TradeRow[] = [];
  let open: { leg: 'growth' | 'dividend'; signalDate: string; execDate: string; entryIdx: number } | null = null;
  for (let i = 1; i < dates.length; i++) {
    if (s6Pos[i] === s6Pos[i - 1]) continue;
    if (open && s6Pos[i] !== open.leg) {
      trades.push({
        leg: open.leg,
        signalDate: open.signalDate,
        execDate: open.execDate,
        ratioAtSignal: priceRatio[open.entryIdx - 1],
        exitExecDate: dates[i],
        legReturn: open.leg === 'growth' ? chinext[i] / chinext[open.entryIdx] - 1 : divTr[i] / divTr[open.entryIdx] - 1,
        altLegReturn: open.leg === 'growth' ? divTr[i] / divTr[open.entryIdx] - 1 : chinext[i] / chinext[open.entryIdx] - 1,
      });
      open = null;
    }
    if (s6Pos[i] === 'growth' || s6Pos[i] === 'dividend') {
      open = { leg: s6Pos[i] as 'growth' | 'dividend', signalDate: dates[i - 1], execDate: dates[i], entryIdx: i };
    }
  }
  const carriedLeg = s6Pos[startIdx];
  const inWindow = trades.filter((t) => t.execDate >= dates[startIdx]);
  console.log(`\n[S6 期初带入持仓] ${carriedLeg}（窗口起点时规则状态）`);
  console.log(`[S6 窗口内交易] ${inWindow.length} 笔`);
  for (const t of inWindow) {
    const side = t.leg === 'growth' ? '进创业板' : '进红利';
    console.log(
      `${side}｜信号 ${t.signalDate} → 成交 ${t.execDate}｜离场 ${t.exitExecDate ?? '未平仓'}` +
        `｜收益 ${(t.legReturn! * 100).toFixed(1)}%（对侧 ${(t.altLegReturn! * 100).toFixed(1)}%）`,
    );
  }

  // 窗口内 S6 分位触发带的天数占比（信号活跃度）
  let activeDays = 0;
  for (let i = startIdx; i < dates.length; i++) {
    const p = rollingPercentile(priceRatio, i, ROLL_WINDOW);
    if (p !== null && (p < ROLL_LOW || p > ROLL_HIGH)) activeDays++;
  }
  console.log(
    `\n[信号活跃度] 窗口内分位越界（<20% 或 >80%）天数 ${activeDays}，占比 ${((activeDays / (dates.length - startIdx)) * 100).toFixed(1)}%`,
  );

  const result = {
    generatedAt: new Date().toISOString(),
    window: { start: dates[startIdx], end: lastDate, days: dates.length - startIdx },
    caliber: {
      signal: '价格比值滚动5年分位 20%/80%（与页面 strategy.ts 同配置）',
      legs: '创业板 399006 价格指数（近似全收益）/ 中证红利全收益 H00922',
      execution: 'T 收盘信号 T+1 持仓，换仓单边成本 0.15%',
      sharpeNote: `夏普0 = CAGR/年化波动；夏普rf = (CAGR-${RF * 100}%)/年化波动`,
      disclaimer: '研究用途，非投资建议',
    },
    metrics: rows,
    s6TradesInWindow: inWindow,
    s6CarriedPosition: carriedLeg,
    signalActiveDays: activeDays,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\n[done] ${path.relative(ROOT, RESULT_PATH)}`);
}

main();
