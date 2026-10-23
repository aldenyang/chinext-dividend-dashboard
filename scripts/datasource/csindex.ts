/**
 * 中证指数公司官网数据源（一手来源）
 *
 * 接口：www.csindex.com.cn/csindex-home/perf/index-perf（公开、免密钥）
 * 用途：获取全收益指数（如中证红利全收益 H00922）的日收盘数据。
 * 价格指数（000922 等）仍走东财/腾讯；全收益指数仅中证官方提供。
 *
 * 已校验（2026-10-23）：H00922 自 2010-06-01 起有数据（官网口径），
 * 与价格指数 000922 交易日完全对齐。单次请求实测 6 年无截断，按 4 年分片。
 */
import { DataSourceError, type IndexQuote } from './types.ts';

const API = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';

interface CsindexRow {
  tradeDate: string; // YYYYMMDD
  indexCode: string;
  close: number | null;
}

interface CsindexResponse {
  code: string;
  msg?: string;
  data: CsindexRow[] | null;
}

function shiftYears(d: string, years: number): string {
  const y = Number(d.slice(0, 4)) + years;
  return `${y}${d.slice(4)}`;
}

function nextDay(d: string): string {
  const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 抓取一个中证指数在指定日期范围内的日收盘数据（含全收益指数） */
export async function fetchCsindexDailyClose(
  indexCode: string,
  begin: string,
  end: string,
): Promise<IndexQuote[]> {
  const norm = (d: string) => d.replace(/-/g, '');
  const out: IndexQuote[] = [];
  let segBegin = norm(begin);
  const segEnd = norm(end);

  while (segBegin <= segEnd) {
    const segLast = shiftYears(segBegin, 4) < segEnd ? shiftYears(segBegin, 4) : segEnd;
    const url = `${API}?indexCode=${indexCode}&startDate=${segBegin}&endDate=${segLast}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new DataSourceError(`中证官网请求失败: ${url}`, 'csindex', e);
    }
    if (!resp.ok) {
      throw new DataSourceError(`中证官网 HTTP ${resp.status}`, 'csindex');
    }
    const json = (await resp.json()) as CsindexResponse;
    if (json.code !== '200') {
      throw new DataSourceError(`中证官网返回 code=${json.code} msg=${json.msg ?? ''}`, 'csindex');
    }
    for (const row of json.data ?? []) {
      const date = `${row.tradeDate.slice(0, 4)}-${row.tradeDate.slice(4, 6)}-${row.tradeDate.slice(6, 8)}`;
      const close = row.close;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || !Number.isFinite(close) || close <= 0) {
        continue;
      }
      out.push({ date, close });
    }
    segBegin = nextDay(segLast);
    if (segBegin > segEnd) break;
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true)));
}
