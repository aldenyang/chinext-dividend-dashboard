/**
 * 风格切换策略回测（研究用途，非投资建议）
 *
 * 数据口径说明（重要）：
 * - 可投资收益口径：创业板腿用 399006（价格指数，股息率低，近似全收益）；
 *   红利腿用中证红利全收益 H00922（中证官方一手数据，含股息再投资）。
 *   若用价格指数 000922 做收益会被系统性低估约 4-5pp/年（股息未计入）。
 * - 信号口径：S1 用价格比值（现有页面 0.3/0.7 参考线的口径）；
 *   S2/S3 用全收益比值（修正分红漂移后的口径）。
 * - 执行假设：T 日收盘出信号，T+1 日按信号持仓；换仓时扣单边成本 0.15%。
 * - 初始无信号阶段持 50/50 静态组合。
 *
 * 策略：
 *   S1 固定阈值（价格比值）：<0.3 持创业板，>0.7 持红利，区间内维持
 *   S2 固定阈值（全收益比值）：同 S1 规则
 *   S3 滚动分位（全收益比值）：滚动 5 年分位 <20% 持创业板，>80% 持红利
 * 基准：50/50 每年再平衡；100% 创业板；100% 红利（全收益）
 *
 * 回滚：本模块为独立提交，git revert 该提交即可整体移除，不影响仪表盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCsindexDailyClose } from './datasource/csindex.ts';
// 策略参数单一配置源（与前端 src/config/strategy.ts 同一份）
import { STRATEGY } from '../src/config/strategy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORICAL_PATH = path.join(ROOT, 'public/data/historical.json');
const TR_CACHE_PATH = path.join(ROOT, 'data/h00922.json');
const RESULT_PATH = path.join(ROOT, 'data/backtest-result.json');

const COST = STRATEGY.execution.oneSideCost; // 单边换仓成本
const TRADING_DAYS = 244;
const ROLL_WINDOW = STRATEGY.s6.windowDays; // S3/S6 滚动窗口：约 5 年
const ROLL_LOW = STRATEGY.s6.lowPct;
const ROLL_HIGH = STRATEGY.s6.highPct;
const FIXED_LOW = 0.3;
const FIXED_HIGH = 0.7;

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

async function loadTrIndex(): Promise<Quote[]> {
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8')) as DailyRecord[];
  const lastDate = hist[hist.length - 1].date.replace(/-/g, '');

  if (fs.existsSync(TR_CACHE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(TR_CACHE_PATH, 'utf8')) as Quote[];
    const last = cached[cached.length - 1].date.replace(/-/g, '');
    if (last >= lastDate) {
      console.log(`[cache] H00922 缓存有效（${cached.length} 条，截至 ${cached[cached.length - 1].date}）`);
      return cached;
    }
    const lastCached = cached[cached.length - 1].date.replace(/-/g, '');
    const fresh = await fetchCsindexDailyClose('H00922', lastCached, lastDate);
    const seen = new Set(cached.map((r) => r.date));
    const merged = [...cached, ...fresh.filter((r) => !seen.has(r.date))];
    merged.sort((a, b) => a.date.localeCompare(b.date));
    fs.writeFileSync(TR_CACHE_PATH, JSON.stringify(merged));
    console.log(`[cache] H00922 增量更新至 ${merged[merged.length - 1].date}（共 ${merged.length} 条）`);
    return merged;
  }

  console.log('[fetch] 拉取 H00922 全历史（中证官网，按 4 年分片）...');
  const full = await fetchCsindexDailyClose('H00922', '20041231', lastDate);
  fs.mkdirSync(path.dirname(TR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(TR_CACHE_PATH, JSON.stringify(full));
  console.log(`[fetch] H00922 共 ${full.length} 条（${full[0].date} ~ ${full[full.length - 1].date}）`);
  return full;
}

/** 当前值在滚动窗口内的分位（0~1；窗口不满返回 null） */
function rollingPercentile(series: number[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let count = 0;
  for (let j = i - window + 1; j <= i; j++) {
    if (series[j] <= series[i]) count++;
  }
  return count / window;
}

/** 由信号序列生成"次日持仓"序列（T 收盘信号 → T+1 持仓；无信号期持 mix） */
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

function fixedThresholdSignals(ratio: number[], low: number, high: number): (Leg | null)[] {
  return ratio.map((r) => {
    if (r < low) return 'growth' as Leg;
    if (r > high) return 'dividend' as Leg;
    return null; // 区间内维持原状
  });
}

function rollingPercentileSignals(ratio: number[]): (Leg | null)[] {
  const sig: (Leg | null)[] = [];
  for (let i = 0; i < ratio.length; i++) {
    const p = rollingPercentile(ratio, i, ROLL_WINDOW);
    if (p === null) sig.push(null);
    else if (p < ROLL_LOW) sig.push('growth');
    else if (p > ROLL_HIGH) sig.push('dividend');
    else sig.push(null); // 中间区维持原状
  }
  return sig;
}

interface Metrics {
  name: string;
  cagr: number;
  vol: number;
  maxDrawdown: number;
  switches: number;
  finalMultiple: number;
  evalStart: string;
  evalEnd: string;
  evalDays: number;
}

/** 在 [startIdx, N) 区间评估一个策略的日收益序列（含换仓成本） */
function evaluate(
  name: string,
  dates: string[],
  gRet: number[],
  dRet: number[],
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
    maxDrawdown: maxDd,
    switches,
    finalMultiple: value,
    evalStart: dates[startIdx],
    evalEnd: dates[dates.length - 1],
    evalDays: days,
  };
}

/** 50/50 每年首个交易日再平衡基准 */
function evaluateRebalance(
  dates: string[],
  gRet: number[],
  dRet: number[],
  startIdx: number,
): Metrics {
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
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return {
    name: '基准：50/50 年度再平衡',
    cagr: Math.pow(value, TRADING_DAYS / days) - 1,
    vol: Math.sqrt(variance) * Math.sqrt(TRADING_DAYS),
    maxDrawdown: maxDd,
    switches: 0,
    finalMultiple: value,
    evalStart: dates[startIdx],
    evalEnd: dates[dates.length - 1],
    evalDays: days,
  };
}

interface Trade {
  leg: 'growth' | 'dividend';
  signalDate: string; // 信号日（收盘）
  execDate: string; // 成交日（T+1）
  ratioAtSignal: number;
  exitSignalDate: string | null;
  exitExecDate: string | null;
  holdingDays: number | null;
  legReturn: number | null; // 该腿持有期收益
  altLegReturn: number | null; // 对侧腿同期收益（机会成本）
}

/** 从持仓序列提取交易明细（以 growth 进出为一次完整回合；期末未平仓标注 null） */
function extractTrades(
  name: string,
  dates: string[],
  chinext: number[],
  divTr: number[],
  ratio: number[],
  positions: Leg[],
): Trade[] {
  const trades: Trade[] = [];
  let open: { leg: 'growth' | 'dividend'; signalDate: string; execDate: string; ratioAtSignal: number; entryIdx: number } | null = null;

  for (let i = 1; i < dates.length; i++) {
    if (positions[i] === positions[i - 1]) continue;
    // 平仓：i-1 是最后一天持有旧仓，信号发生在 i-1 收盘，i 开仓新腿
    if (open && positions[i] !== open.leg) {
      const legRet =
        open.leg === 'growth' ? chinext[i] / chinext[open.entryIdx] - 1 : divTr[i] / divTr[open.entryIdx] - 1;
      const altRet =
        open.leg === 'growth' ? divTr[i] / divTr[open.entryIdx] - 1 : chinext[i] / chinext[open.entryIdx] - 1;
      trades.push({
        leg: open.leg,
        signalDate: open.signalDate,
        execDate: open.execDate,
        ratioAtSignal: open.ratioAtSignal,
        exitSignalDate: dates[i - 1],
        exitExecDate: dates[i],
        holdingDays: i - open.entryIdx,
        legReturn: legRet,
        altLegReturn: altRet,
      });
      open = null;
    }
    // 开仓
    if (positions[i] === 'growth' || positions[i] === 'dividend') {
      const leg = positions[i] === 'growth' ? ('growth' as const) : ('dividend' as const);
      open = {
        leg,
        signalDate: dates[i - 1],
        execDate: dates[i],
        ratioAtSignal: ratio[i - 1],
        entryIdx: i,
      };
    }
  }
  // 期末未平仓
  if (open) {
    const last = dates.length - 1;
    const legRet =
      open.leg === 'growth' ? chinext[last] / chinext[open.entryIdx] - 1 : divTr[last] / divTr[open.entryIdx] - 1;
    const altRet =
      open.leg === 'growth' ? divTr[last] / divTr[open.entryIdx] - 1 : chinext[last] / chinext[open.entryIdx] - 1;
    trades.push({
      leg: open.leg,
      signalDate: open.signalDate,
      execDate: open.execDate,
      ratioAtSignal: open.ratioAtSignal,
      exitSignalDate: null,
      exitExecDate: null,
      holdingDays: last - open.entryIdx,
      legReturn: legRet,
      altLegReturn: altRet,
    });
  }
  void name;
  return trades;
}

/** 阈值附近的"接近"机会统计：精确穿越次数与接近区间停留天数 */
function zoneStats(ratio: number[], low: number, high: number) {
  let crossDownLow = 0;
  let crossUpHigh = 0;
  let daysNearLow = 0;
  let daysNearHigh = 0;
  for (let i = 1; i < ratio.length; i++) {
    if (ratio[i] < low && ratio[i - 1] >= low) crossDownLow++;
    if (ratio[i] > high && ratio[i - 1] <= high) crossUpHigh++;
    if (ratio[i] >= low && ratio[i] <= low + 0.05) daysNearLow++;
    if (ratio[i] <= high && ratio[i] >= high - 0.05) daysNearHigh++;
  }
  return {
    crossDownLow,
    crossUpHigh,
    daysNearLow, // 比值处于 [low, low+0.05] 的交易日数
    daysNearHigh, // 比值处于 [high-0.05, high] 的交易日数
    min: Math.min(...ratio),
    max: Math.max(...ratio),
  };
}

function fmtRow(cols: (string | number)[], widths: number[]): string {
  return cols
    .map((c, i) => {
      const s = typeof c === 'number' ? c.toFixed(4).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m)) : c;
      return String(s).padEnd(widths[i]);
    })
    .join('  ');
}

/** 阈值邻域网格扫描：检验 0.35/0.65 是稳健平台还是孤峰（孤峰=过拟合信号） */
function gridSearch(
  dates: string[],
  gRet: number[],
  dRet: number[],
  priceRatio: number[],
): void {
  const lows = [0.3, 0.32, 0.35, 0.38, 0.4];
  const highs = [0.6, 0.63, 0.65, 0.68, 0.7];
  const header = 'low\\high ' + highs.map((h) => `${h.toFixed(2)}`.padStart(9)).join('');
  console.log(`\n=== 网格扫描：固定阈值（价格比值）CAGR%，行=入场阈值，列=离场阈值 ===`);
  console.log(header);
  for (const low of lows) {
    const cells = highs.map((high) => {
      const pos = positionsFromSignals(fixedThresholdSignals(priceRatio, low, high));
      const m = evaluate('', dates, gRet, dRet, pos, 1);
      const switches = m.switches;
      return `${(m.cagr * 100).toFixed(1)}%(${switches})`.padStart(9);
    });
    console.log(`${low.toFixed(2)}     ${cells.join('')}`);
  }
  console.log('（括号内为换手次数；次数<3 的格子统计意义极弱）');
}

async function main(): Promise<void> {
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8')) as DailyRecord[];
  const tr = await loadTrIndex();

  // 三序列按交易日对齐（三者皆有数据的日期）
  const trMap = new Map(tr.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const chinext: number[] = [];
  const divPrice: number[] = [];
  const divTr: number[] = [];
  for (const r of hist) {
    const trClose = trMap.get(r.date);
    // 创业板指 2010-06 前无行情（记录为 null），三条序列必须同时有效才能对齐
    if (
      trClose === undefined ||
      !Number.isFinite(r.chinextClose) ||
      !Number.isFinite(r.dividendClose) ||
      !Number.isFinite(trClose)
    ) {
      continue;
    }
    dates.push(r.date);
    chinext.push(r.chinextClose);
    divPrice.push(r.dividendClose);
    divTr.push(trClose);
  }
  console.log(`[align] 三序列对齐后 ${dates.length} 个交易日（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  // 可投资日收益（T 日 vs T-1 收盘）
  const gRet: number[] = [0];
  const dRet: number[] = [0];
  for (let i = 1; i < dates.length; i++) {
    gRet.push(chinext[i] / chinext[i - 1] - 1);
    dRet.push(divTr[i] / divTr[i - 1] - 1);
  }

  // 两条比值曲线
  const priceRatio = dates.map((_, i) => chinext[i] / divPrice[i]);
  const trRatio = dates.map((_, i) => chinext[i] / divTr[i]);

  const strategies: Array<{ name: string; positions: Leg[]; startIdx: number }> = [
    {
      name: 'S1 固定0.3/0.7（价格比值，现页面口径）',
      positions: positionsFromSignals(fixedThresholdSignals(priceRatio, FIXED_LOW, FIXED_HIGH)),
      startIdx: 1,
    },
    {
      name: 'S2 固定0.3/0.7（全收益比值）',
      positions: positionsFromSignals(fixedThresholdSignals(trRatio, FIXED_LOW, FIXED_HIGH)),
      startIdx: 1,
    },
    {
      name: 'S3 滚动5年分位20/80（全收益比值）',
      positions: positionsFromSignals(rollingPercentileSignals(trRatio)),
      startIdx: Math.min(ROLL_WINDOW, dates.length - 2),
    },
    {
      name: 'S4 扩带固定0.35/0.65（价格比值）',
      positions: positionsFromSignals(fixedThresholdSignals(priceRatio, STRATEGY.s4.low, STRATEGY.s4.high)),
      startIdx: 1,
    },
    {
      name: 'S5 扩带固定0.35/0.65（全收益比值）',
      positions: positionsFromSignals(fixedThresholdSignals(trRatio, STRATEGY.s4.low, STRATEGY.s4.high)),
      startIdx: 1,
    },
    {
      name: 'S6 滚动5年分位20/80（价格比值）',
      positions: positionsFromSignals(rollingPercentileSignals(priceRatio)),
      startIdx: Math.min(ROLL_WINDOW, dates.length - 2),
    },
  ];

  const allMetrics: Metrics[] = [];
  for (const s of strategies) {
    allMetrics.push(evaluate(s.name, dates, gRet, dRet, s.positions, s.startIdx));
  }
  allMetrics.push(evaluateRebalance(dates, gRet, dRet, 1));
  allMetrics.push(evaluate('基准：100% 创业板指', dates, gRet, dRet, dates.map(() => 'growth' as Leg), 1));
  allMetrics.push(evaluate('基准：100% 红利全收益', dates, gRet, dRet, dates.map(() => 'dividend' as Leg), 1));

  // 所有策略在同一可比窗口（S3 可用起始日）再评一次
  const commonStart = Math.min(ROLL_WINDOW, dates.length - 2);
  const commonMetrics: Metrics[] = [];
  for (const s of strategies) {
    commonMetrics.push(evaluate(s.name + '｜同窗口', dates, gRet, dRet, s.positions, commonStart));
  }
  commonMetrics.push(evaluateRebalance(dates, gRet, dRet, commonStart));

  const printTable = (title: string, rows: Metrics[]) => {
    console.log(`\n=== ${title} ===`);
    const widths = [46, 8, 8, 12, 9, 12];
    console.log(
      fmtRow(['策略', 'CAGR', '波动', '最大回撤', '换手次数', '期末倍数'], widths),
    );
    for (const m of rows) {
      console.log(
        fmtRow(
          [
            m.name.slice(0, 44),
            `${(m.cagr * 100).toFixed(2)}%`,
            `${(m.vol * 100).toFixed(2)}%`,
            `${(m.maxDrawdown * 100).toFixed(2)}%`,
            m.switches,
            m.finalMultiple.toFixed(3),
          ],
          widths,
        ),
      );
    }
  };

  printTable(
    `全历史窗口（${allMetrics[0].evalStart} ~ ${allMetrics[0].evalEnd}，各策略按自身信号可用起点）`,
    allMetrics,
  );
  printTable(
    `共同可比窗口（${commonMetrics[0].evalStart} ~ ${commonMetrics[0].evalEnd}，滚动分位窗口期满）`,
    commonMetrics,
  );

  const tradeLogs: Record<string, Trade[]> = {
    S1: extractTrades('S1', dates, chinext, divTr, priceRatio, strategies[0].positions),
    S2: extractTrades('S2', dates, chinext, divTr, trRatio, strategies[1].positions),
    S3: extractTrades('S3', dates, chinext, divTr, trRatio, strategies[2].positions),
    S4: extractTrades('S4', dates, chinext, divTr, priceRatio, strategies[3].positions),
    S5: extractTrades('S5', dates, chinext, divTr, trRatio, strategies[4].positions),
    S6: extractTrades('S6', dates, chinext, divTr, priceRatio, strategies[5].positions),
  };
  const zone = {
    price: zoneStats(priceRatio, FIXED_LOW, FIXED_HIGH),
    tr: zoneStats(trRatio, FIXED_LOW, FIXED_HIGH),
  };

  const printTrades = (title: string, trades: Trade[]) => {
    console.log(`\n--- ${title}：共 ${trades.length} 笔 ---`);
    for (const t of trades) {
      const side = t.leg === 'growth' ? '进创业板' : '进红利';
      const hold = t.holdingDays === null ? '持仓中' : `${t.holdingDays}日`;
      const ret =
        t.legReturn === null
          ? '—'
          : `${(t.legReturn * 100).toFixed(1)}%（对侧同期 ${t.altLegReturn === null ? '—' : `${(t.altLegReturn * 100).toFixed(1)}%`}）`;
      console.log(
        `${side}｜信号 ${t.signalDate}（比值${t.ratioAtSignal.toFixed(3)}）→ 成交 ${t.execDate}` +
          (t.exitExecDate ? `｜离场信号 ${t.exitSignalDate} → 成交 ${t.exitExecDate}` : '｜未平仓') +
          `｜持有 ${hold}｜收益 ${ret}`,
      );
    }
  };
  printTrades('S4 扩带0.35/0.65（价格比值）', tradeLogs.S4);
  printTrades('S6 滚动分位20/80（价格比值）', tradeLogs.S6);
  console.log(
    `\n[机会统计] 价格比值：下穿0.3 ${zone.price.crossDownLow} 次，上穿0.7 ${zone.price.crossUpHigh} 次，` +
      `停留0.30-0.35带 ${zone.price.daysNearLow} 日、0.65-0.70带 ${zone.price.daysNearHigh} 日，全史区间 [${zone.price.min.toFixed(3)}, ${zone.price.max.toFixed(3)}]`,
  );
  console.log(
    `[机会统计] 全收益比值：下穿0.3 ${zone.tr.crossDownLow} 次，上穿0.7 ${zone.tr.crossUpHigh} 次，` +
      `停留0.30-0.35带 ${zone.tr.daysNearLow} 日、0.65-0.70带 ${zone.tr.daysNearHigh} 日，全史区间 [${zone.tr.min.toFixed(3)}, ${zone.tr.max.toFixed(3)}]`,
  );

  gridSearch(dates, gRet, dRet, priceRatio);

  const result = {
    generatedAt: new Date().toISOString(),
    caliber: {
      growthLeg: '399006 创业板指（价格指数，近似全收益）',
      dividendLeg: 'H00922 中证红利全收益（中证官网一手数据）',
      signalS1: '价格比值固定 0.3/0.7',
      signalS2: '全收益比值固定 0.3/0.7',
      signalS3: '全收益比值滚动5年分位 20%/80%',
      execution: 'T 收盘信号 T+1 持仓，换仓单边成本 0.15%',
      disclaimer: '研究用途，非投资建议；历史表现不预示未来收益',
    },
    alignedDays: dates.length,
    alignedRange: [dates[0], dates[dates.length - 1]] as [string, string],
    fullWindow: allMetrics,
    commonWindow: commonMetrics,
    trades: tradeLogs,
    zoneStats: zone,
  };
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\n[done] 结果已保存 ${path.relative(ROOT, RESULT_PATH)}`);
}

main().catch((e) => {
  console.error('[backtest failed]', e);
  process.exit(1);
});
