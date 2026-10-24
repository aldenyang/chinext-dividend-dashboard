/**
 * 行业维度分析：中证一级行业（沪深300行业指数系列，10 只）相关性矩阵 + 动量轮动回测
 *
 * 数据：腾讯财经 web.ifzq.gtimg.cn（sh000908~sh000917，2005 年起，价格指数口径）
 * 指数：000908 能源 / 000909 材料 / 000910 工业 / 000911 可选消费 / 000912 主要消费
 *       000913 医药卫生 / 000914 金融地产 / 000915 信息技术 / 000916 电信业务 / 000917 公用事业
 *
 * 思路：行业间的经典策略不是均值回归（比值有结构性趋势），而是动量轮动——
 *       按 N 日动量排序，持有最强 1~2 只行业，周度调仓。
 * 成本：单边 0.15%（近似对应行业 ETF 买卖）
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest-sector-result.json');

const API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const COST = 0.0015;
const TRADING_DAYS = 244;
const RF = 0.015;

const SECTORS: Array<{ code: string; name: string }> = [
  { code: 'sh000908', name: '能源' },
  { code: 'sh000909', name: '材料' },
  { code: 'sh000910', name: '工业' },
  { code: 'sh000911', name: '可选消费' },
  { code: 'sh000912', name: '主要消费' },
  { code: 'sh000913', name: '医药卫生' },
  { code: 'sh000914', name: '金融地产' },
  { code: 'sh000915', name: '信息技术' },
  { code: 'sh000916', name: '电信业务' },
  { code: 'sh000917', name: '公用事业' },
];

interface Quote {
  date: string;
  close: number;
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function loadIndex(symbol: string, begin = '2005-01-01'): Promise<Quote[]> {
  const cachePath = path.join(DATA_DIR, `${symbol}.json`);
  if (fs.existsSync(cachePath)) {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Quote[];
    console.log(`[cache] ${symbol}: ${c.length} 条（${c[0].date} ~ ${c[c.length - 1].date}）`);
    return c;
  }
  const out: Quote[] = [];
  let segBegin = begin;
  const segEnd = new Date().toISOString().slice(0, 10);
  while (segBegin <= segEnd) {
    const y = Number(segBegin.slice(0, 4)) + 3;
    const segLast = `${y}${segBegin.slice(4)}` < segEnd ? `${y}${segBegin.slice(4)}` : segEnd;
    const json = (await fetchJson(`${API}?param=${symbol},day,${segBegin},${segLast},800,`)) as {
      code: number;
      data: Record<string, { day?: string[][] }>;
    };
    if (json.code !== 0) throw new Error(`${symbol} code=${json.code}`);
    for (const r of json.data[symbol]?.day ?? []) {
      const close = Number(r[2]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(close) && close > 0) {
        out.push({ date: r[0], close });
      }
    }
    const d = new Date(`${segLast}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    segBegin = d.toISOString().slice(0, 10);
  }
  const seen = new Set<string>();
  const merged = out.filter((r) => !seen.has(r.date) && seen.add(r.date));
  merged.sort((x, y) => x.date.localeCompare(y.date));
  fs.writeFileSync(cachePath, JSON.stringify(merged));
  console.log(`[fetch] ${symbol}: ${merged.length} 条（${merged[0].date} ~ ${merged[merged.length - 1].date}）`);
  return merged;
}

function rets(c: number[]): number[] {
  return c.slice(1).map((v, i) => v / c[i] - 1);
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

async function main(): Promise<void> {
  const series: Array<{ name: string; q: Quote[] }> = [];
  for (const s of SECTORS) {
    series.push({ name: s.name, q: await loadIndex(s.code) });
  }

  // 对齐到共同交易日（以最长序列的日期为准）
  const dateSet = new Map<string, (number | null)[]>();
  for (const r of series[0].q) dateSet.set(r.date, series.map(() => null));
  for (let si = 0; si < series.length; si++) {
    for (const r of series[si].q) {
      const row = dateSet.get(r.date);
      if (row) row[si] = r.close;
    }
  }
  const dates: string[] = [];
  const C: number[][] = series.map(() => []); // C[sectorIdx] = closes
  for (const [date, row] of [...dateSet.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (row.some((v) => v === null)) continue;
    dates.push(date);
    row.forEach((v, i) => C[i].push(v as number));
  }
  console.log(`\n[align] ${series.length} 个行业，共同交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  const R: number[][] = C.map((c) => rets(c)); // R[sectorIdx][t]
  const n5 = Math.min(1212, R[0].length);

  // ---- 相关性矩阵 ----
  const corrOf = (i: number, j: number, tail?: number) => {
    const xa = tail ? R[i].slice(-tail) : R[i];
    const xb = tail ? R[j].slice(-tail) : R[j];
    return corr(xa, xb);
  };
  console.log('\n=== 相关性矩阵（日收益，全窗口 2005 起）===');
  const header = ''.padEnd(6) + SECTORS.map((s) => s.name.slice(0, 2).padStart(3)).join(' ');
  console.log(header);
  for (let i = 0; i < SECTORS.length; i++) {
    let line = SECTORS[i].name.slice(0, 4).padEnd(6);
    for (let j = 0; j < SECTORS.length; j++) {
      line += (i === j ? '  -  ' : corrOf(i, j).toFixed(2).padStart(5)) + ' ';
    }
    console.log(line);
  }
  console.log('\n=== 相关性矩阵（近 5 年）===');
  console.log(header);
  for (let i = 0; i < SECTORS.length; i++) {
    let line = SECTORS[i].name.slice(0, 4).padEnd(6);
    for (let j = 0; j < SECTORS.length; j++) {
      line += (i === j ? '  -  ' : corrOf(i, j, n5).toFixed(2).padStart(5)) + ' ';
    }
    console.log(line);
  }
  // 全部对子排序（排除自身），找最低相关组合
  const allPairs: Array<{ a: string; b: string; full: number; y5: number }> = [];
  for (let i = 0; i < SECTORS.length; i++)
    for (let j = i + 1; j < SECTORS.length; j++)
      allPairs.push({ a: SECTORS[i].name, b: SECTORS[j].name, full: corrOf(i, j), y5: corrOf(i, j, n5) });
  allPairs.sort((x, y) => x.full - y.full);
  console.log('\n=== 相关性最低的 8 组对子 ===');
  for (const p of allPairs.slice(0, 8)) {
    console.log(`${p.a} × ${p.b}：全窗口 ${p.full.toFixed(3)}｜近5年 ${p.y5.toFixed(3)}`);
  }

  // ---- 动量轮动回测 ----
  // 信号：截至 T-1 收盘的 N 日动量（T-1 / T-1-N - 1）；T 日按信号调仓（T+1 成交口径简化为次日生效）
  // 调仓：每 5 个交易日检查一次
  const runRotation = (momDays: number, topK: number, label: string, startIdx: number) => {
    let value = 1;
    let peak = 1;
    let mdd = 0;
    let sw = 0;
    const rs: number[] = [];
    let held: number[] = [];
    const starts = dates.slice(startIdx);
    let tradeLog: string[] = [];
    for (let t = 0; t < starts.length && startIdx + t <= dates.length - 2; t++) {
      const gi = startIdx + t; // 全局收益索引（R[i][gi] 对应 dates[gi+1] 的日收益）
      // 每 5 日重新计算目标持仓
      if (t % 5 === 0 && gi >= momDays) {
        const scores = SECTORS.map((_, si) => {
          // 信号日为 dates[gi] 收盘（该日调仓、赚取 gi+1 的日收益），动量只用到 gi 收盘价
          return C[si][gi] / C[si][gi - momDays] - 1;
        });
        const ranked = scores.map((s, si) => ({ s, si })).sort((a, b) => b.s - a.s);
        const target = ranked.slice(0, topK).map((r) => r.si);
        if (target.join() !== held.join()) {
          value *= 1 - COST;
          sw++;
          tradeLog.push(
            `${starts[t]} → ${target.map((si) => SECTORS[si].name).join('+')}`,
          );
          held = target;
        }
      }
      const r = held.length ? held.reduce((acc, si) => acc + R[si][gi], 0) / held.length : 0;
      value *= 1 + r;
      rs.push(r);
      if (value > peak) peak = value;
      const dd = 1 - value / peak;
      if (dd > mdd) mdd = dd;
    }
    const days = starts.length;
    const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
    const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
    const variance = rs.reduce((x, y) => x + (y - mean) ** 2, 0) / (rs.length - 1);
    const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
    return {
      label,
      cagr,
      vol,
      sharpe0: cagr / vol,
      sharpeRf: (cagr - RF) / vol,
      mdd,
      sw,
      mult: value,
      trades: tradeLog,
    };
  };

  const bench = (label: string, fn: (si: number, t: number) => number, startIdx: number) => {
    let value = 1;
    let peak = 1;
    let mdd = 0;
    const rs: number[] = [];
    for (let t = 0; t < dates.length - startIdx && startIdx + t <= dates.length - 2; t++) {
      const r = fn(0, startIdx + t);
      value *= 1 + r;
      rs.push(r);
      if (value > peak) peak = value;
      const dd = 1 - value / peak;
      if (dd > mdd) mdd = dd;
    }
    const days = dates.length - startIdx;
    const cagr = Math.pow(value, TRADING_DAYS / days) - 1;
    const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
    const variance = rs.reduce((x, y) => x + (y - mean) ** 2, 0) / (rs.length - 1);
    const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
    return { label, cagr, vol, sharpe0: cagr / vol, sharpeRf: (cagr - RF) / vol, mdd, sw: 0, mult: value, trades: [] as string[] };
  };

  const print = (title: string, rows: Array<Record<string, unknown>>) => {
    console.log(`\n=== ${title} ===`);
    const w = [34, 9, 8, 8, 8, 9, 6, 9];
    console.log(['策略', 'CAGR', '波动', '夏普0', '夏普rf', '最大回撤', '换手', '期末倍数'].map((h, i) => h.padEnd(w[i])).join(''));
    for (const m of rows) {
      console.log(
        [
          m.label,
          `${((m.cagr as number) * 100).toFixed(2)}%`,
          `${((m.vol as number) * 100).toFixed(2)}%`,
          (m.sharpe0 as number).toFixed(2),
          (m.sharpeRf as number).toFixed(2),
          `${((m.mdd as number) * 100).toFixed(2)}%`,
          m.sw,
          (m.mult as number).toFixed(2),
        ]
          .map((c, i) => String(c).padEnd(w[i]))
          .join(''),
      );
    }
  };

  const fullStart = Math.max(...SECTORS.map((_, si) => 60)); // 动量窗口上限留足
  const start5y = dates.length - 1 - 1212;

  const fullRows = [
    runRotation(20, 1, '动量20日 持有最强1行业', fullStart),
    runRotation(20, 2, '动量20日 最强2行业各半', fullStart),
    runRotation(60, 1, '动量60日 持有最强1行业', fullStart),
    runRotation(60, 2, '动量60日 最强2行业各半', fullStart),
    bench('基准：10行业等权', (_s, gi) => R.reduce((acc, r) => acc + r[gi], 0) / R.length, fullStart),
  ];
  print(`行业动量轮动·全窗口（${dates[fullStart]} ~ ${dates[dates.length - 1]}，约20年）`, fullRows);

  const y5Rows = [
    runRotation(20, 1, '动量20日 持有最强1行业', start5y),
    runRotation(20, 2, '动量20日 最强2行业各半', start5y),
    runRotation(60, 1, '动量60日 持有最强1行业', start5y),
    runRotation(60, 2, '动量60日 最强2行业各半', start5y),
    bench('基准：10行业等权', (_s, gi) => R.reduce((acc, r) => acc + r[gi], 0) / R.length, start5y),
  ];
  print(`行业动量轮动·近5年（${dates[start5y]} ~ ${dates[dates.length - 1]}）`, y5Rows);

  // 最优策略的交易明细（全窗口，取换手最少的那组展示尾部若干条）
  const best = fullRows.reduce((a, b) => ((b.sharpeRf as number) > (a.sharpeRf as number) ? b : a));
  console.log(`\n=== 交易明细（全窗口最优：${best.label}，共 ${best.sw} 次调仓，展示最近 15 条）===`);
  for (const t of (best.trades as string[]).slice(-15)) console.log('  ' + t);

  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sectors: SECTORS,
        aligned: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
        lowestCorrPairs: allPairs.slice(0, 8),
        fullWindow: fullRows,
        last5y: y5Rows,
      },
      null,
      2,
    ),
  );
  console.log(`\n[done] ${path.relative(ROOT, RESULT_PATH)}`);
}

main().catch((e) => {
  console.error('[failed]', e);
  process.exit(1);
});
