/**
 * 增量更新：
 * 1. 读取本地 metadata + historical
 * 2. 向数据源请求「本地最新日期往前 30 个自然日」到今天的范围（覆盖 5 个交易日重查窗口与长假）
 * 3. 与历史合并（新数据覆盖同日旧数据，处理数据源历史修正）、去重、重算比值
 * 4. 校验通过后原子写入，更新 metadata；失败保留旧版本并退出非 0
 *
 * 用法：npm run data:update
 */
import path from 'node:path';
import { withFallback } from './datasource/index.ts';
import {
  buildRecords,
  buildMetadata,
  validateRecords,
  atomicWriteJson,
  readHistorical,
  mergeRecords,
} from './lib/dataCore.ts';

/** 重查窗口：本地最新交易日往前 30 个自然日（≥5 个交易日重查 + 春节等长假） */
const RECHECK_WINDOW_DAYS = 30;

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { records: existing, meta: localMeta } = readHistorical();
  if (!existing || existing.length === 0) {
    console.error('[中止] 无本地历史数据，请先运行 npm run data:init');
    process.exit(1);
  }
  const localLatest = existing[existing.length - 1].date;
  console.log(`[增量更新] 本地最新交易日: ${localLatest}，记录数: ${existing.length}`);

  const begin = shiftDate(localLatest, -RECHECK_WINDOW_DAYS);
  const end = new Date().toISOString().slice(0, 10);
  console.log(`[增量更新] 请求范围: ${begin} ~ ${end}（含近 5 个交易日重查修正窗口）`);

  const { result, adapter, degradedFrom } = await withFallback(async (a) => {
    const chinext = await a.fetchChinext({ begin, end });
    const dividend = await a.fetchDividend({ begin, end });
    return { chinext, dividend };
  });
  if (degradedFrom) {
    console.warn(`[降级] 主源 ${degradedFrom.name} 不可用，已使用备源 ${adapter.name}`);
  }
  console.log(`[${adapter.name}] 范围内返回: 创业板指 ${result.chinext.length} 条，中证红利 ${result.dividend.length} 条`);

  const fresh = buildRecords(result.chinext, result.dividend);
  const merged = mergeRecords(existing, fresh);

  // 判断是否有实际变化
  const changed =
    merged.length !== existing.length ||
    JSON.stringify(merged.slice(-RECHECK_WINDOW_DAYS * 2)) !==
      JSON.stringify(existing.slice(-(RECHECK_WINDOW_DAYS * 2)));

  const newLatest = merged[merged.length - 1].date;
  if (!changed && newLatest === localLatest) {
    console.log(`[无需更新] 数据源最新仍为 ${newLatest}（或仅无变化），保留现有数据。`);
    return;
  }

  // 未收盘/数据源未完成日线的防御：若新"最新日期"是今天且本地已有今天数据但收盘为 null，不允许写入 null 覆盖
  const issues = validateRecords(merged);
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  for (const w of warns) console.warn(`[校验警告] ${w.message}`);
  if (errors.length > 0) {
    console.error(`[校验失败] ${errors.length} 个错误，保留旧版本数据：`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e.message}`);
    process.exit(1);
  }

  const meta = buildMetadata(merged, adapter, degradedFrom);
  meta.lastUpdated = new Date().toISOString();

  atomicWriteJson(path.resolve(process.cwd(), 'public/data/historical.json'), merged, 'historical.json');
  atomicWriteJson(path.resolve(process.cwd(), 'public/data/metadata.json'), meta, 'metadata.json');

  console.log(`\n[更新完成] ${localLatest} -> ${meta.latestTradeDate}，总记录 ${meta.count}，版本 ${meta.version}`);
}

main().catch((e) => {
  console.error('[更新失败] 保留现有历史数据。', e);
  process.exit(1);
});
