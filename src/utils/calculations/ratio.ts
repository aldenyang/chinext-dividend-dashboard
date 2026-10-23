import type { DailyRecord } from '../../types/market';

/** 0.3 / 0.7 历史参考线（用户指定的研究参考阈值） */
export const LOW_REF = 0.3;
export const HIGH_REF = 0.7;

export function computeRatio(chinext: number, dividend: number): number {
  return chinext / dividend;
}

export function getRatioStatus(ratio: number): 'low' | 'mid' | 'high' {
  if (ratio <= LOW_REF) return 'low';
  if (ratio >= HIGH_REF) return 'high';
  return 'mid';
}

export const STATUS_TEXT: Record<'low' | 'mid' | 'high', string> = {
  low: '历史低位参考区',
  mid: '历史参考区间',
  high: '历史高位参考区',
};

export const STATUS_COLOR: Record<'low' | 'mid' | 'high', string> = {
  low: '#20A97B',
  mid: '#8792A5',
  high: '#E65B64',
};

/** 与参考线的绝对差值展示（正负号 + 3 位小数） */
export function diffToRefs(ratio: number): { toLow: string; toHigh: string } {
  const toLow = ratio - LOW_REF;
  const toHigh = ratio - HIGH_REF;
  const fmt = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(3)}`;
  return { toLow: fmt(toLow), toHigh: fmt(toHigh) };
}

/** 单日涨跌幅（%），缺少上一有效交易日返回 null */
export function dailyChangePct(records: DailyRecord[], date: string, key: 'chinextClose' | 'dividendClose'): number | null {
  const idx = records.findIndex((r) => r.date === date);
  if (idx <= 0) return null;
  const cur = records[idx][key];
  const prev = records[idx - 1][key];
  if (cur === null || prev === null || prev === 0) return null;
  return (cur / prev - 1) * 100;
}

export interface Extreme {
  date: string;
  ratio: number;
  record: DailyRecord;
}

/** 全历史比值极值（仅统计两指数均有数据的日期） */
export function findExtremes(records: DailyRecord[]): { low: Extreme | null; high: Extreme | null } {
  let low: Extreme | null = null;
  let high: Extreme | null = null;
  for (const r of records) {
    if (r.ratio === null) continue;
    if (!low || r.ratio < low.ratio) low = { date: r.date, ratio: r.ratio, record: r };
    if (!high || r.ratio > high.ratio) high = { date: r.date, ratio: r.ratio, record: r };
  }
  return { low, high };
}

/** 最新一条「任一指数有数据」的记录 */
export function latestRecord(records: DailyRecord[]): DailyRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.chinextClose !== null || r.dividendClose !== null) return r;
  }
  return null;
}
