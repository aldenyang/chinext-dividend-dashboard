import { useState } from 'react';
import { motion } from 'framer-motion';
import { CircleAlert, RefreshCw, Info } from 'lucide-react';
import { useMarketData } from './hooks/useMarketData';
import { useMediaQuery, useReducedMotion } from './hooks/useMediaQuery';
import Header from './components/Header/Header';
import MetricCards from './components/MetricCards/MetricCards';
import TimeRangeSelector from './components/TimeRangeSelector/TimeRangeSelector';
import ExplanationModal from './components/ExplanationModal/ExplanationModal';
import MainChart, { type RangeKey, type Granularity } from './components/charts/MainChart';

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl animate-pulse px-4 pt-6 sm:px-6 md:pt-10" aria-busy="true" aria-label="数据加载中">
      <div className="h-8 w-72 rounded-lg bg-ink/8" />
      <div className="mt-3 h-4 w-96 max-w-full rounded bg-ink/5" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 rounded-2xl bg-white shadow-card ring-1 ring-ink/5" />
        ))}
      </div>
      <div className="mt-4 h-[420px] rounded-2xl bg-white shadow-card ring-1 ring-ink/5" />
    </div>
  );
}

export default function App() {
  const { meta, records, status, error, refresh, checking, justUpdated } = useMarketData();
  const [range, setRange] = useState<RangeKey>('all');
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [modalOpen, setModalOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 639px)');
  const reduced = useReducedMotion();

  return (
    <div className="min-h-dvh bg-page pb-16 text-ink antialiased">
      <Header meta={meta} onRefresh={() => void refresh()} checking={checking} justUpdated={justUpdated} />

      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {status === 'loading' && <Skeleton />}

        {status === 'error' && !records.length && (
          <div className="mt-10 flex flex-col items-center gap-3 rounded-2xl bg-white p-10 text-center shadow-card ring-1 ring-ink/5">
            <CircleAlert size={36} className="text-danger" />
            <p className="text-sm font-medium text-ink">数据加载失败</p>
            <p className="max-w-sm text-xs leading-relaxed text-inkSecondary">{error ?? '未知错误'}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-white hover:opacity-85"
            >
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        )}

        {status === 'ready' && records.length > 0 && (
          <>
            <div className="mt-5 sm:mt-7">
              <MetricCards records={records} meta={meta} />
            </div>

            <motion.section
              initial={reduced ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
              className="mt-4 rounded-2xl bg-white p-2 shadow-card ring-1 ring-ink/5 sm:mt-6 sm:p-4"
              aria-label="核心走势图"
            >
              <div className="px-2 pt-2 sm:px-3">
                <TimeRangeSelector
                  range={range}
                  granularity={granularity}
                  onRangeChange={setRange}
                  onGranularityChange={setGranularity}
                />
                <p className="mt-1.5 px-0.5 text-[11px] text-inkSecondary/80 sm:hidden">
                  点击图表查看日期数据 · 单指拖动 / 双指缩放
                </p>
              </div>
              <MainChart
                records={records}
                range={range}
                granularity={granularity}
                reducedMotion={reduced}
                isMobile={isMobile}
              />
            </motion.section>

            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-ink shadow-sm ring-1 ring-ink/10 transition-shadow hover:shadow-card"
              >
                <Info size={16} className="text-gold" />
                指标说明与风险提示
              </button>
            </div>

            <p className="mx-auto mt-6 max-w-2xl px-2 text-center text-[11px] leading-relaxed text-inkSecondary/80">
              本工具为个人市场风格研究工具，不提供买卖或仓位调整建议。数据为指数收盘行情（价格指数），
              历史比值极值不等于未来投资买卖点。
            </p>
          </>
        )}
      </main>

      <ExplanationModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
