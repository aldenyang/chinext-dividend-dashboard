import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyRecord, Metadata } from '../types/market';
import { loadDashboardData } from '../services/marketData/loader';

export interface MarketDataState {
  meta: Metadata | null;
  records: DailyRecord[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** 刷新：重新检查线上数据版本，有新版本才重新拉取历史文件 */
  refresh: () => Promise<void>;
  checking: boolean;
  /** 刷新后若有新数据给出提示 */
  justUpdated: boolean;
}

export function useMarketData(): MarketDataState {
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [records, setRecords] = useState<DailyRecord[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  const versionRef = useRef<string | null>(null);

  const doLoad = useCallback(async (isRefresh: boolean) => {
    setChecking(true);
    try {
      const { meta: newMeta, records: newRecords } = await loadDashboardData();
      const changed = versionRef.current !== null && versionRef.current !== newMeta.version;
      versionRef.current = newMeta.version;
      setMeta(newMeta);
      setRecords(newRecords);
      setError(null);
      setStatus('ready');
      if (isRefresh && changed) {
        setJustUpdated(true);
        window.setTimeout(() => setJustUpdated(false), 4000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '数据加载失败，请稍后重试');
      // 刷新失败且已有数据：保留已加载数据，不进入 error 态遮蔽页面
      if (!isRefresh || versionRef.current === null) {
        setStatus('error');
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void doLoad(false);
  }, [doLoad]);

  const refresh = useCallback(async () => {
    await doLoad(true);
  }, [doLoad]);

  return { meta, records, status, error, refresh, checking, justUpdated };
}
