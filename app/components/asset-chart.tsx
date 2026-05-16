'use client';

import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

type Point = { date: string; totalKrw: number; crypto: number; cash: number };
type Range = '7d' | '30d' | '90d' | 'all';

const RANGES: { key: Range; label: string }[] = [
  { key: '7d', label: '7일' },
  { key: '30d', label: '30일' },
  { key: '90d', label: '90일' },
  { key: 'all', label: '전체' },
];

function formatAxis(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}만`;
  return String(v);
}

function formatTooltipValue(v: number): string {
  return v.toLocaleString('ko-KR') + '원';
}

export function AssetChart() {
  const [range, setRange] = useState<Range>('30d');
  const [data, setData] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/chart?range=${range}`)
      .then((r) => r.json())
      .then((j: { points: Point[] }) => setData(j.points))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [range]);

  if (loading && data.length === 0) {
    return <div className="h-[280px] flex items-center justify-center text-xs text-[var(--muted)]">차트 로딩…</div>;
  }

  if (data.length < 2) {
    return (
      <div className="h-[280px] flex items-center justify-center text-xs text-[var(--muted)]">
        동기화 2회 이상 해야 차트가 표시됩니다
      </div>
    );
  }

  const first = data[0].totalKrw;
  const last = data[data.length - 1].totalKrw;
  const diff = last - first;
  const pct = first > 0 ? (diff / first) * 100 : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm text-[var(--muted)] uppercase tracking-wider">자산 추이</h2>
          <span
            className={`text-xs ${diff >= 0 ? 'text-[var(--accent)]' : 'text-[var(--negative)]'}`}
          >
            {diff >= 0 ? '+' : ''}
            {formatAxis(diff)} ({pct >= 0 ? '+' : ''}
            {pct.toFixed(1)}%)
          </span>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`text-[11px] px-2 py-0.5 rounded ${
                range === r.key
                  ? 'bg-white/10 text-white'
                  : 'text-[var(--muted)] hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4ade80" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#8a93a0' }}
            tickFormatter={(d: string) => d.slice(5)} // MM-DD
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#8a93a0' }}
            tickFormatter={formatAxis}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1d23',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: '#8a93a0' }}
            formatter={(value: unknown, name: unknown) => [
              formatTooltipValue(Number(value)),
              name === 'totalKrw' ? '총자산' : name === 'crypto' ? '암호화폐' : '현금',
            ]}
          />
          <Area
            type="monotone"
            dataKey="totalKrw"
            stroke="#4ade80"
            strokeWidth={2}
            fill="url(#gradTotal)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
