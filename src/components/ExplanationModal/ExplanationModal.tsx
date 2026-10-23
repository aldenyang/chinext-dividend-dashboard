import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, BookOpen } from 'lucide-react';
import { useReducedMotion } from '../../hooks/useMediaQuery';

interface ExplanationModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ExplanationModal({ open, onClose }: ExplanationModalProps) {
  const reduced = useReducedMotion();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-[2px] sm:items-center"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="指标说明与风险提示"
        >
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 40, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.98 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[80vh] sm:max-w-xl sm:rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-ink/8 px-5 py-4">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <BookOpen size={17} className="text-gold" />
                指标说明与风险提示
              </h2>
              <button
                ref={closeBtnRef}
                type="button"
                aria-label="关闭"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full text-inkSecondary transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 text-sm leading-relaxed text-ink">
              <h3 className="font-semibold">指标计算规则</h3>
              <p className="mt-1.5 text-[13px] text-ink/85">
                本工具通过创业板指数与中证红利指数相同交易日的收盘点位计算相对比值。计算公式：
                <span className="mx-1 rounded bg-gold/10 px-1.5 py-0.5 font-medium text-gold">
                  相对比值 = 创业板指数收盘点位 ÷ 中证红利指数收盘点位
                </span>
                比值反映指数之间的相对价格位置变化，不等于两者的真实估值比例。
              </p>

              <h3 className="mt-4 font-semibold">历史参考线</h3>
              <p className="mt-1.5 text-[13px] text-ink/85">
                0.3 和 0.7 来源于历史行情观察，用于辅助识别相对位置。这两个阈值不保证长期有效，也不代表市场一定在附近见底或见顶。
              </p>

              <h3 className="mt-4 font-semibold">指标使用限制</h3>
              <ul className="mt-1.5 list-none space-y-1 pl-0 text-[13px] text-ink/85">
                <li>1）指数比值不等于估值比值。</li>
                <li>2）历史上上涨或下跌不保证未来重复。</li>
                <li>3）市场结构变化可能导致历史区间失效。</li>
                <li>4）两种资产可能同时上涨或同时下跌。</li>
                <li>5）价格指数未完整反映分红再投资回报。</li>
                <li>6）历史极值不代表确定的买卖点。</li>
              </ul>

              <div className="mt-4 rounded-xl bg-page p-3.5 text-[13px] text-ink/85 ring-1 ring-ink/6">
                <h3 className="font-semibold">风险提示</h3>
                <p className="mt-1.5">
                  本工具仅供个人研究、历史数据观察及市场风格分析使用，不构成证券、基金投资建议，也不承诺任何投资收益。投资有风险，决策需谨慎。
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
