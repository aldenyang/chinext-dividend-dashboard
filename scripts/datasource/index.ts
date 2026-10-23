/**
 * 数据源选择器：主源失败自动降级到备源
 * 环境变量 DATA_SOURCE 可强制指定：eastmoney | tencent
 */
import { DataSourceAdapter, DataSourceError } from './types.ts';
import { eastmoneyAdapter } from './eastmoney.ts';
import { tencentAdapter } from './tencent.ts';

const adapters: DataSourceAdapter[] = [eastmoneyAdapter, tencentAdapter];

export function getAdapters(): DataSourceAdapter[] {
  const forced = process.env.DATA_SOURCE?.trim();
  if (forced) {
    const hit = adapters.find((a) => a.id === forced);
    if (!hit) throw new Error(`未知数据源: ${forced}，可选: ${adapters.map((a) => a.id).join(' | ')}`);
    return [hit];
  }
  return adapters;
}

/**
 * 依次尝试适配器列表，返回第一个能成功拉取两个指数数据的适配器。
 */
export async function withFallback<T>(
  fn: (adapter: DataSourceAdapter) => Promise<T>,
): Promise<{ result: T; adapter: DataSourceAdapter; degradedFrom?: DataSourceAdapter }> {
  const list = getAdapters();
  const errors: string[] = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const result = await fn(list[i]);
      return { result, adapter: list[i], degradedFrom: i > 0 ? list[0] : undefined };
    } catch (e) {
      const msg = e instanceof DataSourceError ? e.message : String(e);
      errors.push(`${list[i].name}: ${msg}`);
      console.error(`[数据源失败] ${msg}`);
    }
  }
  throw new Error(`所有数据源均不可用：\n${errors.join('\n')}`);
}

export * from './types.ts';
