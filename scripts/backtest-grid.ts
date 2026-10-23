/**
 * 近 5 年「S4 策略 + 网格定投」回测（研究用途，非投资建议）
 *
 * 资金模型（假设，可调常量）：
 *  - 定投：每月首个交易日投入 10,000 元，按 S4 当前状态买入对应腿
 *    （growth → 创业板 399006；dividend → 红利全收益 H00922）
 *  - 网格池：期初 200,000 元现金，平时跟随 S4 状态买入当前腿（资金不闲置）；
 *    S4 处于 growth 状态时网格激活：
 *      · 比值较锚点每下移 0.02 → 从池中取 1/5（40,000 元）加买创业板
 *      · 比值较锚点每上移 0.02 且持有网格份额 → 卖出一份回收现金（可再用于下轮加买）
 *      · 状态切回 dividend 时网格份额随主仓全部清算，资金回池跟随红利
 *  - 执行：T 收盘信号 T+1 收盘成交；所有买卖扣单边成本 0.15%
 *
 * 基准（同现金流：期初 200,000 + 每月 10,000）：
 *  - 50/50 年度再平衡定投 / 全红利定投 / 全创业板定投
 *
 * 指标：期末市值、累计收益率、资金加权年化（XIRR）、日频最大回撤、成交笔数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCsindexDailyClose } from './datasource/csindex.ts';
import { STRATEGY } from '../src/config/strategy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORICAL_PATH = path.join(ROOT, 'public/data/historical.json');
const TR_CACHE_PATH = path.join(ROOT, 'data/h00922.json');
const RESULT_PATH = path.join(ROOT, 'data/backtest-grid-result.json');

const COST = STRATEGY.execution.oneSideCost;
const WINDOW_YEARS = 5;
const MONTHLY_DCA = 10_000;
const GRID_POOL = 200_000;
const GRID_TRANCHES = 5;
const GRID_STEP = 0.02;
const INITIAL_CASH = GRID_POOL;
const MIN_CASH = 100; // 低于该金额视为现金已用尽（防浮点残留反复买入）

interface DailyRecord {
  date: string;
  chinextClose: number | null;
  dividendClose: number | null;
  ratio: number;
}
interface Quote {
  date: string;
  close: number;
}

async function loadTrIndex(): Promise<Quote[]> {
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8')) as DailyRecord[];
  const lastDate = hist[hist.length - 1].date.replace(/-/g, '');
  if (fs.existsSync(TR_CACHE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(TR_CACHE_PATH, 'utf8')) as Quote[];
    const last = cached[cached.length - 1].date.replace(/-/g, '');
    if (last >= lastDate) return cached;
    const lastCached = cached[cached.length - 1].date.replace(/-/g, '');
    const fresh = await fetchCsindexDailyClose('H00922', lastCached, lastDate);
    const seen = new Set(cached.map((r) => r.date));
    const merged = [...cached, ...fresh.filter((r) => !seen.has(r.date))];
    merged.sort((a, b) => a.date.localeCompare(b.date));
    fs.writeFileSync(TR_CACHE_PATH, JSON.stringify(merged));
    return merged;
  }
  const full = await fetchCsindexDailyClose('H00922', '20041231', lastDate);
  fs.mkdirSync(path.dirname(TR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(TR_CACHE_PATH, JSON.stringify(full));
  return full;
}

/** 资金加权年化收益率（XIRR，二分法）：投入为负、期末回收为正 */
function xirr(flows: { t: number; amt: number }[]): number | null {
  const f = (r: number) => flows.reduce((s, c) => s + c.amt / Math.pow(1 + r, c.t / 365), 0);
  let lo = -0.95;
  let hi = 5;
  let fLo = f(lo);
  const fHi = f(hi);
  if (fLo * fHi > 0) return null;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

interface RowResult {
  name: string;
  finalValue: number;
  totalInvested: number;
  totalReturn: number;
  xirr: number | null;
  maxDrawdown: number;
}

function maxDrawdownOf(values: number[]): number {
  let peak = values[0];
  let mdd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = 1 - v / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

async function main(): Promise<void> {
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf8')) as DailyRecord[];
  const tr = await loadTrIndex();

  // 三序列对齐（与 backtest.ts 相同口径）
  const trMap = new Map(tr.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const chinext: number[] = [];
  const divTr: number[] = [];
  for (const r of hist) {
    const trClose = trMap.get(r.date);
    if (
      trClose === undefined ||
      !Number.isFinite(r.chinextClose) ||
      !Number.isFinite(r.dividendClose) ||
      !Number.isFinite(trClose)
    ) {
      continue;
    }
    dates.push(r.date);
    chinext.push(r.chinextClose as number);
    divTr.push(trClose);
  }

  // S4 信号用价格比值（创业板指 / 000922 价格指数，与页面口径一致）
  const priceRatioOf = new Map<string, number>();
  for (const r of hist) {
    if (
      Number.isFinite(r.chinextClose) &&
      Number.isFinite(r.dividendClose) &&
      (r.chinextClose as number) > 0
    ) {
      priceRatioOf.set(r.date, (r.chinextClose as number) / (r.dividendClose as number));
    }
  }
  const pRatio = dates.map((d) => priceRatioOf.get(d) ?? NaN);

  // S4 持仓序列（全历史演进，T 收盘信号 → 次日状态；避免硬编码窗口起点状态）
  type Leg = 'growth' | 'dividend';
  let state: Leg | null = null;
  const desiredState: (Leg | null)[] = dates.map((_, i) => {
    if (i > 0 && Number.isFinite(pRatio[i - 1])) {
      if (pRatio[i - 1] < STRATEGY.s4.low) state = 'growth';
      else if (pRatio[i - 1] > STRATEGY.s4.high) state = 'dividend';
    }
    return state;
  });

  // 窗口起点：最近 5 年
  const lastDate = dates[dates.length - 1];
  const startCal = new Date(lastDate);
  startCal.setUTCFullYear(startCal.getUTCFullYear() - WINDOW_YEARS);
  const startStr = startCal.toISOString().slice(0, 10);
  let winStart = dates.findIndex((d) => d >= startStr);
  if (winStart < 0) winStart = 0;
  const t0 = new Date(dates[winStart]).getTime();
  console.log(
    `[window] 近 ${WINDOW_YEARS} 年：${dates[winStart]} ~ ${lastDate}（${dates.length - winStart} 个交易日）`,
  );
  console.log(
    `[state] 窗口起点 S4 状态：${desiredState[winStart] ?? '未建立'}（起点价格比值 ${pRatio[winStart]?.toFixed(3)}）`,
  );

  // ---------- S4 + 网格定投 ----------
  let mainG = 0; // 主仓创业板份额
  let mainD = 0; // 主仓红利份额
  let mainCash = 0; // 主仓现金（定投入账、换仓清算）
  let poolUnits = 0; // 网格池跟随当前腿的份额
  let poolLeg: Leg = desiredState[winStart] ?? 'dividend';
  let poolCash = 0; // 池内现金（网格卖出回收、等待再部署）
  let anchor: number | null = null;
  const gridLots: { units: number }[] = [];
  let curMonth = '';
  let dcaCount = 0;
  let gridBuys = 0;
  let gridSells = 0;
  let stateSwitches = 0;
  const flows: { t: number; amt: number }[] = [
    { t: 0, amt: -INITIAL_CASH }, // 期初网格池资金
  ];
  const events: string[] = [];
  const tranche = GRID_POOL / GRID_TRANCHES;

  const buyUnits = (leg: Leg, amount: number, i: number) => {
    const price = leg === 'growth' ? chinext[i] : divTr[i];
    return (amount * (1 - COST)) / price;
  };
  const poolValue = (i: number) =>
    poolUnits * (poolLeg === 'growth' ? chinext[i] : divTr[i]) + poolCash;

  // 期初：池资金按当前状态买入
  {
    const i = winStart;
    poolUnits = buyUnits(poolLeg, INITIAL_CASH, i);
    events.push(`[init] ${dates[i]} 网格池 ${INITIAL_CASH} 元买入${poolLeg === 'growth' ? '创业板' : '红利'}`);
  }

  const values: number[] = [];
  for (let i = winStart; i < dates.length; i++) {
    const day = dates[i];
    const m = day.slice(0, 7);
    const target = desiredState[i] ?? 'dividend';

    // 1) 状态切换：清算全部（网格+池+主仓）→ 重建
    if (target !== poolLeg) {
      if (gridLots.length > 0) {
        for (const lot of gridLots) poolCash += lot.units * chinext[i] * (1 - COST);
        gridLots.length = 0;
      }
      if (poolUnits > 0) {
        poolCash += poolUnits * (poolLeg === 'growth' ? chinext[i] : divTr[i]) * (1 - COST);
        poolUnits = 0;
      }
      if (mainG > 0) mainCash += mainG * chinext[i] * (1 - COST);
      if (mainD > 0) mainCash += mainD * divTr[i] * (1 - COST);
      mainG = 0;
      mainD = 0;
      if (mainCash > MIN_CASH) {
        if (target === 'growth') mainG = buyUnits('growth', mainCash, i);
        else mainD = buyUnits('dividend', mainCash, i);
        mainCash = 0;
      }
      stateSwitches++;
      events.push(
        `[switch] ${day}（前日比值 ${pRatio[i - 1]?.toFixed(3)}）→ 切至${target === 'growth' ? '创业板' : '红利'}`,
      );
      poolLeg = target;
      anchor = null;
    }

    // 2) 每月首个交易日定投 → 按状态买入
    if (m !== curMonth) {
      curMonth = m;
      dcaCount++;
      flows.push({ t: (new Date(day).getTime() - t0) / 86400000, amt: -MONTHLY_DCA });
      if (target === 'growth') mainG += buyUnits('growth', MONTHLY_DCA, i);
      else mainD += buyUnits('dividend', MONTHLY_DCA, i);
    }

    // 3) 池资金跟随状态：红利状态下不闲置
    if (target === 'dividend' && poolCash > MIN_CASH && poolUnits === 0) {
      poolUnits = buyUnits('dividend', poolCash, i);
      poolCash = 0;
    }

    // 4) 网格逻辑（仅 growth 状态）
    if (target === 'growth') {
      const r = pRatio[i];
      if (anchor === null) anchor = r;
      while (poolCash >= tranche && r <= anchor - GRID_STEP) {
        gridLots.push({ units: buyUnits('growth', tranche, i) });
        poolCash -= tranche;
        gridBuys++;
        anchor = r;
        events.push(`[grid-buy] ${day} 比值 ${r.toFixed(3)} 加买 ${tranche} 元创业板`);
      }
      while (gridLots.length > 0 && r >= anchor + GRID_STEP) {
        const lot = gridLots.shift()!;
        poolCash += lot.units * chinext[i] * (1 - COST);
        gridSells++;
        anchor = r;
        events.push(`[grid-sell] ${day} 比值 ${r.toFixed(3)} 卖出一份网格份额`);
      }
    }

    values.push(mainG * chinext[i] + mainD * divTr[i] + poolValue(i) + mainCash);
  }

  const finalValue = values[values.length - 1];
  flows.push({ t: (new Date(lastDate).getTime() - t0) / 86400000, amt: finalValue });
  const totalInvested = INITIAL_CASH + MONTHLY_DCA * dcaCount;
  const strategyResult: RowResult & Record<string, unknown> = {
    name: 'S4 策略 + 网格定投',
    finalValue,
    totalInvested,
    totalReturn: finalValue / totalInvested - 1,
    xirr: xirr(flows),
    maxDrawdown: maxDrawdownOf(values),
    dcaCount,
    gridBuys,
    gridSells,
    stateSwitches,
    endMainLeg: mainG > 0 ? 'growth' : mainD > 0 ? 'dividend' : '—',
    endPoolLeg: poolLeg,
    endGridLots: gridLots.length,
    endCash: mainCash + poolCash,
    events,
  };

  // ---------- 基准（同现金流：期初 INITIAL_CASH + 每月 MONTHLY_DCA） ----------
  const runBenchmark = (mode: '50/50' | 'dividend' | 'growth'): RowResult => {
    let g = 0;
    let d = 0;
    let curYear = '';
    let curMonthB = '';
    const bFlows: { t: number; amt: number }[] = [{ t: 0, amt: -INITIAL_CASH }];
    const vals: number[] = [];
    const invest = (i: number, amount: number) => {
      if (mode === 'dividend') d += buyUnits('dividend', amount, i);
      else if (mode === 'growth') g += buyUnits('growth', amount, i);
      else {
        g += buyUnits('growth', amount * 0.5, i);
        d += buyUnits('dividend', amount * 0.5, i);
      }
    };
    invest(winStart, INITIAL_CASH);

    for (let i = winStart; i < dates.length; i++) {
      const day = dates[i];
      const y = day.slice(0, 4);
      const m = day.slice(0, 7);
      if (mode === '50/50' && y !== curYear && curYear !== '') {
        const total = g * chinext[i] + d * divTr[i];
        g = buyUnits('growth', total * 0.5, i);
        d = buyUnits('dividend', total * 0.5, i);
      }
      curYear = y;
      if (m !== curMonthB) {
        curMonthB = m;
        bFlows.push({ t: (new Date(day).getTime() - t0) / 86400000, amt: -MONTHLY_DCA });
        invest(i, MONTHLY_DCA);
      }
      vals.push(g * chinext[i] + d * divTr[i]);
    }
    const fv = vals[vals.length - 1];
    bFlows.push({ t: (new Date(lastDate).getTime() - t0) / 86400000, amt: fv });
    return {
      name:
        mode === '50/50'
          ? '基准：50/50 定投（年度再平衡）'
          : mode === 'dividend'
            ? '基准：全红利定投'
            : '基准：全创业板定投',
      finalValue: fv,
      totalInvested,
      totalReturn: fv / totalInvested - 1,
      xirr: xirr(bFlows),
      maxDrawdown: maxDrawdownOf(vals),
    };
  };

  const benchmarks = [runBenchmark('50/50'), runBenchmark('dividend'), runBenchmark('growth')];

  // ---------- 输出 ----------
  const fmtMoney = (v: number) => `${(v / 10000).toFixed(1)}万`;
  const rows = [strategyResult as unknown as RowResult, ...benchmarks];
  console.log(
    `\n=== 近 ${WINDOW_YEARS} 年 · 同现金流（期初 ${fmtMoney(INITIAL_CASH)} + 每月 ${fmtMoney(MONTHLY_DCA)} × ${dcaCount} 期 = ${fmtMoney(totalInvested)}）===`,
  );
  console.log(
    `${'方案'.padEnd(24)}  期末市值   累计收益    XIRR     最大回撤`,
  );
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(24)} ${fmtMoney(r.finalValue).padStart(8)}  ${(r.totalReturn * 100).toFixed(1).padStart(6)}%  ${r.xirr === null ? '   —' : `${(r.xirr * 100).toFixed(1)}%`.padStart(6)}  ${(r.maxDrawdown * 100).toFixed(1).padStart(7)}%`,
    );
  }

  console.log(`\n--- 策略事件（${events.length} 条）---`);
  for (const e of events) console.log(e);
  console.log(
    `\n期末：主仓 ${strategyResult.endMainLeg === 'growth' ? '创业板' : strategyResult.endMainLeg === 'dividend' ? '红利' : '—'}，` +
      `网格池${strategyResult.endPoolLeg === 'growth' ? `持有创业板份额 ×${strategyResult.endGridLots}` : '跟随红利'}，现金 ${fmtMoney(Number(strategyResult.endCash))}`,
  );

  const result = {
    generatedAt: new Date().toISOString(),
    caliber: {
      window: [dates[winStart], lastDate] as [string, string],
      tradingDays: dates.length - winStart,
      growthLeg: '399006 创业板指（价格指数）',
      dividendLeg: 'H00922 中证红利全收益（中证官网）',
      monthlyDca: MONTHLY_DCA,
      initialGridPool: GRID_POOL,
      gridTranches: GRID_TRANCHES,
      gridStep: GRID_STEP,
      costOneSide: COST,
      signalRule: `S4 价格比值 <${STRATEGY.s4.low} 入场 / >${STRATEGY.s4.high} 离场，T+1 执行`,
      disclaimer: '研究用途，非投资建议；历史表现不预示未来收益',
    },
    strategy: strategyResult,
    benchmarks,
  };
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\n[done] 结果已保存 ${path.relative(ROOT, RESULT_PATH)}`);
}

main().catch((e) => {
  console.error('[backtest-grid failed]', e);
  process.exit(1);
});
