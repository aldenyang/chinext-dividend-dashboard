import { motion } from 'framer-motion';
import { Target } from 'lucide-react';
import { useMemo } from 'react';
import { computeStrategyStatus } from '../../config/strategy';
import type { DailyRecord } from '../../types/market';

const LEG_STYLE = {
  growth: { label: '持有创业板', cls: 'bg-chinext/10 text-chinext' },
  dividend: { label: '持有红利', cls: 'bg-gold/15 text-gold' },
  none: { label: '未建立', cls: 'bg-ink/8 text-inkSecondary' },
} as const;

/**
 * 策略信号参考面板：展示 S4（固定阈值）与 S6（滚动分位）的当前规则持仓。
 * 参数来自 src/config/strategy.ts（与回测脚本同一配置源）。
 * 仅回测研究口径的规则状态展示，不构成投资建议。
 */
export default function StrategyPanel({ records }: { records: DailyRecord[] }) {
  const statuses = useMemo(() => computeStrategyStatus(records), [records]);
  if (!statuses.length) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.5, ease: 'easeOut' }}
      className="mt-4 rounded-2xl bg-white p-4 shadow-card ring-1 ring-ink/5 sm:mt-6 sm:p-5"
      aria-label="策略信号参考"
    >
      <div className="flex items-center gap-2">
        <Target size={16} className="text-gold" />
        <h2 className="text-sm font-semibold text-ink">策略信号参考</h2>
        <span className="text-[11px] text-inkSecondary/80">回测研究口径 · 非投资建议</span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {statuses.map((s) => {
          const style = LEG_STYLE[s.leg ?? 'none'];
          return (
            <div
              key={s.key}
              className="rounded-xl bg-page/60 px-4 py-3 ring-1 ring-ink/5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink">{s.name}</span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${style.cls}`}>
                  {style.label}
                </span>
              </div>
              <p className="mt-1.5 font-num text-xs text-inkSecondary">
                {s.current}　·　{s.distance}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-inkSecondary/75">{s.rule}</p>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-inkSecondary/70">
        以上为回测（2010-06 起，样本内）得到的规则状态，参数为历史拟合结果，不保证未来有效；
        规则持仓以「T 收盘信号、T+1 执行」为假设，仅供参考，不构成买卖建议。
      </p>
    </motion.section>
  );
}
