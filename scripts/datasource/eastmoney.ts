/**
 * 东方财富历史K线数据源（主源）
 *
 * 接口：push2his.eastmoney.com kline API（公开、免密钥）
 * 指数代码映射：
 *   - 创业板指数 399006 -> secid 0.399006（深市前缀 0）
 *   - 中证红利 000922  -> secid 1.000922（沪市前缀 1）
 * 已校验（2026-10-23）：399006 数据自 2010-06-01 起；支持 beg/end 日期范围增量获取。
 */
import { DataSourceError, type DataSourceAdapter, type IndexQuote, type FetchRangeParams } from './types.ts';

const API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface EMResponse {
  data: {
    code: string;
    name: string;
    klines: string[]; // "YYYY-MM-DD,close[,open,...]" 视 fields2 而定
  } | null;
}

async function fetchOne(secid: string, begin: string, end: string): Promise<IndexQuote[]> {
  const url =
    `${API}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53` +
    `&klt=101&fqt=0&beg=${begin.replace(/-/g, '')}&end=${end.replace(/-/g, '')}&lmt=1000000`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new DataSourceError(`东方财富接口请求失败: ${url}`, 'eastmoney', e);
  }
  if (!resp.ok) {
    throw new DataSourceError(`东方财富接口 HTTP ${resp.status}`, 'eastmoney');
  }

  const json = (await resp.json()) as EMResponse;
  if (!json.data || !Array.isArray(json.data.klines)) {
    // 无数据不视为错误（如指数发布前的日期段），返回空数组
    return [];
  }

  const out: IndexQuote[] = [];
  for (const line of json.data.klines) {
    const parts = line.split(',');
    const date = parts[0];
    const close = Number(parts[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) {
      continue; // 过滤无效记录
    }
    out.push({ date, close });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function normalizeBegin(begin: string): string {
  // 时间轴早于指数发布时，直接从指数数据起点请求，避免无意义请求
  return begin < '20050101' ? '20050101' : begin;
}

export const eastmoneyAdapter: DataSourceAdapter = {
  id: 'eastmoney',
  name: '东方财富',
  chinextSymbol: '399006',
  dividendSymbol: '000922',

  async fetchChinext({ begin, end }: Omit<FetchRangeParams, 'symbol'>) {
    return fetchOne('0.399006', normalizeBegin(begin), end);
  },

  async fetchDividend({ begin, end }: Omit<FetchRangeParams, 'symbol'>) {
    return fetchOne('1.000922', normalizeBegin(begin), end);
  },
};

export function isEastmoneyAdapter(a: DataSourceAdapter): a is DataSourceAdapter & { id: 'eastmoney' } {
  return a.id === 'eastmoney';
}

export type { IndexQuote };
