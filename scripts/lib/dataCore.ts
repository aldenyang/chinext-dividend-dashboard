/**
 * 数据合并、校验与原子写入的共享逻辑
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DailyRecord, Metadata } from '../../src/types/market.ts';
import { emptyMetadata, TIMELINE_START, type DataSourceAdapter, type IndexQuote } from '../datasource/types.ts';

export const DATA_DIR = path.resolve(process.cwd(), 'public/data');
export const HISTORICAL_PATH = path.join(DATA_DIR, 'historical.json');
export const METADATA_PATH = path.join(DATA_DIR, 'metadata.json');

const RATIO_PRECISION = 6;

/** 按日期建索引映射 */
export function toMap(quotes: IndexQuote[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const q of quotes) {
    // 只保留有效收盘价（>0），重复日期以第一次为准
    if (Number.isFinite(q.close) && q.close > 0 && !m.has(q.date)) {
      m.set(q.date, q.close);
    }
  }
  return m;
}

/**
 * 用两个指数的行情构建记录集：
 * - 时间轴从 TIMELINE_START 起
 * - 任一指数有数据即保留该日期（另一指数为 null）
 * - 两指数均有数据才计算比值，保留 6 位小数
 */
export function buildRecords(
  chinext: IndexQuote[],
  dividend: IndexQuote[],
  timelineStart: string = TIMELINE_START,
): DailyRecord[] {
  const cnMap = toMap(chinext);
  const dvMap = toMap(dividend);
  const dates = new Set<string>([...cnMap.keys(), ...dvMap.keys()]);
  const sorted = [...dates].filter((d) => d >= timelineStart).sort();

  const records: DailyRecord[] = [];
  for (const date of sorted) {
    const chinextClose = cnMap.get(date) ?? null;
    const dividendClose = dvMap.get(date) ?? null;
    let ratio: number | null = null;
    if (chinextClose !== null && dividendClose !== null && dividendClose > 0) {
      ratio = Number((chinextClose / dividendClose).toFixed(RATIO_PRECISION));
    }
    records.push({ date, chinextClose, dividendClose, ratio });
  }
  return records;
}

/** 合并新增/修正记录：同日新记录覆盖旧记录，升序去重 */
export function mergeRecords(existing: DailyRecord[], incoming: DailyRecord[]): DailyRecord[] {
  const map = new Map<string, DailyRecord>();
  for (const r of existing) map.set(r.date, r);
  for (const r of incoming) map.set(r.date, r);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
}

/**
 * 数据校验：日期排序、去重、比值一致性、异常值
 */
export function validateRecords(records: DailyRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let prevDate = '';
  const seen = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      issues.push({ level: 'error', message: `日期格式非法: ${r.date}` });
      continue;
    }
    if (r.date <= prevDate) {
      issues.push({ level: 'error', message: `日期未升序或重复: index=${i} date=${r.date}` });
    }
    if (seen.has(r.date)) {
      issues.push({ level: 'error', message: `重复日期: ${r.date}` });
    }
    seen.add(r.date);
    prevDate = r.date;

    for (const [k, v] of [
      ['chinextClose', r.chinextClose],
      ['dividendClose', r.dividendClose],
    ] as const) {
      if (v !== null && (!Number.isFinite(v) || v <= 0)) {
        issues.push({ level: 'error', message: `${r.date} ${k} 非法: ${v}` });
      }
    }

    if (r.chinextClose !== null && r.dividendClose !== null) {
      const expected = Number((r.chinextClose / r.dividendClose).toFixed(RATIO_PRECISION));
      if (r.ratio === null || Math.abs(r.ratio - expected) > 1e-6) {
        issues.push({ level: 'error', message: `${r.date} 比值不一致: 存=${r.ratio} 算=${expected}` });
      }
    } else if (r.ratio !== null) {
      issues.push({ level: 'error', message: `${r.date} 缺收盘价却有比值: ${r.ratio}` });
    }

    // 日波动超过 ±15% 提示（指数罕见，可能数据异常）
    if (i > 0 && r.chinextClose !== null && records[i - 1].chinextClose !== null) {
      const prev = records[i - 1].chinextClose as number;
      const chg = Math.abs(r.chinextClose / prev - 1);
      if (chg > 0.15) {
        issues.push({ level: 'warn', message: `${r.date} 创业板指单日波动 ${(chg * 100).toFixed(1)}%，请人工复核` });
      }
    }
    if (i > 0 && r.dividendClose !== null && records[i - 1].dividendClose !== null) {
      const prev = records[i - 1].dividendClose as number;
      const chg = Math.abs(r.dividendClose / prev - 1);
      if (chg > 0.15) {
        issues.push({ level: 'warn', message: `${r.date} 中证红利单日波动 ${(chg * 100).toFixed(1)}%，请人工复核` });
      }
    }
  }
  return issues;
}

export function buildMetadata(
  records: DailyRecord[],
  adapter: DataSourceAdapter,
  degradedFrom?: DataSourceAdapter,
): Metadata {
  const meta = emptyMetadata();
  meta.source = degradedFrom ? `${adapter.id} (fallback from ${degradedFrom.id})` : adapter.id;
  meta.sourceName = degradedFrom
    ? `${adapter.name}（主源 ${degradedFrom.name} 不可用时自动降级）`
    : adapter.name;
  meta.indices.chinext.providerCode = adapter.chinextSymbol;
  meta.indices.dividend.providerCode = adapter.dividendSymbol;

  const withData = records.filter((r) => r.chinextClose !== null || r.dividendClose !== null);
  const withRatio = records.filter((r) => r.ratio !== null);
  meta.dataStartDate = withData.length ? withData[0].date : null;
  meta.ratioStartDate = withRatio.length ? withRatio[0].date : null;
  meta.latestTradeDate = withData.length ? withData[withData.length - 1].date : null;
  meta.count = records.length;

  // 版本 = 最新交易日 + 记录数摘要，数据有任何变化版本即变化
  const raw = JSON.stringify(records);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  meta.version = `${meta.latestTradeDate ?? 'empty'}-${records.length}-${(hash >>> 0).toString(36)}`;
  return meta;
}

/** 临时文件写入 + 校验后替换，避免更新中断损坏文件 */
export function atomicWriteJson(filePath: string, data: unknown, label: string): void {
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, json, 'utf-8');
  // 写入后回读校验 JSON 可解析
  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as unknown;
  JSON.stringify(parsed); // 确认可序列化
  fs.renameSync(tmp, filePath);
  console.log(`[写入完成] ${label}: ${filePath} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
}

export function readHistorical(): { records: DailyRecord[] | null; meta: Metadata | null } {
  let meta: Metadata | null = null;
  let records: DailyRecord[] | null = null;
  if (fs.existsSync(METADATA_PATH)) {
    try {
      meta = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf-8')) as Metadata;
    } catch (e) {
      console.error('[警告] metadata.json 解析失败，将视为无元数据', e);
    }
  }
  if (fs.existsSync(HISTORICAL_PATH)) {
    try {
      records = JSON.parse(fs.readFileSync(HISTORICAL_PATH, 'utf-8')) as DailyRecord[];
    } catch (e) {
      console.error('[警告] historical.json 解析失败，将视为无历史数据', e);
    }
  }
  return { records, meta };
}

/** 网络请求间小延迟，礼貌限速 */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
