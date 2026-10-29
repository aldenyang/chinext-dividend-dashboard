// 雪球组合 ZH3068836 每日同步: headless 浏览器 + 登录 Cookie(绕过 WAF 设备指纹校验)
// 输出: data/cb/xq_nav.json(全历史净值, 增量合并) / data/cb/xq_rebalancing.json(调仓, 增量合并)
//       public/cb_xq.json(dashboard 面板数据)
// Cookie 来源: 环境变量 XQ_COOKIE (CI) 或 .secrets/xq_cookie.txt (本地)
// 用法: node scripts/cb_xq_sync.mjs
import fs from 'fs';
import path from 'path';
// playwright-core 解析: CI 从项目 node_modules; 本地回退到 WorkBuddy 管理的工作区
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  const p = process.env.PW_MODULE
    || '/Users/bobyang/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
  ({ chromium } = await import(p));
}

const ROOT = path.join(new URL('..', import.meta.url).pathname);
const SYMBOL = 'ZH3068836';

function cookieString() {
  if (process.env.XQ_COOKIE && process.env.XQ_COOKIE.length > 100) return process.env.XQ_COOKIE;
  const p = path.join(ROOT, '.secrets', 'xq_cookie.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  throw new Error('未找到 Cookie: 设置环境变量 XQ_COOKIE 或创建 .secrets/xq_cookie.txt');
}

function parseCookies(str) {
  return str.split(/;\s*/).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return {
      name: pair.slice(0, i),
      value: pair.slice(i + 1),
      domain: '.xueqiu.com',
      path: '/',
    };
  });
}

async function main() {
  const ck = cookieString();
  // 浏览器可执行文件: 优先环境变量, 其次 playwright 默认缓存
  const exe = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath: exe,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addCookies(parseCookies(ck));
  const page = await ctx.newPage();
  await page.goto('https://xueqiu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // 直接导航到 API URL(真实浏览器请求, 绕过页面内嵌监控脚本对 window.fetch 的劫持);
  // WAF 挑战页会 301 到 JS 跳转, 等待其落地后 body 即为 JSON
  const fetchJson = async (url) => {
    for (let k = 0; k < 3; k++) {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const body = (await resp.text()).trim();
      if (body.startsWith('{') || body.startsWith('[')) {
        try { return JSON.parse(body); } catch { /* fallthrough */ }
      }
      await page.waitForTimeout(4000 * (k + 1));
    }
    throw new Error(`API 未返回 JSON: ${url}`);
  };

  // 1) 全历史净值(返回数组: 每元素一个组合)
  const navData = await fetchJson(`https://xueqiu.com/cubes/nav_daily/all.json?cube_symbol=${SYMBOL}`);
  const navArr = Array.isArray(navData) ? navData : (navData.list || []);
  const navItem = navArr.find((x) => x.symbol === SYMBOL) || navArr[0] || {};
  const navList = (navItem.list || []).map((x) => ({
    time: x.time, date: x.date, value: x.value, percent: x.percent,
  }));
  if (navList.length < 100) throw new Error(`净值数据异常: 仅 ${navList.length} 行`);

  // 2) 调仓历史(前2页覆盖最近记录)
  const rebalNew = [];
  for (const p of [1, 2]) {
    const rd = await fetchJson(`https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=${SYMBOL}&count=50&page=${p}`);
    rebalNew.push(...(rd.list || []));
    if (!rd.list || rd.list.length < 50) break;
  }

  // 3) 增量合并落盘
  const navFile = path.join(ROOT, 'data', 'cb', 'xq_nav.json');
  const oldNav = JSON.parse(fs.readFileSync(navFile, 'utf8'));
  const prevItem = (oldNav[0] || { list: [] });
  const byDate = new Map(prevItem.list.map((x) => [x.date, x]));
  for (const x of navList) byDate.set(x.date, x);
  const merged = [...byDate.values()].sort((a, b) => a.time - b.time);
  oldNav[0] = { ...navItem, list: merged };
  fs.writeFileSync(navFile, JSON.stringify(oldNav));

  const rebalFile = path.join(ROOT, 'data', 'cb', 'xq_rebalancing.json');
  const oldRebal = JSON.parse(fs.readFileSync(rebalFile, 'utf8'));
  const byId = new Map(oldRebal.map((r) => [r.id, r]));
  let newCnt = 0;
  for (const r of rebalNew) if (!byId.has(r.id)) { byId.set(r.id, r); newCnt++; }
  const mergedRebal = [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  fs.writeFileSync(rebalFile, JSON.stringify(mergedRebal));

  // 4) 面板数据
  // 当前持仓 = 从 2022 年起按时间顺序重放全部调仓的 target_weight(单条记录只含当次交易的债)
  const chrono = [...mergedRebal].sort((a, b) => a.created_at - b.created_at);
  const wmap = new Map();
  for (const r of chrono) {
    for (const h of r.rebalancing_histories || []) {
      wmap.set(h.stock_symbol, { symbol: h.stock_symbol, name: h.stock_name, weight: h.target_weight || 0 });
    }
  }
  const holdings = [...wmap.values()]
    .filter((h) => h.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const first = merged[0], last = merged[merged.length - 1];
  const ytdStart = [...merged].reverse().find((x) => x.date < `${last.date.slice(0, 4)}-01-01`);
  const ytdRet = ytdStart ? (last.value / ytdStart.value - 1) * 100 : null;
  const pub = {
    symbol: SYMBOL,
    name: navItem.name || '多因子轮动',
    updated: last.date,
    scraped_at: new Date().toISOString(),
    total_return: last.percent,
    ytd_return: ytdRet === null ? null : +ytdRet.toFixed(2),
    nav: merged.map((x) => ({ date: x.date, value: x.value })),
    holdings,
    rebalances: mergedRebal.slice(0, 10).map((r) => ({
      date: new Date(r.created_at + 8 * 3600 * 1000).toISOString().slice(0, 10),
      id: r.id,
      sells: (r.rebalancing_histories || []).filter((h) => (h.prev_weight || 0) > 0 && !(h.target_weight > 0)).map((h) => h.stock_name),
      buys: (r.rebalancing_histories || []).filter((h) => (h.target_weight || 0) > 0 && !(h.prev_weight > 0)).map((h) => h.stock_name),
      adjusts: (r.rebalancing_histories || []).filter((h) => (h.prev_weight || 0) > 0 && (h.target_weight || 0) > 0 && h.prev_weight !== h.target_weight)
        .map((h) => `${h.stock_name} ${(h.prev_weight).toFixed(0)}%→${(h.target_weight).toFixed(0)}%`),
    })),
    rebal_count: mergedRebal.length,
  };
  fs.writeFileSync(path.join(ROOT, 'public', 'cb_xq.json'), JSON.stringify(pub));

  console.log(`=== 雪球组合同步完成 ===`);
  console.log(`净值: ${merged.length} 行, 最新 ${last.date} = ${last.value} (${last.percent >= 0 ? '+' : ''}${last.percent}%)`);
  console.log(`调仓: 共 ${mergedRebal.length} 次, 本次新增 ${newCnt}, 最新 ${pub.rebalances[0]?.date || '-'}`);
  console.log(`当前持仓 ${holdings.length} 只: ${holdings.map((h) => h.name).join('/')}`);
  await browser.close();
}

main().catch((e) => { console.error('同步失败:', e.message); process.exit(1); });
