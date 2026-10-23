/**
 * 共享类型定义（数据脚本 + 前端共用）
 */

export interface DailyRecord {
  /** 交易日期 YYYY-MM-DD */
  date: string;
  /** 创业板指数收盘点位（无数据为 null） */
  chinextClose: number | null;
  /** 中证红利指数收盘点位（无数据为 null） */
  dividendClose: number | null;
  /** 相对比值 = chinextClose / dividendClose（两指数均有数据时才有值，保留 6 位小数） */
  ratio: number | null;
}

export interface Metadata {
  /** 数据来源标识 */
  source: string;
  /** 数据来源展示名 */
  sourceName: string;
  /** 数据口径说明 */
  caliber: string;
  indices: {
    chinext: { code: string; name: string; providerCode: string };
    dividend: { code: string; name: string; providerCode: string };
  };
  /** 页面时间轴起点（创业板开市日） */
  timelineStart: string;
  /** 实际最早有任一指数收盘数据的日期 */
  dataStartDate: string | null;
  /** 最早有相对比值的日期 */
  ratioStartDate: string | null;
  /** 最新有效交易日期（两个指数中任一有数据的最近日期） */
  latestTradeDate: string | null;
  /** 最后一次成功更新的时间（ISO 8601，UTC） */
  lastUpdated: string | null;
  /** 数据版本（用最新交易日 + 记录数派生，前端据此识别新版本） */
  version: string;
  /** 记录总数 */
  count: number;
}

/** 前端加载状态 */
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** 当前相对位置状态 */
export type RatioStatus = 'low' | 'mid' | 'high';
