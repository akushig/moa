'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

type Props = {
  parts: {
    crypto: number;
    cashExchange: number;
    cashManual: number;
    realestateNet: number;
    negativeAccount: number;
    loan: number;
    exchangeDebt: number;
  };
};

const COLORS: Record<string, string> = {
  '암호화폐': '#4ade80',
  '현금 (거래소)': '#60a5fa',
  '현금 (수기)': '#818cf8',
  '부동산': '#fbbf24',
};

function formatValue(v: number): string {
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}만`;
  return v.toLocaleString('ko-KR') + '원';
}

export function AllocationChart({ parts }: Props) {
  // 자산만 파이에 표시 (부채는 제외). 음수는 0 처리.
  const raw = [
    { name: '암호화폐', value: parts.crypto },
    { name: '현금 (거래소)', value: parts.cashExchange },
    { name: '현금 (수기)', value: parts.cashManual },
    { name: '부동산', value: parts.realestateNet },
  ].filter((d) => d.value > 0);

  if (raw.length === 0) return null;

  const total = raw.reduce((a, d) => a + d.value, 0);

  return (
    <div>
      <h2 className="text-sm text-[var(--muted)] uppercase tracking-wider mb-3">자산 배분</h2>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={raw}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            strokeWidth={0}
          >
            {raw.map((entry) => (
              <Cell key={entry.name} fill={COLORS[entry.name] ?? '#6b7280'} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: '#1a1d23',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: unknown) => [formatValue(Number(value)), null]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 justify-center">
        {raw.map((d) => (
          <div key={d.name} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ background: COLORS[d.name] ?? '#6b7280' }}
            />
            <span className="text-[var(--muted)]">{d.name}</span>
            <span>{((d.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
