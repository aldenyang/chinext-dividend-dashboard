/**
 * 可转债轮动策略（雪球 ZH3068836 多因子轮动）独立校验与 beta 分解
 *
 * 背景：用户提供一份该组合的 AI 分析报告（数据截至 2026-10-09），
 *       官方口径：累计 +157.34%、CAGR 22.86%、MDD -10.39%、波动 13.4%、
 *       夏普 1.57、Calmar 2.21；年度收益 2022 +20.6 / 2023 +16.7 /
 *       2024 +31.3 / 2025 +24.6 / 2026 +11.8（%）。
 *
 * 雪球 cubes 接口匿名访问被封（400016/567），无法拉到组合日净值 →
 * 本脚本做两件事：
 *   A. 校验报告数字自洽性（用年度收益重建净值与指标，对照官方口径）
 *   B. 独立拉取同期基准：中证转债(000832)、沪深300(000905 用 000300 替代)、
 *      计算同一窗口的 CAGR/波动/夏普/回撤/Calmar + 年度收益，
 *      并逐年计算策略相对转债指数的超额 → 回答「能力 vs 转债 beta」。
 *
 * 窗口：2022-03-07 ~ 2026-10-09（报告口径 4.59 年，1113 个交易日）
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TRADING_DAYS = 244;
const RF = 0.02; // 报告口径无风险利率 2%

interface Quote {
  date: string;
  close: number;
}

// ---- 官方报告口径 ----
const OFFICIAL = {
  start: '2022-03-07',
  end: '2026-10-09',
  years: 4.59,
  navEnd: 2.5734,
  totalRet: 1.5734,
  cagr: 0.2286,
  mdd: -0.1039,
  mddWindow: ['2024-01-02', '2024-02-05'] as const,
  vol: 0.134,
  sharpe: 1.57,
  sortino: 2.44,
  calmar: 2.21,
  // 自然年收益（2026 为截至 10-09 的年内收益）
  annual: { 2022: 0.206, 2023: 0.167, 2024: 0.313, 2025: 0.246, 2026: 0.118 } as Record<number, number>,
};

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function loadIndex(symbol: string, begin: string): Promise<Quote[]> {
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
      if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(close) && close > 0) out.push({ date: r[0], close });
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

interface Metrics {
  name: string;
  cagr: number;
  vol: number;
  sharpe: number;
  sortino: number;
  mdd: number;
  mddSpan: [string, string];
  calmar: number;
  annual: Record<number, number>;
  days: number;
}

function computeMetrics(name: string, q: Quote[], start: string, end: string): Metrics {
  const w = q.filter((r) => r.date >= start && r.date <= end);
  const closes = w.map((r) => r.close);
  const dates = w.map((r) => r.date);
  const rets = closes.slice(1).map((v, i) => v / closes[i] - 1);

  const days = rets.length;
  const total = closes[closes.length - 1] / closes[0];
  const cagr = Math.pow(total, TRADING_DAYS / days) - 1;
  const mean = rets.reduce((x, y) => x + y, 0) / days;
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (days - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  const sharpe = (cagr - RF) / vol;

  // Sortino（下行波动，MAR=0）
  const downside = rets.filter((r) => r < 0);
  const dVar = downside.reduce((x, y) => x + y * y, 0) / days; // 全样本为分母
  const dVol = Math.sqrt(dVar) * Math.sqrt(TRADING_DAYS);
  const sortino = cagr / dVol;

  // MDD
  let peak = closes[0];
  let peakIdx = 0;
  let mdd = 0;
  let mddSpan: [string, string] = [dates[0], dates[0]];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] > peak) {
      peak = closes[i];
      peakIdx = i;
    }
    const dd = closes[i] / peak - 1;
    if (dd < mdd) {
      mdd = dd;
      mddSpan = [dates[peakIdx], dates[i]];
    }
  }
  const calmar = cagr / Math.abs(mdd);

  // 自然年收益
  const annual: Record<number, number> = {};
  let yearStart = closes[0];
  let curYear = Number(dates[0].slice(0, 4));
  for (let i = 1; i < dates.length; i++) {
    const y = Number(dates[i].slice(0, 4));
    if (y !== curYear) {
      annual[curYear] = closes[i - 1] / yearStart - 1;
      yearStart = closes[i - 1];
      curYear = y;
    }
  }
  annual[curYear] = closes[closes.length - 1] / yearStart - 1;

  return { name, cagr, vol, sharpe, sortino, mdd, mddSpan, calmar, annual, days };
}

// ---- A. 报告自洽性校验（年度收益重建）----
function verifyReport(): void {
  console.log('\n=== A. 报告数字自洽性校验 ===');
  const years = Object.keys(OFFICIAL.annual).map(Number).sort();
  let nav = 1;
  const navs: number[] = [];
  for (const y of years) {
    nav *= 1 + OFFICIAL.annual[y];
    navs.push(nav);
  }
  const spanYears = 4 + (OFFICIAL.annual[2026] !== undefined ? 0.69 : 0); // 2022-03-07 起到 2026-10-09 约 4.59 年
  const cagr = Math.pow(nav, 1 / spanYears) - 1;
  console.log(
    `年度收益连乘期末净值 ${nav.toFixed(4)} vs 官方 ${OFFICIAL.navEnd}（差 ${(nav - OFFICIAL.navEnd).toFixed(4)}）`,
  );
  console.log(
    `重建 CAGR（4.59 年）${(cagr * 100).toFixed(2)}% vs 官方 ${(OFFICIAL.cagr * 100).toFixed(2)}%`,
  );
  const rets = years.map((y) => OFFICIAL.annual[y]);
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1));
  console.log(`年度收益算术均值 ${(mean * 100).toFixed(1)}%、年际波动 ${(vol * 100).toFixed(1)}pp（5 个点，仅方向参考）`);
  console.log(`连续正收益年份数：${rets.filter((r) => r > 0).length}/${rets.length}`);
}

// ---- 汇总打印 ----
function printTable(rows: Metrics[]): void {
  console.log('\n=== B. 同窗口基准对比（独立计算） ===');
  console.log(`窗口内交易日：${rows[0].days}（报告口径 1113）`);
  const header = ['标的', 'CAGR', '波动', '夏普rf2', 'Sortino', '最大回撤', 'Calmar'];
  const w = [16, 9, 8, 9, 9, 18, 8];
  console.log(header.map((h, i) => h.padEnd(w[i])).join(''));
  for (const m of rows) {
    console.log(
      [
        m.name,
        `${(m.cagr * 100).toFixed(2)}%`,
        `${(m.vol * 100).toFixed(1)}%`,
        m.sharpe.toFixed(2),
        m.sortino.toFixed(2),
        `${(m.mdd * 100).toFixed(2)}%`,
        m.calmar.toFixed(2),
      ]
        .map((c, i) => String(c).padEnd(w[i]))
        .join(''),
    );
    console.log(`  回撤区间：${m.mddSpan[0]} ~ ${m.mddSpan[1]}　年度：${Object.entries(m.annual).map(([y, r]) => `${y} ${(r * 100).toFixed(1)}%`).join(' / ')}`);
  }
}

async function main(): Promise<void> {
  const [cb, hs300] = await Promise.all([loadIndex('sh000832', '2021-06-01'), loadIndex('sh000300', '2021-06-01')]);
  verifyReport();

  const START = '2022-03-07';
  const END = '2026-10-09';
  const mCB = computeMetrics('中证转债(000832)', cb, START, END);
  const mHS = computeMetrics('沪深300(000300)', hs300, START, END);
  printTable([mCB, mHS]);

  // ---- C. 超额分解：策略 vs 转债指数（年度）----
  console.log('\n=== C. 策略年度收益 vs 转债指数（超额 = 报告口径 - 本脚本计算的指数口径） ===');
  const years = Object.keys(OFFICIAL.annual).map(Number).sort();
  let totalExcess = 0;
  for (const y of years) {
    const idx = (mCB.annual[y] ?? 0) * 100;
    const port = OFFICIAL.annual[y] * 100;
    const excess = port - idx;
    totalExcess += excess;
    console.log(
      `${y}  策略 ${port.toFixed(1).padStart(5)}%  转债指数 ${idx.toFixed(1).padStart(6)}%  超额 ${excess >= 0 ? '+' : ''}${excess.toFixed(1)}pp`,
    );
  }
  console.log(`5 期超额合计 ${totalExcess.toFixed(1)}pp、年均 ${((totalExcess / years.length)).toFixed(1)}pp（样本 5 个点，方向参考）`);
  console.log(`\n同期指数 CAGR：转债 ${(mCB.cagr * 100).toFixed(2)}%、沪深300 ${(mHS.cagr * 100).toFixed(2)}%；策略官方 CAGR ${(OFFICIAL.cagr * 100).toFixed(2)}%`);
  console.log(`策略年化超额（vs 转债指数）≈ ${(OFFICIAL.cagr * 100 - mCB.cagr * 100).toFixed(1)}pp/年`);

  // 结果存档
  fs.writeFileSync(
    path.join(DATA_DIR, 'backtest-cb-result.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), official: OFFICIAL, cb: mCB, hs300: mHS }, null, 2),
  );
  console.log('\n[done] data/backtest-cb-result.json');
}

main().catch((e) => {
  console.error('[failed]', e);
  process.exit(1);
});
