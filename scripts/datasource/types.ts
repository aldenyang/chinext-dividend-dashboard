/**
 * 数据源适配层类型定义
 *
 * 设计目标：数据采集与展示分离。新增数据商时实现 DataSourceAdapter 即可，
 * 不影响 update / initialize / 前端展示逻辑。
 */
import type { Metadata } from '../../src/types/market.ts';

export interface IndexQuote {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface FetchRangeParams {
  /** 指数代码（数据商格式，如 399006 / 000922） */
  symbol: string;
  /** 起始日期（含）YYYYMMDD 或 YYYY-MM-DD */
  begin: string;
  /** 结束日期（含） */
  end: string;
}

/** 单个指数的日行情抓取器 */
export interface IndexFetcher {
  /** 数据商标识 */
  id: string;
  /** 展示名 */
  name: string;
  /** 抓取一个指数在指定日期范围内的日收盘数据，按日期升序返回 */
  fetchDailyClose(params: FetchRangeParams): Promise<IndexQuote[]>;
}

export interface DataSourceAdapter {
  id: string;
  name: string;
  /** 创业板指数在该数据商下的代码 */
  chinextSymbol: string;
  /** 中证红利指数在该数据商下的代码 */
  dividendSymbol: string;
  fetchChinext(params: Omit<FetchRangeParams, 'symbol'>): Promise<IndexQuote[]>;
  fetchDividend(params: Omit<FetchRangeParams, 'symbol'>): Promise<IndexQuote[]>;
}

export class DataSourceError extends Error {
  constructor(
    message: string,
    public readonly sourceId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DataSourceError';
  }
}

export const TIMELINE_START = '2009-10-30'; // 创业板开市日，时间轴起点（非创业板指数据起点）

export function emptyMetadata(): Metadata {
  return {
    source: '',
    sourceName: '',
    caliber: '两个指数相同交易日的收盘点位（价格指数，未复权）相除得到相对比值；比值保留 6 位小数参与计算，界面展示 3 位小数',
    indices: {
      chinext: { code: '399006.SZ', name: '创业板指数', providerCode: '' },
      dividend: { code: '000922.SH', name: '中证红利指数', providerCode: '' },
    },
    timelineStart: TIMELINE_START,
    dataStartDate: null,
    ratioStartDate: null,
    latestTradeDate: null,
    lastUpdated: null,
    version: '',
    count: 0,
  };
}
