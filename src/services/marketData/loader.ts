import type { Metadata } from '../../types/market';

/**
 * 前端数据加载器：
 * 1. 请求 metadata.json（no-store，始终拿最新版本号）
 * 2. 若版本与已加载版本不同，带版本参数拉取 historical.json（突破浏览器缓存）
 * 3. 数据加载后常驻内存，页面内所有图表切换均不再请求
 */

const DATA_BASE = import.meta.env.BASE_URL + 'data';

export async function fetchMetadata(): Promise<Metadata> {
  const resp = await fetch(`${DATA_BASE}/metadata.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`无法读取数据版本信息（HTTP ${resp.status}）`);
  return (await resp.json()) as Metadata;
}

export async function fetchHistorical(version: string): Promise<unknown[]> {
  const resp = await fetch(`${DATA_BASE}/historical.json?v=${encodeURIComponent(version)}`);
  if (!resp.ok) throw new Error(`无法加载历史行情数据（HTTP ${resp.status}）`);
  return (await resp.json()) as unknown[];
}

export async function loadDashboardData(): Promise<{ meta: Metadata; records: import('../../types/market').DailyRecord[] }> {
  const meta = await fetchMetadata();
  const raw = await fetchHistorical(meta.version);
  // 基础结构防御：过滤非法行，不编造数据
  const records = (raw as { date?: unknown; chinextClose?: unknown; dividendClose?: unknown; ratio?: unknown }[])
    .filter(
      (r): r is import('../../types/market').DailyRecord =>
        typeof r.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
        (r.chinextClose === null || typeof r.chinextClose === 'number') &&
        (r.dividendClose === null || typeof r.dividendClose === 'number') &&
        (r.ratio === null || typeof r.ratio === 'number'),
    );
  if (records.length === 0) throw new Error('历史数据文件为空或格式不符');
  return { meta, records };
}
