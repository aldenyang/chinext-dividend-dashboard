import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';

interface XqData {
  symbol: string;
  name: string;
  updated: string;
  scraped_at: string;
  total_return: number;
  ytd_return: number | null;
  nav: { date: string; value: number }[];
  holdings: { symbol: string; name: string; weight: number }[];
  rebalances: { date: string; id: number; sells: string[]; buys: string[]; adjusts: string[] }[];
  rebal_count: number;
}

const card = 'rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4';

export default function XqTrackPanel() {
  const [data, setData] = useState<XqData | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 时间戳击穿缓存
    fetch(`${import.meta.env.BASE_URL}cb_xq.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (!data || !ref.current) return;
    const chart = echarts.init(ref.current);
    const values = data.nav.map((x) => +(x.value * 100).toFixed(1));
    const option = {
      grid: { left: 8, right: 8, top: 30, bottom: 0, containLabel: true },
      tooltip: {
        trigger: 'axis',
        formatter: (ps: any) => {
          const p = ps[0];
          return `${p.axisValue}<br/>净值 <b>${(p.value / 100).toFixed(4)}</b>`;
        },
      },
      xAxis: { type: 'category', data: data.nav.map((x) => x.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10, formatter: (v: number) => `${(v / 100).toFixed(1)}` } },
      series: [
        {
          name: '组合净值',
          type: 'line',
          data: values,
          showSymbol: false,
          lineStyle: { width: 2 },
          color: '#8b5cf6',
          areaStyle: { color: 'rgba(139, 92, 246, 0.08)' },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: 100 }],
            lineStyle: { type: 'dashed', color: '#8a94a6', width: 1 },
            label: { formatter: '1.00', fontSize: 9 },
          },
        },
      ],
    };
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); };
  }, [data]);

  const recent = useMemo(() => (data ? data.rebalances.slice(0, 6) : []), [data]);

  if (failed) {
    return (
      <section className="mt-6">
        <h2 className="text-base font-semibold mb-2">雪球组合追踪 · 多因子轮动</h2>
        <div className={`${card} text-sm text-slate-400`}>雪球数据暂不可用（多为 Cookie 过期），将自动恢复。</div>
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <h2 className="text-base font-semibold">
          雪球组合追踪 · {data.name}
          <span className="ml-2 text-xs text-slate-400">{data.symbol}</span>
        </h2>
        <span className="text-xs text-slate-400">数据日 {data.updated} · 净值/调仓每日收盘后自动同步</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className={card}><div className="text-xs text-slate-400">累计收益</div><div className={`text-lg font-semibold ${data.total_return >= 0 ? 'text-red-400' : 'text-green-400'}`}>{data.total_return >= 0 ? '+' : ''}{data.total_return}%</div></div>
        <div className={card}><div className="text-xs text-slate-400">今年(YTD)</div><div className={`text-lg font-semibold ${data.ytd_return !== null && data.ytd_return >= 0 ? 'text-red-400' : 'text-green-400'}`}>{data.ytd_return === null ? '-' : `${data.ytd_return >= 0 ? '+' : ''}${data.ytd_return}%`}</div></div>
        <div className={card}><div className="text-xs text-slate-400">最新净值</div><div className="text-lg font-semibold">{data.nav.length ? data.nav[data.nav.length - 1].value.toFixed(4) : '-'}</div></div>
        <div className={card}><div className="text-xs text-slate-400">调仓次数</div><div className="text-lg font-semibold">{data.rebal_count}</div></div>
      </div>

      <div className={card + ' mb-3'}>
        <div ref={ref} className="h-56" />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className={card}>
          <div className="text-sm font-medium mb-2">当前持仓（{data.holdings.length} 只）</div>
          <div className="flex flex-wrap gap-1.5">
            {data.holdings.map((h) => (
              <span key={h.symbol} className="text-xs px-2 py-1 rounded-lg border border-white/10 bg-white/5">
                {h.name} <span className="text-slate-400">{h.weight.toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
        <div className={card}>
          <div className="text-sm font-medium mb-2">最近调仓</div>
          <div className="space-y-1.5">
            {recent.map((r) => (
              <div key={r.id} className="text-xs leading-relaxed">
                <span className="text-slate-400 mr-2">{r.date}</span>
                {r.sells.map((s) => <span key={`s${s}`} className="mr-1 text-green-400">卖 {s}</span>)}
                {r.buys.map((b) => <span key={`b${b}`} className="mr-1 text-red-400">买 {b}</span>)}
                {r.adjusts.map((a) => <span key={a} className="mr-1 text-slate-300">调 {a}</span>)}
                {!r.sells.length && !r.buys.length && !r.adjusts.length && <span className="text-slate-500">无变动</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">该组合为我们模拟盘所复刻的原策略（雪球公开模拟盘，收盘价成交）；追踪数据每日自动抓取自雪球。</p>
    </section>
  );
}
