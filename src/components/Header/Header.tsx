import { RefreshCw, CircleCheck, CircleAlert, TriangleAlert } from 'lucide-react';
import type { Metadata } from '../../types/market';
import { useReducedMotion } from '../../hooks/useMediaQuery';
import { motion } from 'framer-motion';

interface HeaderProps {
  meta: Metadata | null;
  onRefresh: () => void;
  checking: boolean;
  justUpdated: boolean;
}

export default function Header({ meta, onRefresh, checking, justUpdated }: HeaderProps) {
  const reduced = useReducedMotion();

  return (
    <motion.header
      initial={reduced ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
      className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6 sm:flex-row sm:items-end sm:justify-between sm:px-6 md:pt-10"
    >
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl md:text-3xl">
          创业板 · 红利风格观察仪表盘
        </h1>
        <p className="mt-1.5 text-xs leading-relaxed text-inkSecondary sm:text-sm">
          基于历史指数相对强弱，观察成长与红利风格变化。
        </p>
      </div>

      <div className="flex flex-col items-start gap-1.5 sm:items-end">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-ink shadow-sm ring-1 ring-ink/8">
            {meta ? `数据截至 ${meta.latestTradeDate ?? '—'}（收盘）` : '数据加载中…'}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={checking}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-ink px-3.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-50"
            title="重新检查已部署的数据版本"
          >
            <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
            {checking ? '检查中' : '刷新数据'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-inkSecondary">
          <span>来源：{meta?.sourceName ?? '—'}</span>
          <span
            className={`inline-flex items-center gap-1 ${
              meta ? 'text-safe' : 'text-inkSecondary'
            }`}
          >
            {meta ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
            {meta ? '数据已加载' : '等待加载'}
          </span>
          {justUpdated && (
            <span className="inline-flex items-center gap-1 font-medium text-gold">
              <TriangleAlert size={12} />
              已更新到最新数据版本
            </span>
          )}
        </div>
      </div>
    </motion.header>
  );
}
