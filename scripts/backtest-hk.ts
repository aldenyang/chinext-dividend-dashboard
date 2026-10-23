/**
 * 港股专项分析：恒生/恒生科技与 A 股对应板块的相关性 + 恒生/恒生科技对子
 *
 * 数据：腾讯财经（hkHSI 恒生指数 / hkHSCEI 恒生中国企业 / hkHSTECH 恒生科技 /
 *       sh000300 沪深300 / sh000688 科创50），价格指数口径；
 *       中证红利全收益(H00922)与创业板指(399006)用项目内已有缓存。
 * 注意：港股与 A 股交易日历不同，相关性按两边共同交易日对齐。
 *       指数价格为不含股息口径（对相关性无影响；HSI/HSTECH 比值存在约 3pp/年股息漂移）。
 *
 * 恒生科技 2020-07-27 发布（无回填历史），滚动 5 年窗口不可用 →
 * 对子回测改用 2 年滚动窗口做探索性参考（488 交易日，样本警告见输出）。
 * 用途：个人研究，非投资建议
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest-hk-result.json');

const API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const COST = 0.0015;
const TRADING_DAYS = 244;
const RF = 0.015;

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

async function loadIndex(symbol: string, begin = '2014-01-01'): Promise<Quote[]> {
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
    // 下一段从 segLast 次日开始（避免跳段丢数据）
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

function align(a: Quote[], b: Quote[]): { dates: string[]; a: number[]; b: number[] } {
  const bMap = new Map(b.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const xa: number[] = [];
  const xb: number[] = [];
  for (const r of a) {
    const v = bMap.get(r.date);
    if (v === undefined) continue;
    dates.push(r.date);
    xa.push(r.close);
    xb.push(v);
  }
  return { dates, a: xa, b: xb };
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
  const [hsi, hscei, hstech, c300, kc50] = await Promise.all([
    loadIndex('hkHSI'),
    loadIndex('hkHSCEI'),
    loadIndex('hkHSTECH', '2020-01-01'),
    loadIndex('sh000300'),
    loadIndex('sh000688', '2019-06-01'),
  ]);
  const divTr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'h00922.json'), 'utf8')) as Quote[];

  console.log('\n=== 港股与 A 股对应板块相关性（共同交易日，日收益）===');
  const rows: Array<{ pair: string; full: number | null; y5: number | null; days: number; range: string }> = [];
  const pairs: Array<{ pair: string; a: Quote[]; b: Quote[] }> = [
    { pair: '恒生指数 vs 沪深300', a: hsi, b: c300 },
    { pair: '恒生指数 vs 中证红利全收益', a: hsi, b: divTr },
    { pair: '恒生国企 vs 中证红利全收益', a: hscei, b: divTr },
    { pair: '恒生科技 vs 创业板指', a: hstech, b: loadChinext() },
    { pair: '恒生科技 vs 科创50', a: hstech, b: kc50 },
    { pair: '恒生指数 vs 恒生科技（对子内部）', a: hsi, b: hstech },
  ];
  for (const p of pairs) {
    const { dates, a: xa, b: xb } = align(p.a, p.b);
    if (dates.length < 100) {
      rows.push({ pair: p.pair, full: null, y5: null, days: dates.length, range: '数据不足' });
      continue;
    }
    const ra = rets(xa);
    const rb = rets(xb);
    const n5 = Math.min(1212, ra.length);
    rows.push({
      pair: p.pair,
      full: corr(ra, rb),
      y5: ra.length > n5 ? corr(ra.slice(-n5), rb.slice(-n5)) : null,
      days: dates.length,
      range: `${dates[0]} ~ ${dates[dates.length - 1]}`,
    });
  }
  for (const r of rows) {
    console.log(
      `${r.pair.padEnd(28)} 全窗口 ${r.full === null ? '—' : r.full.toFixed(3)}｜近5年 ${r.y5 === null ? '—' : r.y5.toFixed(3)}｜${r.days} 日（${r.range}）`,
    );
  }

  // ---- 恒生/恒生科技对子：探索性回测（2 年滚动窗口，样本警告）----
  console.log('\n=== 探索性回测：恒生指数/恒生科技 比值滚动2年分位20/80 ===');
  console.log('[警告] 恒生科技 2020-07 才有数据，5 年滚动窗口不可用；2 年窗口 + 约4年评估期，统计意义有限');
  const WIN = 488;
  const { dates, a: xa, b: xb } = align(hsi, hstech);
  const aRet = [0, ...rets(xa)];
  const bRet = [0, ...rets(xb)];
  const ratio = dates.map((_, i) => xa[i] / xb[i]);

  const sig: (string | null)[] = [];
  for (let i = 0; i < ratio.length; i++) {
    if (i + 1 < WIN) {
      sig.push(null);
      continue;
    }
    let cnt = 0;
    for (let j = i - WIN + 1; j <= i; j++) if (ratio[j] <= ratio[i]) cnt++;
    const p = cnt / WIN;
    sig.push(p < 0.2 ? 'growth' : p > 0.8 ? 'dividend' : null); // growth=恒生, dividend=恒生科技
  }
  const pos: string[] = ['mix'];
  let desired = 'mix';
  for (let i = 1; i < dates.length; i++) {
    if (sig[i - 1] !== null) desired = sig[i - 1]!;
    pos.push(desired);
  }
  const startIdx = Math.min(WIN, dates.length - 2);

  const evaluate = (name: string, positions: string[]): Record<string, number | string> => {
    let value = 1;
    let peak = 1;
    let mdd = 0;
    let sw = 0;
    const rs: number[] = [];
    for (let i = startIdx; i < dates.length; i++) {
      if (i > startIdx && positions[i] !== positions[i - 1]) {
        value *= 1 - COST;
        sw++;
      }
      const r =
        positions[i] === 'growth' ? aRet[i] : positions[i] === 'dividend' ? bRet[i] : 0.5 * aRet[i] + 0.5 * bRet[i];
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
    return { name, cagr, vol, sharpe0: cagr / vol, sharpeRf: (cagr - RF) / vol, mdd, sw, mult: value };
  };

  const bench = (name: string, fn: (i: number) => number): Record<string, number | string> => {
    let value = 1;
    let peak = 1;
    let mdd = 0;
    const rs: number[] = [];
    for (let i = startIdx; i < dates.length; i++) {
      const r = fn(i);
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
    return { name, cagr, vol, sharpe0: cagr / vol, sharpeRf: (cagr - RF) / vol, mdd, sw: 0, mult: value };
  };

  const table = [
    evaluate('轮动：恒生/恒生科技 2年分位20/80', pos),
    bench('基准：50/50 每日再平衡（近似）', (i) => 0.5 * aRet[i] + 0.5 * bRet[i]),
    bench('基准：100% 恒生指数', (i) => aRet[i]),
    bench('基准：100% 恒生科技', (i) => bRet[i]),
  ];
  const w = [36, 9, 8, 9, 9, 9, 7, 9];
  console.log(`=== 评估窗口（${dates[startIdx]} ~ ${dates[dates.length - 1]}，${dates.length - startIdx} 个交易日）===`);
  console.log(['策略', 'CAGR', '波动', '夏普0', '夏普rf', '最大回撤', '换手', '期末倍数'].map((h, i) => h.padEnd(w[i])).join(''));
  for (const m of table) {
    console.log(
      [
        m.name,
        `${((m.cagr as number) * 100).toFixed(2)}%`,
        `${((m.vol as number) * 100).toFixed(2)}%`,
        (m.sharpe0 as number).toFixed(2),
        (m.sharpeRf as number).toFixed(2),
        `${((m.mdd as number) * 100).toFixed(2)}%`,
        m.sw,
        (m.mult as number).toFixed(3),
      ]
        .map((c, i) => String(c).padEnd(w[i]))
        .join(''),
    );
  }
  // 交易明细
  let openLeg: string | null = null;
  let openIdx = 0;
  const trades: string[] = [];
  for (let i = startIdx; i < dates.length; i++) {
    if (pos[i] === pos[i - 1]) continue;
    if (openLeg && pos[i] !== openLeg) {
      const ret = openLeg === 'growth' ? xa[i] / xa[openIdx] - 1 : xb[i] / xb[openIdx] - 1;
      trades.push(`${openLeg === 'growth' ? '恒生' : '恒生科技'} ${dates[openIdx]}→${dates[i]} ${(ret * 100).toFixed(1)}%`);
      openLeg = null;
    }
    if (pos[i] === 'growth' || pos[i] === 'dividend') {
      openLeg = pos[i];
      openIdx = i;
    }
  }
  if (openLeg) {
    const last = dates.length - 1;
    const ret = openLeg === 'growth' ? xa[last] / xa[openIdx] - 1 : xb[last] / xb[openIdx] - 1;
    trades.push(`${openLeg === 'growth' ? '恒生' : '恒生科技'} ${dates[openIdx]}→持仓中 ${(ret * 100).toFixed(1)}%`);
  }
  console.log(`[交易明细] ${trades.length} 笔`);
  for (const t of trades) console.log('  ' + t);

  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), correlations: rows, exploratory: { window: [dates[startIdx], dates[dates.length - 1]], metrics: table, trades } }, null, 2),
  );
  console.log(`\n[done] ${path.relative(ROOT, RESULT_PATH)}`);
}

function loadChinext(): Quote[] {
  const hist = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/historical.json'), 'utf8')) as Array<{
    date: string;
    chinextClose: number | null;
  }>;
  return hist
    .filter((r) => r.chinextClose !== null)
    .map((r) => ({ date: r.date, close: r.chinextClose as number }));
}

main().catch((e) => {
  console.error('[failed]', e);
  process.exit(1);
});
