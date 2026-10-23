import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyRecord } from '../../types/market';
// 按需引入 ECharts，控制打包体积
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  LegendComponent,
  MarkLineComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComposeOption } from 'echarts/core';
import type { LineSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import type {
  GridComponentOption,
  TooltipComponentOption,
  DataZoomComponentOption,
  LegendComponentOption,
  MarkLineComponentOption,
  AxisPointerComponentOption,
} from 'echarts/components';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  LegendComponent,
  MarkLineComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

type EChartsOption = ComposeOption<
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
  | LegendComponentOption
  | MarkLineComponentOption
  | AxisPointerComponentOption
>;
import {
  LOW_REF,
  HIGH_REF,
  STATUS_TEXT,
  getRatioStatus,
  findExtremes,
  type Extreme,
} from '../../utils/calculations/ratio';
import { fmtPrice, fmtRatio } from '../../utils/formatting/format';

export type RangeKey = '1y' | '3y' | '5y' | 'all';
export type Granularity = 'year' | 'month' | 'day';

const C_CHINEXT = '#426997';
const C_RATIO = '#C5A46D';
const C_LOW = '#20A97B';
const C_HIGH = '#E65B64';

const RANGE_YEARS: Record<Exclude<RangeKey, 'all'>, number> = { '1y': 1, '3y': 3, '5y': 5 };

function toDateTs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtAxis(granularity: Granularity): { hideOverlap: boolean; formatter: Record<string, string> } {
  const hideOverlap = true;
  if (granularity === 'year') {
    return { hideOverlap, formatter: { year: '{yyyy}', month: '{yyyy}', day: '{yyyy}' } };
  }
  if (granularity === 'month') {
    return { hideOverlap, formatter: { year: '{yyyy}', month: '{yyyy}-{MM}', day: '{yyyy}-{MM}' } };
  }
  return { hideOverlap, formatter: { year: '{yyyy}', month: '{yyyy}-{MM}', day: '{MM}-{dd}' } };
}

function ratioYAxisExtent(): { min: (e: { min: number; max: number }) => number; max: (e: { min: number; max: number }) => number } {
  const pad = (e: { min: number; max: number }) => Math.max((e.max - e.min) * 0.1, 0.05);
  return {
    min: (e) => Math.min(e.min - pad(e), LOW_REF - 0.03),
    max: (e) => Math.max(e.max + pad(e), HIGH_REF + 0.03),
  };
}

interface MainChartProps {
  records: DailyRecord[];
  range: RangeKey;
  granularity: Granularity;
  reducedMotion: boolean;
  isMobile: boolean;
}

export default function MainChart({ records, range, granularity, reducedMotion, isMobile }: MainChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<echarts.ECharts[]>([]);
  const [showChinext, setShowChinext] = useState(true);
  const [showRatio, setShowRatio] = useState(true);
  const [selectedExtreme, setSelectedExtreme] = useState<Extreme | null>(null);

  const extremes = useMemo(() => findExtremes(records), [records]);
  const recordByTs = useMemo(() => {
    const m = new Map<number, DailyRecord>();
    for (const r of records) m.set(toDateTs(r.date), r);
    return m;
  }, [records]);

  const chinextData = useMemo(
    () => records.filter((r) => r.chinextClose !== null).map((r) => [toDateTs(r.date), r.chinextClose]),
    [records],
  );
  const ratioData = useMemo(
    () => records.filter((r) => r.ratio !== null).map((r) => [toDateTs(r.date), r.ratio]),
    [records],
  );

  const rangeStartTs = useMemo(() => {
    if (range === 'all') return undefined;
    const years = RANGE_YEARS[range];
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    // 对齐到不早于 cutoff 的第一个交易日
    const cutoffTs = cutoff.getTime();
    const first = records.find((r) => toDateTs(r.date) >= cutoffTs);
    return first ? toDateTs(first.date) : undefined;
  }, [range, records]);

  /* ---------- tooltip 共用 formatter ---------- */
  const tooltipFormatter = useMemo(() => {
    return (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as Array<{ axisValue: number | string }>;
      if (!list.length) return '';
      const ts = typeof list[0].axisValue === 'number' ? list[0].axisValue : toDateTs(String(list[0].axisValue));
      const r = recordByTs.get(ts);
      if (!r) return '';
      const status = r.ratio !== null ? STATUS_TEXT[getRatioStatus(r.ratio)] : '—';
      const rows = [
        `<div style="font-weight:600;color:#202C40;margin-bottom:4px">${r.date}</div>`,
      ];
      if (r.chinextClose !== null) {
        rows.push(`<div>创业板指数：<b>${fmtPrice(r.chinextClose)}</b></div>`);
      }
      if (r.dividendClose !== null) {
        rows.push(`<div>中证红利指数：<b>${fmtPrice(r.dividendClose)}</b></div>`);
      }
      rows.push(`<div>创业板/中证红利：<b style="color:${C_RATIO}">${fmtRatio(r.ratio)}</b></div>`);
      rows.push(`<div style="color:#8792A5">相对状态：${status}</div>`);
      return rows.join('');
    };
  }, [recordByTs]);

  const tooltipPos = (
    point: [number, number],
    _params: unknown,
    _dom: unknown,
    _rect: unknown,
    size: { viewSize: [number, number]; contentSize: [number, number] },
  ) => {
    const [viewW, viewH] = size.viewSize;
    const [boxW, boxH] = size.contentSize;
    let x = point[0] + 14;
    if (x + boxW > viewW - 8) x = point[0] - boxW - 14;
    if (x < 8) x = 8;
    const y = Math.max(8, Math.min(point[1] - boxH / 2, viewH - boxH - 8));
    return [x, y];
  };

  /* ---------- 构建 option ---------- */
  const buildDesktopOption = (): EChartsOption => ({
    animation: !reducedMotion,
    animationDuration: 900,
    animationDurationUpdate: 400,
    // 图例不可见，仅用 selected 状态控制曲线显隐；参考线在独立系列不受影响
    legend: {
      show: false,
      data: ['创业板指数', '相对比值'],
      selected: { 创业板指数: showChinext, 相对比值: showRatio },
    },
    grid: { left: 64, right: 64, top: 36, bottom: 78 },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#202C40' } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: '#C5A46D' } },
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: 'rgba(32,44,64,0.12)',
      textStyle: { color: '#202C40', fontSize: 13 },
      extraCssText: 'box-shadow:0 8px 24px rgba(32,44,64,0.15);border-radius:10px;padding:10px 14px;backdrop-filter:blur(8px);',
      formatter: tooltipFormatter,
      position: tooltipPos,
    },
    xAxis: {
      type: 'time',
      boundaryGap: ['0%', '0%'],
      min: toDateTs(records[0].date),
      max: toDateTs(records[records.length - 1].date),
      axisLine: { lineStyle: { color: '#D8DEE9' } },
      axisTick: { show: false },
      axisLabel: { color: '#8792A5', ...fmtAxis(granularity) },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '创业板指数',
        nameTextStyle: { color: '#426997', padding: [0, 0, 6, -10] },
        scale: true,
        axisLabel: { color: '#8792A5', formatter: (v: number) => v.toLocaleString('zh-CN') },
        splitLine: { lineStyle: { color: 'rgba(32,44,64,0.07)' } },
      },
      {
        type: 'value',
        name: '相对比值',
        nameTextStyle: { color: C_RATIO, padding: [0, -10, 6, 0] },
        min: ratioYAxisExtent().min,
        max: ratioYAxisExtent().max,
        axisLabel: { color: '#8792A5', formatter: (v: number) => v.toFixed(2) },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0],
        filterMode: 'weakFilter',
        // 滚轮不劫持：让页面正常滚动；缩放走底部滑块 / 拖动，双击还原
        zoomOnMouseWheel: false,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
      {
        type: 'slider',
        xAxisIndex: [0],
        filterMode: 'weakFilter',
        height: 22,
        bottom: 16,
        borderColor: 'rgba(32,44,64,0.1)',
        fillerColor: 'rgba(197,164,109,0.18)',
        handleStyle: { color: '#C5A46D' },
        dataBackground: { lineStyle: { color: 'rgba(197,164,109,0.5)' }, areaStyle: { color: 'rgba(197,164,109,0.12)' } },
        textStyle: { color: '#8792A5', fontSize: 11 },
        labelFormatter: (v: number) => {
          const d = new Date(v);
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        },
      },
    ],
    series: [
      {
        name: '创业板指数',
        type: 'line',
        yAxisIndex: 0,
        data: chinextData as never,
        symbol: 'none',
        lineStyle: { color: C_CHINEXT, width: 1.6 },
        itemStyle: { color: C_CHINEXT },
        emphasis: { disabled: true },
        connectNulls: false,
        z: 4,
      },
      {
        name: '相对比值',
        type: 'line',
        yAxisIndex: 1,
        data: ratioData as never,
        symbol: 'none',
        lineStyle: { color: C_RATIO, width: 2.4 },
        itemStyle: { color: C_RATIO },
        emphasis: { disabled: true },
        connectNulls: false,
        z: 6,
      },
      {
        // 参考线宿主：独立空系列，图例开关不影响参考线
        name: '__reflines',
        type: 'line',
        yAxisIndex: 1,
        data: [],
        silent: false,
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          lineStyle: { type: 'dashed', width: 1.4 },
          label: { fontSize: 11, distance: 6 },
          data: [
            {
              yAxis: LOW_REF,
              name: '低位参考',
              lineStyle: { color: C_LOW },
              label: { color: C_LOW, formatter: `低位参考 ${LOW_REF.toFixed(3)}`, position: 'insideEndTop' },
            },
            {
              yAxis: HIGH_REF,
              name: '高位参考',
              lineStyle: { color: C_HIGH },
              label: { color: C_HIGH, formatter: `高位参考 ${HIGH_REF.toFixed(3)}`, position: 'insideEndTop' },
            },
          ],
        },
      },
      {
        name: '__extremes',
        type: 'scatter',
        yAxisIndex: 1,
        data: [
          ...(extremes.low ? [[toDateTs(extremes.low.date), extremes.low.ratio]] : []),
          ...(extremes.high ? [[toDateTs(extremes.high.date), extremes.high.ratio]] : []),
        ] as never,
        symbolSize: 10,
        z: 10,
        itemStyle: {
          color: (p: { dataIndex: number }) => (p.dataIndex === 0 ? C_LOW : C_HIGH),
          borderColor: '#FFFFFF',
          borderWidth: 2,
          shadowBlur: 6,
          shadowColor: 'rgba(32,44,64,0.25)',
        },
        emphasis: { scale: 1.4 },
        cursor: 'pointer',
      },
    ],
  });

  const buildMobileRatioOption = (): EChartsOption => ({
    animation: !reducedMotion,
    animationDuration: 900,
    legend: { show: false, data: ['相对比值'], selected: { 相对比值: showRatio } },
    grid: { left: 52, right: 52, top: 18, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: 'rgba(32,44,64,0.12)',
      textStyle: { color: '#202C40', fontSize: 12 },
      formatter: tooltipFormatter,
      position: tooltipPos,
    },
    xAxis: { type: 'time', boundaryGap: ['0%', '0%'], axisLabel: { color: '#8792A5', ...fmtAxis(granularity) }, axisLine: { lineStyle: { color: '#D8DEE9' } } },
    yAxis: [{ type: 'value', scale: true, min: ratioYAxisExtent().min, max: ratioYAxisExtent().max, axisLabel: { color: '#8792A5', formatter: (v: number) => v.toFixed(2) }, splitLine: { lineStyle: { color: 'rgba(32,44,64,0.07)' } } }],
    dataZoom: [{ type: 'inside', filterMode: 'weakFilter', zoomOnMouseWheel: false }],
    series: [
      {
        name: '相对比值',
        type: 'line',
        data: ratioData as never,
        symbol: 'none',
        lineStyle: { color: C_RATIO, width: 2.2 },
        connectNulls: false,
        z: 6,
      },
      {
        name: '__reflines_m',
        type: 'line',
        data: [],
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          lineStyle: { type: 'dashed', width: 1.2 },
          label: { fontSize: 10 },
          data: [
            { yAxis: LOW_REF, lineStyle: { color: C_LOW }, label: { color: C_LOW, formatter: `${LOW_REF.toFixed(2)}`, position: 'insideEndTop' } },
            { yAxis: HIGH_REF, lineStyle: { color: C_HIGH }, label: { color: C_HIGH, formatter: `${HIGH_REF.toFixed(2)}`, position: 'insideEndTop' } },
          ],
        },
      },
      {
        name: '__extremes_m',
        type: 'scatter',
        data: [
          ...(extremes.low ? [[toDateTs(extremes.low.date), extremes.low.ratio]] : []),
          ...(extremes.high ? [[toDateTs(extremes.high.date), extremes.high.ratio]] : []),
        ] as never,
        symbolSize: 9,
        itemStyle: { color: (p: { dataIndex: number }) => (p.dataIndex === 0 ? C_LOW : C_HIGH), borderColor: '#fff', borderWidth: 2 },
        cursor: 'pointer',
      },
    ],
  });

  const buildMobileIndexOption = (): EChartsOption => ({
    animation: !reducedMotion,
    legend: { show: false, data: ['创业板指数'], selected: { 创业板指数: showChinext } },
    grid: { left: 52, right: 52, top: 18, bottom: 62 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: 'rgba(32,44,64,0.12)',
      textStyle: { color: '#202C40', fontSize: 12 },
      formatter: tooltipFormatter,
      position: tooltipPos,
    },
    xAxis: {
      type: 'time',
      boundaryGap: ['0%', '0%'],
      axisLabel: { color: '#8792A5', ...fmtAxis(granularity) },
      axisLine: { lineStyle: { color: '#D8DEE9' } },
    },
    yAxis: [{ type: 'value', scale: true, axisLabel: { color: '#8792A5', formatter: (v: number) => v.toLocaleString('zh-CN') }, splitLine: { lineStyle: { color: 'rgba(32,44,64,0.07)' } } }],
    dataZoom: [
      { type: 'inside', filterMode: 'weakFilter', zoomOnMouseWheel: false },
      { type: 'slider', height: 20, bottom: 14, borderColor: 'rgba(32,44,64,0.1)', fillerColor: 'rgba(197,164,109,0.18)', handleStyle: { color: '#C5A46D' }, textStyle: { fontSize: 10, color: '#8792A5' } },
    ],
    series: [
      {
        name: '创业板指数',
        type: 'line',
        data: chinextData as never,
        symbol: 'none',
        lineStyle: { color: C_CHINEXT, width: 1.6 },
        connectNulls: false,
      },
    ],
  });

  /* ---------- 初始化 / 更新 ---------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || records.length === 0) return;

    if (isMobile) {
      // 手机端：上下两张同步走势图
      if (chartsRef.current.length !== 2 || container.childElementCount !== 2) {
        chartsRef.current.forEach((c) => c.dispose());
        container.innerHTML = '';
        const top = document.createElement('div');
        const bottom = document.createElement('div');
        top.style.height = '42%';
        bottom.style.height = '58%';
        container.append(top, bottom);
        const c1 = echarts.init(top);
        const c2 = echarts.init(bottom);
        c1.group = 'mobile-sync';
        c2.group = 'mobile-sync';
        echarts.connect('mobile-sync');
        chartsRef.current = [c1, c2];
        c1.on('click', (p) => handleChartClick(p));
        c2.on('click', (p) => handleChartClick(p));
      }
      const [c1, c2] = chartsRef.current;
      c1.setOption(buildMobileRatioOption(), { notMerge: false });
      c2.setOption(buildMobileIndexOption(), { notMerge: false });
      // 范围切换：同步 dataZoom
      const dz = rangeStartTs !== undefined ? { startValue: rangeStartTs, endValue: toDateTs(records[records.length - 1].date) } : { start: 0, end: 100 };
      c1.dispatchAction({ type: 'dataZoom', ...dz });
      c2.dispatchAction({ type: 'dataZoom', ...dz });
    } else {
      if (chartsRef.current.length !== 1 || container.childElementCount !== 1) {
        chartsRef.current.forEach((c) => c.dispose());
        container.innerHTML = '';
        const el = document.createElement('div');
        el.style.height = '100%';
        container.append(el);
        const chart = echarts.init(el);
        chart.on('click', (p) => handleChartClick(p));
        chartsRef.current = [chart];
      }
      const chart = chartsRef.current[0];
      chart.setOption(buildDesktopOption(), { notMerge: false });
      const dz = rangeStartTs !== undefined ? { startValue: rangeStartTs, endValue: toDateTs(records[records.length - 1].date) } : { start: 0, end: 100 };
      chart.dispatchAction({ type: 'dataZoom', ...dz });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, range, granularity, showChinext, showRatio, reducedMotion, isMobile, extremes, tooltipFormatter, rangeStartTs]);

  /* ---------- 滚轮透传：图表区域不劫持滚轮，页面可直接滚动 ---------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 捕获阶段拦截 wheel 并阻止其继续传播，使 zrender 的 wheel 监听
    // （会 preventDefault 导致页面无法滚动）收不到事件；
    // 不调用 preventDefault，浏览器默认的页面滚动行为保持不变。
    const onWheel = (e: WheelEvent) => e.stopPropagation();
    container.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => container.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  /* ---------- resize ---------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      chartsRef.current.forEach((c) => c.resize());
    });
    ro.observe(container);
    const onOrient = () => window.setTimeout(() => chartsRef.current.forEach((c) => c.resize()), 300);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', onOrient);
    };
  }, []);

  useEffect(() => () => chartsRef.current.forEach((c) => c.dispose()), []);

  /* ---------- 极值点击 ---------- */
  function handleChartClick(p: { componentType?: string; seriesName?: string }) {
    if (p.componentType !== 'series' || (p.seriesName !== '__extremes' && p.seriesName !== '__extremes_m')) return;
    // click 事件携带 dataIndex：0=low, 1=high
    const idx = (p as unknown as { dataIndex: number }).dataIndex;
    setSelectedExtreme(idx === 0 ? extremes.low : extremes.high);
  }

  return (
    <div className="relative">
      {/* 图例开关 + 重置 */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
        <button
          type="button"
          onClick={() => setShowRatio((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            showRatio ? 'border-gold/50 bg-gold/10 text-ink' : 'border-inkSecondary/30 bg-transparent text-inkSecondary'
          }`}
        >
          <span className="h-2 w-4 rounded-full" style={{ background: showRatio ? C_RATIO : '#C4CBD6' }} />
          相对比值
        </button>
        <button
          type="button"
          onClick={() => setShowChinext((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            showChinext ? 'border-chinext/50 bg-chinext/10 text-ink' : 'border-inkSecondary/30 bg-transparent text-inkSecondary'
          }`}
        >
          <span className="h-2 w-4 rounded-full" style={{ background: showChinext ? C_CHINEXT : '#C4CBD6' }} />
          创业板指数
        </button>
        <span className="ml-auto hidden text-xs text-inkSecondary sm:inline">
          拖动查看 · 滑块缩放 · 双击空白还原
        </span>
      </div>

      {/* 主图容器 */}
      <div
        ref={containerRef}
        className="mt-1 w-full"
        style={{ height: isMobile ? 380 : 540 }}
        onDoubleClick={() => {
          const chart = chartsRef.current[0];
          chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        }}
      />

      {/* 极值信息卡 */}
      {selectedExtreme && (
        <div className="absolute right-4 top-16 z-10 w-60 rounded-xl border border-ink/8 bg-white/95 p-3.5 shadow-card backdrop-blur-sm sm:right-6 sm:top-20">
          <div className="flex items-center justify-between">
            <span
              className="text-xs font-semibold"
              style={{ color: selectedExtreme.ratio === extremes.low?.ratio ? C_LOW : C_HIGH }}
            >
              {selectedExtreme.ratio === extremes.low?.ratio ? '全历史最低比值' : '全历史最高比值'}
            </span>
            <button
              type="button"
              aria-label="关闭极值信息"
              onClick={() => setSelectedExtreme(null)}
              className="text-inkSecondary hover:text-ink"
            >
              ✕
            </button>
          </div>
          <div className="mt-2 space-y-1 text-xs text-ink">
            <div className="font-medium">{selectedExtreme.date}</div>
            <div>创业板指数：{fmtPrice(selectedExtreme.record.chinextClose)}</div>
            <div>中证红利指数：{fmtPrice(selectedExtreme.record.dividendClose)}</div>
            <div>
              当日比值：<b style={{ color: C_RATIO }}>{fmtRatio(selectedExtreme.ratio)}</b>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-inkSecondary">历史极值不代表确定的买卖点。</p>
        </div>
      )}
    </div>
  );
}
