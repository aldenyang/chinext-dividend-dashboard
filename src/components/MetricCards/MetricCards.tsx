import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { DailyRecord, Metadata } from '../../types/market';
import {
  LOW_REF,
  HIGH_REF,
  STATUS_TEXT,
  STATUS_COLOR,
  getRatioStatus,
  diffToRefs,
  dailyChangePct,
  latestRecord,
} from '../../utils/calculations/ratio';
import { fmtPrice, fmtRatio, fmtPct } from '../../utils/formatting/format';
import { useReducedMotion } from '../../hooks/useMediaQuery';

/** 数字滚动动画（尊重系统减少动效偏好） */
function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }
    const from = prevRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);

  return <>{format(display)}</>;
}

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-inkSecondary">涨跌幅：—</span>;
  const up = pct >= 0;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-semibold"
      style={{ color: up ? '#E65B64' : '#20A97B' }}
    >
      涨跌幅：{fmtPct(pct)}
    </span>
  );
}

/** 比值区间位置条：0.3–0.7 映射到条形轨道，越界时贴边并提示 */
function PositionBar({ ratio }: { ratio: number }) {
  const span = HIGH_REF - LOW_REF;
  const clamped = Math.min(Math.max(ratio, LOW_REF), HIGH_REF);
  const pct = ((clamped - LOW_REF) / span) * 100;
  const outLow = ratio < LOW_REF;
  const outHigh = ratio > HIGH_REF;

  return (
    <div className="mt-3">
      <div className="relative h-2.5 w-full rounded-full bg-gradient-to-r from-safe/25 via-inkSecondary/15 to-danger/25">
        <div
          className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold shadow"
          style={{ left: `${pct}%` }}
        />
        <span className="absolute -left-0.5 top-4 text-[10px] text-safe">0.300</span>
        <span className="absolute -right-1 top-4 text-[10px] text-danger">0.700</span>
      </div>
      {outLow && <div className="mt-6 text-center text-[11px] font-medium text-safe">当前比值低于参考区间</div>}
      {outHigh && <div className="mt-6 text-center text-[11px] font-medium text-danger">当前比值高于参考区间</div>}
      {!outLow && !outHigh && <div className="mt-5.5 h-4" />}
    </div>
  );
}

interface MetricCardsProps {
  records: DailyRecord[];
  meta: Metadata | null;
}

export default function MetricCards({ records }: MetricCardsProps) {
  const latest = latestRecord(records);
  const lastRatioRec = (() => {
    for (let i = records.length - 1; i >= 0; i--) if (records[i].ratio !== null) return records[i];
    return null;
  })();

  const ratio = lastRatioRec?.ratio ?? null;
  const status = ratio !== null ? getRatioStatus(ratio) : null;
  const diffs = ratio !== null ? diffToRefs(ratio) : null;

  const chinextLatest = latest?.chinextClose ?? null;
  const chinextDate = latest?.chinextClose !== null && latest ? latest.date : null;
  const dividendLatest = latest?.dividendClose ?? null;
  const dividendDate = latest?.dividendClose !== null && latest ? latest.date : null;

  const chinextChg = chinextDate ? dailyChangePct(records, chinextDate, 'chinextClose') : null;
  const dividendChg = dividendDate ? dailyChangePct(records, dividendDate, 'dividendClose') : null;

  const cardBase =
    'rounded-2xl bg-white p-4 shadow-card ring-1 ring-ink/5 sm:p-5 transition-shadow hover:shadow-cardHover';

  const item = (i: number) => ({
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: { delay: 0.08 * i, duration: 0.45, ease: 'easeOut' as const },
  });

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {/* 卡片一：当前相对比值 */}
      <motion.section {...item(0)} className={`${cardBase} col-span-2 lg:col-span-1`} aria-label="当前相对比值">
        <h2 className="text-xs font-medium text-inkSecondary">当前相对比值</h2>
        <div className="mt-1 font-num text-4xl font-bold tracking-tight text-gold sm:text-[2.6rem]">
          <CountUp value={ratio ?? 0} format={(v) => (ratio === null ? '—' : fmtRatio(v))} />
        </div>
        {status && (
          <span
            className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ color: STATUS_COLOR[status], background: `${STATUS_COLOR[status]}18` }}
          >
            {STATUS_TEXT[status]}
          </span>
        )}
        {diffs && (
          <div className="mt-2 space-y-0.5 text-[11px] text-inkSecondary">
            <div>
              距低位参考线 <b className="text-safe">{diffs.toLow}</b>
            </div>
            <div>
              距高位参考线 <b className="text-danger">{diffs.toHigh}</b>
            </div>
          </div>
        )}
      </motion.section>

      {/* 卡片二：创业板指数 */}
      <motion.section {...item(1)} className={cardBase} aria-label="创业板指数">
        <h2 className="text-xs font-medium text-inkSecondary">
          创业板指数 <span className="text-inkSecondary/60">399006</span>
        </h2>
        <div className="mt-1 font-num text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          {fmtPrice(chinextLatest)}
        </div>
        <div className="mt-1.5">
          <ChangeBadge pct={chinextChg} />
        </div>
        <div className="mt-1 text-[11px] text-inkSecondary">交易日：{chinextDate ?? '—'}</div>
      </motion.section>

      {/* 卡片三：中证红利指数 */}
      <motion.section {...item(2)} className={cardBase} aria-label="中证红利指数">
        <h2 className="text-xs font-medium text-inkSecondary">
          中证红利指数 <span className="text-inkSecondary/60">000922</span>
        </h2>
        <div className="mt-1 font-num text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          {fmtPrice(dividendLatest)}
        </div>
        <div className="mt-1.5">
          <ChangeBadge pct={dividendChg} />
        </div>
        <div className="mt-1 text-[11px] text-inkSecondary">交易日：{dividendDate ?? '—'}</div>
      </motion.section>

      {/* 卡片四：历史参考区间 */}
      <motion.section {...item(3)} className={`${cardBase} col-span-2 lg:col-span-1`} aria-label="历史参考区间">
        <h2 className="text-xs font-medium text-inkSecondary">历史参考区间</h2>
        <div className="mt-1.5 flex items-baseline gap-4 text-sm font-semibold">
          <span className="text-safe">低位 {LOW_REF.toFixed(3)}</span>
          <span className="text-danger">高位 {HIGH_REF.toFixed(3)}</span>
        </div>
        {ratio !== null ? (
          <PositionBar ratio={ratio} />
        ) : (
          <div className="mt-4 text-xs text-inkSecondary">暂无比值数据</div>
        )}
      </motion.section>
    </div>
  );
}
