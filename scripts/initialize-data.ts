/**
 * 首次初始化：获取两个指数全部可用历史，生成 historical.json + metadata.json
 *
 * 用法：npm run data:init
 * 可用环境变量：
 *   DATA_SOURCE=eastmoney|tencent  强制指定数据源
 */
import { withFallback, getAdapters } from './datasource/index.ts';
import { TIMELINE_START } from './datasource/types.ts';
import {
  buildRecords,
  buildMetadata,
  validateRecords,
  atomicWriteJson,
  readHistorical,
  HISTORICAL_PATH,
  METADATA_PATH,
  sleep,
} from './lib/dataCore.ts';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  if (fs.existsSync(HISTORICAL_PATH)) {
    const { meta } = readHistorical();
    console.error(
      `[中止] historical.json 已存在（${meta?.latestTradeDate ?? '未知版本'}）。` +
        `初始化仅限首次使用；日常更新请运行 npm run data:update。` +
        `如确认要重建，请先删除 public/data/historical.json`,
    );
    process.exit(1);
  }

  const adapter0 = getAdapters()[0];
  console.log(`[初始化] 数据源优先级: ${getAdapters().map((a) => a.name).join(' -> ')}`);

  const { result, adapter, degradedFrom } = await withFallback(async (a) => {
    console.log(`[${a.name}] 拉取创业板指数（${a.chinextSymbol}）全部历史...`);
    const chinext = await a.fetchChinext({ begin: TIMELINE_START, end: '20991231' });
    await sleep(500);
    console.log(`[${a.name}] 拉取中证红利指数（${a.dividendSymbol}）全部历史...`);
    const dividend = await a.fetchDividend({ begin: TIMELINE_START, end: '20991231' });
    return { chinext, dividend };
  });

  if (degradedFrom) {
    console.warn(`[降级] 主源 ${degradedFrom.name} 不可用，已使用备源 ${adapter.name}`);
  }

  console.log(`[结果] 创业板指 ${result.chinext.length} 条，中证红利 ${result.dividend.length} 条`);
  if (result.chinext.length === 0 && result.dividend.length === 0) {
    console.error('[错误] 两个指数均未获取到任何数据，不生成空文件。请检查网络或数据源。');
    process.exit(1);
  }

  const records = buildRecords(result.chinext, result.dividend);
  const issues = validateRecords(records);
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  for (const w of warns) console.warn(`[校验警告] ${w.message}`);
  if (errors.length > 0) {
    console.error(`[校验失败] ${errors.length} 个错误：`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e.message}`);
    console.error('已保留旧版本数据（本次未写入）。');
    process.exit(1);
  }

  const meta = buildMetadata(records, adapter, degradedFrom);
  meta.lastUpdated = new Date().toISOString();

  fs.mkdirSync(path.dirname(HISTORICAL_PATH), { recursive: true });
  atomicWriteJson(HISTORICAL_PATH, records, 'historical.json');
  atomicWriteJson(METADATA_PATH, meta, 'metadata.json');

  console.log('\n========== 初始化摘要 ==========');
  console.log(`数据来源: ${meta.sourceName}`);
  console.log(`指数代码: 创业板指 ${meta.indices.chinext.code} (provider: ${meta.indices.chinext.providerCode})`);
  console.log(`          中证红利 ${meta.indices.dividend.code} (provider: ${meta.indices.dividend.providerCode})`);
  console.log(`时间轴起点: ${meta.timelineStart}（创业板开市日）`);
  console.log(`首个有行情日期: ${meta.dataStartDate ?? '—'}`);
  console.log(`首个有比值日期: ${meta.ratioStartDate ?? '—'}`);
  console.log(`最新交易日: ${meta.latestTradeDate ?? '—'}`);
  console.log(`记录总数: ${meta.count}`);
  console.log(`数据版本: ${meta.version}`);
}

main().catch((e) => {
  console.error('[初始化失败]', e);
  process.exit(1);
});
