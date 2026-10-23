/**
 * 定期全量完整性检查（由 GitHub Actions 每周运行一次，也可本地手动执行）：
 * - 全量重新拉取两个指数历史（只读比对，不直接覆盖线上数据）
 * - 检查本地数据是否存在缺口、数据源修订差异
 * - 发现差异时输出明细并以非 0 退出（工作流中可配置自动修复）
 *
 * 用法：npm run data:validate
 * 自动修复：npm run data:validate -- --fix
 */
import { withFallback } from './datasource/index.ts';
import { TIMELINE_START } from './datasource/types.ts';
import { buildRecords, validateRecords, readHistorical, mergeRecords, atomicWriteJson } from './lib/dataCore.ts';
import path from 'node:path';

async function main() {
  const fix = process.argv.includes('--fix');
  const { records: existing, meta } = readHistorical();
  if (!existing || existing.length === 0) {
    console.error('[中止] 无本地历史数据，请先运行 npm run data:init');
    process.exit(1);
  }
  console.log(`[完整性检查] 本地记录 ${existing.length} 条，最新 ${meta?.latestTradeDate}`);

  const { result, adapter, degradedFrom } = await withFallback(async (a) => {
    const chinext = await a.fetchChinext({ begin: TIMELINE_START, end: '20991231' });
    const dividend = await a.fetchDividend({ begin: TIMELINE_START, end: '20991231' });
    return { chinext, dividend };
  });
  if (degradedFrom) console.warn(`[降级] 使用备源 ${adapter.name}`);

  const remoteRecords = buildRecords(result.chinext, result.dividend);

  // 1) 本地数据内在校验
  const issues = validateRecords(existing);
  const localErrors = issues.filter((i) => i.level === 'error');
  const localWarns = issues.filter((i) => i.level === 'warn');
  for (const w of localWarns) console.warn(`[本地警告] ${w.message}`);

  // 2) 远端与本地差异（远端有而本地缺、收盘价修订）
  const localMap = new Map(existing.map((r) => [r.date, r]));
  const missing: string[] = [];
  const revised: string[] = [];
  for (const r of remoteRecords) {
    const local = localMap.get(r.date);
    if (!local) {
      missing.push(r.date);
    } else if (
      (r.chinextClose !== null &&
        local.chinextClose !== null &&
        Math.abs(r.chinextClose - local.chinextClose) > 1e-6) ||
      (r.dividendClose !== null &&
        local.dividendClose !== null &&
        Math.abs(r.dividendClose - local.dividendClose) > 1e-6)
    ) {
      revised.push(r.date);
    }
  }

  console.log('\n========== 检查结果 ==========');
  console.log(`本地内在错误: ${localErrors.length}`);
  console.log(`远端缺失记录（本地缺、数据源有）: ${missing.length}${missing.length ? '，如 ' + missing.slice(0, 10).join(', ') : ''}`);
  console.log(`历史修订（收盘价与本地不一致）: ${revised.length}${revised.length ? '，如 ' + revised.slice(0, 10).join(', ') : ''}`);

  if (fix && (missing.length > 0 || revised.length > 0)) {
    const merged = mergeRecords(existing, remoteRecords);
    const newMeta = {
      ...meta!,
      count: merged.length,
      latestTradeDate: merged[merged.length - 1].date,
      lastUpdated: new Date().toISOString(),
    };
    newMeta.version = `${newMeta.latestTradeDate}-${merged.length}-fixed`;
    atomicWriteJson(path.resolve(process.cwd(), 'public/data/historical.json'), merged, 'historical.json');
    atomicWriteJson(path.resolve(process.cwd(), 'public/data/metadata.json'), newMeta, 'metadata.json');
    console.log(`[已修复] 合并后记录 ${merged.length} 条`);
    return;
  }

  if (localErrors.length > 0 || missing.length > 0 || revised.length > 0) {
    console.error('\n[结论] 发现需要处理的数据问题（可用 --fix 自动合并修复）');
    process.exit(1);
  }
  console.log('\n[结论] 数据完整性检查通过');
}

main().catch((e) => {
  console.error('[检查失败]', e);
  process.exit(1);
});
