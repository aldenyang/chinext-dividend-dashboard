import type { DailyRecord } from '../types/market';

/**
 * 风格切换策略参数（回测研究口径）
 * 单一配置源：前端策略信号面板与 scripts/backtest*.ts 共用，改这里即全局生效。
 * 阈值来自 2010-06~2026-10 全历史回测（样本内结果，非投资建议）。
 */
export const STRATEGY = {
  /** S4：价格比值扩带固定阈值（网格扫描显示 0.32-0.40 × 0.60-0.68 为稳健参数平台） */
  s4: { low: 0.35, high: 0.65 },
  /** S6：价格比值滚动分位（窗口约 5 年交易日 1220 天） */
  s6: { windowDays: 1220, lowPct: 0.2, highPct: 0.8 },
  /** 执行假设：T 收盘出信号，T+1 收盘执行；换仓单边成本 */
  execution: { signalLagDays: 1, oneSideCost: 0.0015 },
} as const;

export type StrategyLeg = 'growth' | 'dividend';

export interface StrategyStatus {
  key: 's4' | 's6';
  name: string;
  rule: string;
  leg: StrategyLeg | null; // 当前规则持仓（null=尚未建立）
  current: string; // 当前指标值
  distance: string; // 距触发说明
}

/** 当前值在滚动窗口内的分位（0~1；窗口不满返回 null） */
export function rollingPercentile(series: number[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let count = 0;
  for (let j = i - window + 1; j <= i; j++) {
    if (series[j] <= series[i]) count++;
  }
  return count / window;
}

/** 由全历史记录推演两条策略的当前持仓状态与距触发信息 */
export function computeStrategyStatus(records: DailyRecord[]): StrategyStatus[] {
  const ratiosAll = records
    .map((r) => r.ratio)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const out: StrategyStatus[] = [];
  const last = ratiosAll[ratiosAll.length - 1];
  if (last === undefined) return out;

  // ---- S4：固定阈值状态机（从起点演进，区间内维持原状）----
  let s4Leg: StrategyLeg | null = null;
  for (const r of ratiosAll) {
    if (r < STRATEGY.s4.low) s4Leg = 'growth';
    else if (r > STRATEGY.s4.high) s4Leg = 'dividend';
  }
  const distLow = last - STRATEGY.s4.low;
  const distHigh = STRATEGY.s4.high - last;
  out.push({
    key: 's4',
    name: 'S4 固定阈值 0.35 / 0.65',
    rule: '比值 < 0.35 持创业板 · > 0.65 持红利 · 区间内维持',
    leg: s4Leg,
    current: `当前比值 ${last.toFixed(3)}`,
    distance:
      last < STRATEGY.s4.low
        ? '处于入场区'
        : last > STRATEGY.s4.high
          ? '处于离场区'
          : `距入场 +${distLow.toFixed(3)} · 距离场 +${distHigh.toFixed(3)}`,
  });

  // ---- S6：滚动分位状态机 ----
  const ratios = ratiosAll;
  const win = STRATEGY.s6.windowDays;
  const curPct = rollingPercentile(ratios, ratios.length - 1, win);
  let s6Leg: StrategyLeg | null = null;
  for (let i = 0; i < ratios.length; i++) {
    const q = rollingPercentile(ratios, i, win);
    if (q === null) continue;
    if (q < STRATEGY.s6.lowPct) s6Leg = 'growth';
    else if (q > STRATEGY.s6.highPct) s6Leg = 'dividend';
  }
  out.push({
    key: 's6',
    name: 'S6 滚动5年分位 20% / 80%',
    rule: '分位 < 20% 持创业板 · > 80% 持红利 · 区间内维持',
    leg: s6Leg,
    current: curPct === null ? '窗口不足' : `当前分位 ${(curPct * 100).toFixed(0)}%`,
    distance:
      curPct === null
        ? '历史数据不足一个窗口'
        : curPct < STRATEGY.s6.lowPct
          ? '处于入场区'
          : curPct > STRATEGY.s6.highPct
            ? '处于离场区'
            : `距入场 ${(Math.max(0, (STRATEGY.s6.lowPct - curPct) * 100)).toFixed(0)}pp · 距离场 ${(Math.max(0, (STRATEGY.s6.highPct - curPct) * 100)).toFixed(0)}pp`,
  });

  return out;
}
