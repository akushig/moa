'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DateForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initial);

  const submit = () => {
    if (!date) return;
    router.push(`/asset?at=${encodeURIComponent(date)}`);
  };

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="text-xs bg-transparent border border-white/15 rounded px-2 py-1 [color-scheme:dark]"
      />
      <button
        type="submit"
        className="text-xs px-3 py-1 rounded border border-white/15 hover:border-white/30"
      >
        조회
      </button>
    </form>
  );
}
