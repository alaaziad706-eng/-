import { useEffect, useState } from 'react';
import { listCashboxes, type Cashbox } from '@/services/treasuryService';

interface CashboxSelectProps {
  value: string;
  onChange: (cashboxId: string) => void;
  label?: string;
  disabled?: boolean;
}

export default function CashboxSelect({ value, onChange, label = 'الخزينة', disabled = false }: CashboxSelectProps) {
  const [cashboxes, setCashboxes] = useState<Cashbox[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listCashboxes()
      .then((rows) => {
        setCashboxes(rows);
        if (!value && rows[0]) onChange(rows[0].id);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'تعذر تحميل الخزائن'));
    // Load once; the parent owns the selected value afterwards.
  }, []);

  return (
    <div>
      <label className="text-sm font-semibold text-slate-700 mb-1 block">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input-base" disabled={disabled || cashboxes.length === 0}>
        {cashboxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
      </select>
      {loadError && <p className="text-xs text-rose-600 mt-1">{loadError}</p>}
    </div>
  );
}
