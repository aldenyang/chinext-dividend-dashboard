/**
 * 腾讯财经历史K线数据源（备源）
 *
 * 接口：web.ifzq.gtimg.cn fqkline API（公开、免密钥）
 * 指数代码映射：
 *   - 创业板指数 399006 -> sz399006
 *   - 中证红利 000922  -> sh000922
 * 已校验（2026-10-23）：000922 自 2008-07-31 起有数据；与东财数据交叉比对一致。
 * 单次请求按日期范围返回，长区间按范围自动分段（每段约 3 年）。
 */
import { DataSourceError, type DataSourceAdapter, type IndexQuote } from './types.ts';

const API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

interface TencentResponse {
  code: number;
  msg?: string;
  data: Record<
    string,
    {
      day?: Array<[string, string, string, string, string, string] | string[]>;
      qt?: unknown;
    }
  >;
}

function normalizeDate(d: string): string {
  // 腾讯接口要求 YYYY-MM-DD 格式；容错接受 YYYYMMDD
  if (/^\d{8}$/.test(d)) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return d;
}

function addYears(d: string, years: number): string {
  const y = Number(d.slice(0, 4)) + years;
  return `${y}${d.slice(4)}`;
}

function nextDay(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

async function fetchOne(symbol: string, begin: string, end: string): Promise<IndexQuote[]> {
  const out: IndexQuote[] = [];
  // 按约 3 年一段分片请求，覆盖单次返回条数上限
  let segBegin = normalizeDate(begin);
  const segEnd = normalizeDate(end);

  while (segBegin <= segEnd) {
    const segLast = addYears(segBegin, 3) < segEnd ? addYears(segBegin, 3) : segEnd;
    const param = `${symbol},day,${segBegin},${segLast},800,`;
    let resp: Response;
    try {
      resp = await fetch(`${API}?param=${encodeURIComponent(param)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new DataSourceError(`腾讯接口请求失败: ${param}`, 'tencent', e);
    }
    if (!resp.ok) {
      throw new DataSourceError(`腾讯接口 HTTP ${resp.status}`, 'tencent');
    }
    const json = (await resp.json()) as TencentResponse;
    if (json.code !== 0) {
      throw new DataSourceError(`腾讯接口返回 code=${json.code} msg=${json.msg ?? ''}`, 'tencent');
    }

    const node = json.data?.[symbol];
    const rows = node?.day ?? [];
    for (const row of rows) {
      const date = row[0];
      const close = Number(row[2]); // [date, open, close, high, low, volume]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) {
        continue;
      }
      out.push({ date, close });
    }

    // 下一分片从本段末尾的次日开始（segLast 是 begin+3 年的同月同日，不是年末）
    segBegin = nextDay(segLast);
    if (segBegin > segEnd) break;
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  // 同日去重
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true)));
}

export const tencentAdapter: DataSourceAdapter = {
  id: 'tencent',
  name: '腾讯财经',
  chinextSymbol: 'sz399006',
  dividendSymbol: 'sh000922',

  async fetchChinext({ begin, end }) {
    return fetchOne(this.chinextSymbol, begin < '20050101' ? '20050101' : begin, end);
  },

  async fetchDividend({ begin, end }) {
    return fetchOne(this.dividendSymbol, begin < '20050101' ? '20050101' : begin, end);
  },
};
