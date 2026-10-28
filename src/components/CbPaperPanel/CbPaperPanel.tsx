import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComposeOption } from 'echarts/core';
import type { LineSeriesOption } from 'echarts/charts';
import type { GridComponentOption, TooltipComponentOption, LegendComponentOption } from 'echarts/components';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent, CanvasRenderer]);

type EChartsOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption | LegendComponentOption>;

interface PaperData {
  updated: string;
  nav_now: number;
  cash: number;
  benchmarks?: Record<string, string>;
  nav: { date: string; nav: number; ret: number; bm_close: number | null; bm?: Record<string, number> }[];
  positions: { code: string; name: string; shares: number; cost: number; price: number | null; pnl_pct: number; entry_date: string }[];
  pending: { action: string; code: string; name: string; reason?: string; amount?: number; signal_date: string }[];
  trades: { date: string; action: string; code: string; name: string; fill_price?: number; shares?: number; amount?: number; reason?: string; pnl?: number }[];
}

const BM_COLORS: Record<string, string> = {
  sh000832: '#8a94a6',
  sz399006: '#e6772e',
  sh000905: '#3b82c4',
  sh000922: '#7a5ea8',
};

const fmt = (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

export default function CbPaperPanel() {
  const [data, setData] = useState<PaperData | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}cb_paper.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const option = useMemo<EChartsOption | null>(() => {
    if (!data || data.nav.length === 0) return null;
    const base = data.nav[0].nav;
    const dates = data.nav.map((x) => x.date);
    const rets = data.nav.map((x) => +((x.nav / base) * 100).toFixed(2));
    // 宽基基准: 各自归一化到首个有效收盘=100
    const bmNames = data.benchmarks ?? { sh000832: '中证转债' };
    const bmSeries: LineSeriesOption[] = [];
    for (const [code, label] of Object.entries(bmNames)) {
      const rows = data.nav.map((x) => x.bm?.[code] ?? (code === 'sh000832' ? x.bm_close ?? null : null));
      const firstIdx = rows.findIndex((v) => v != null);
      if (firstIdx < 0) continue;
      const b0 = rows[firstIdx] as number;
      const pts = rows.map((v, i) => (i < firstIdx || v == null ? null : +((v / b0) * 100).toFixed(2)));
      bmSeries.push({
        name: label, type: 'line', data: pts, showSymbol: false,
        lineStyle: { width: 1.3, type: code === 'sh000832' ? 'dashed' : 'solid' },
        color: BM_COLORS[code] ?? '#b0b8c4',
      });
    }
    return {
      grid: { left: 8, right: 8, top: 28, bottom: 0, containLabel: true },
      legend: { top: 0, left: 'center', textStyle: { fontSize: 11 } },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10, formatter: (v: number) => `${v}` } },
      series: [
        { name: '模拟盘', type: 'line', data: rets, showSymbol: false, lineStyle: { width: 2 }, color: '#b8860b' },
        ...bmSeries,
      ],
    };
  }, [data]);

  useEffect(() => {
    if (!option || !ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  if (failed) return null;

  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-card ring-1 ring-ink/5 sm:mt-6 sm:p-6" aria-label="可转债模拟盘">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ink sm:text-lg">可转债模拟盘</h2>
        {data && (
          <p className="text-xs text-inkSecondary">
            更新至 {data.updated} · 净值 {fmt(data.nav_now)} · 现金 {fmt(data.cash)}
          </p>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-inkSecondary/80">
        策略: 小规模(≤5亿)+中价(110-145)+转股期画像, 5日溢价扩张&gt;3pp介入, 脉冲后峰值回撤5%止盈 / 30日无脉冲退出。
        T+1收盘成交, 单边成本0.15%, 等权10只, 起始100万。模拟盘不构成投资建议。
      </p>

      {!data ? (
        <p className="mt-4 text-xs text-inkSecondary">{failed ? '模拟盘数据暂不可用' : '加载中…'}</p>
      ) : (
        <>
          <div ref={ref} className="mt-3 h-56 w-full sm:h-64" />

          <h3 className="mt-5 text-sm font-semibold text-ink">当前持仓（{data.positions.length}）</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-ink/10 text-inkSecondary">
                  <th className="py-1.5 pr-3 font-medium">代码</th>
                  <th className="py-1.5 pr-3 font-medium">名称</th>
                  <th className="py-1.5 pr-3 text-right font-medium">张数</th>
                  <th className="py-1.5 pr-3 text-right font-medium">成本</th>
                  <th className="py-1.5 pr-3 text-right font-medium">现价</th>
                  <th className="py-1.5 pr-3 text-right font-medium">盈亏</th>
                  <th className="py-1.5 text-right font-medium">建仓日</th>
                </tr>
              </thead>
              <tbody>
                {data.positions.length === 0 && (
                  <tr><td colSpan={7} className="py-3 text-center text-inkSecondary">暂无持仓</td></tr>
                )}
                {data.positions.map((p) => (
                  <tr key={p.code} className="border-b border-ink/5 last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{p.code}</td>
                    <td className="py-1.5 pr-3">{p.name}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{p.shares}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{p.cost.toFixed(2)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{p.price?.toFixed(2) ?? '-'}</td>
                    <td className={`py-1.5 pr-3 text-right font-mono ${p.pnl_pct >= 0 ? 'text-danger' : 'text-teal-600'}`}>
                      {p.pnl_pct >= 0 ? '+' : ''}{p.pnl_pct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right font-mono">{p.entry_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pending.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold text-ink">待成交（T+1）</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink/10 text-inkSecondary">
                      <th className="py-1.5 pr-3 font-medium">动作</th>
                      <th className="py-1.5 pr-3 font-medium">代码</th>
                      <th className="py-1.5 pr-3 font-medium">名称</th>
                      <th className="py-1.5 pr-3 font-medium">理由</th>
                      <th className="py-1.5 text-right font-medium">信号日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pending.map((o, i) => (
                      <tr key={`${o.code}-${o.action}-${i}`} className="border-b border-ink/5 last:border-0">
                        <td className="py-1.5 pr-3">{o.action === 'buy' ? '买入' : '卖出'}</td>
                        <td className="py-1.5 pr-3 font-mono">{o.code}</td>
                        <td className="py-1.5 pr-3">{o.name}</td>
                        <td className="py-1.5 pr-3 text-inkSecondary">{o.reason ?? o.amount ?? '-'}</td>
                        <td className="py-1.5 text-right font-mono">{o.signal_date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data.trades.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold text-ink">最近成交</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink/10 text-inkSecondary">
                      <th className="py-1.5 pr-3 font-medium">日期</th>
                      <th className="py-1.5 pr-3 font-medium">动作</th>
                      <th className="py-1.5 pr-3 font-medium">名称</th>
                      <th className="py-1.5 pr-3 text-right font-medium">价格</th>
                      <th className="py-1.5 pr-3 text-right font-medium">张数</th>
                      <th className="py-1.5 text-right font-medium">盈亏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.trades].reverse().slice(0, 20).map((t, i) => (
                      <tr key={`${t.code}-${t.date}-${i}`} className="border-b border-ink/5 last:border-0">
                        <td className="py-1.5 pr-3 font-mono">{t.date}</td>
                        <td className="py-1.5 pr-3">{t.action === 'buy' ? '买入' : '卖出'}</td>
                        <td className="py-1.5 pr-3">{t.name}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{t.fill_price?.toFixed(2) ?? '-'}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{t.shares ?? '-'}</td>
                        <td className={`py-1.5 text-right font-mono ${t.pnl == null ? '' : t.pnl >= 0 ? 'text-danger' : 'text-teal-600'}`}>
                          {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
