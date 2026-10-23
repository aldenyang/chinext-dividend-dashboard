import type { RangeKey, Granularity } from '../charts/MainChart';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '1y', label: '近 1 年' },
  { key: '3y', label: '近 3 年' },
  { key: '5y', label: '近 5 年' },
  { key: 'all', label: '全部' },
];

const GRANULARITIES: Array<{ key: Granularity; label: string }> = [
  { key: 'year', label: '年' },
  { key: 'month', label: '月' },
  { key: 'day', label: '日' },
];

interface TimeRangeSelectorProps {
  range: RangeKey;
  granularity: Granularity;
  onRangeChange: (r: RangeKey) => void;
  onGranularityChange: (g: Granularity) => void;
}

export default function TimeRangeSelector({
  range,
  granularity,
  onRangeChange,
  onGranularityChange,
}: TimeRangeSelectorProps) {
  const btn = (active: boolean) =>
    `min-h-[36px] min-w-[44px] rounded-lg px-3 text-xs font-medium transition-colors ${
      active ? 'bg-ink text-white shadow-sm' : 'bg-white text-inkSecondary ring-1 ring-ink/8 hover:text-ink'
    }`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
      <div className="flex items-center gap-1.5" role="group" aria-label="时间刻度切换">
        <span className="mr-0.5 hidden text-[11px] text-inkSecondary sm:inline">刻度</span>
        {GRANULARITIES.map((g) => (
          <button key={g.key} type="button" className={btn(granularity === g.key)} onClick={() => onGranularityChange(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5" role="group" aria-label="快捷时间范围">
        <span className="mr-0.5 hidden text-[11px] text-inkSecondary sm:inline">范围</span>
        {RANGES.map((r) => (
          <button key={r.key} type="button" className={btn(range === r.key)} onClick={() => onRangeChange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}
