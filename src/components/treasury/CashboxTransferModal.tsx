import { useEffect, useState } from 'react';
import { X, AlertCircle, ArrowLeftRight } from 'lucide-react';
import { useSession } from '@/context/SessionContext';
import { listCashboxes, transferBetweenCashboxes, type Cashbox } from '@/services/treasuryService';

export default function CashboxTransferModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useSession();
  const [cashboxes, setCashboxes] = useState<Cashbox[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listCashboxes()
      .then((rows) => {
        setCashboxes(rows);
        setFromId(rows[0]?.id ?? '');
        setToId(rows[1]?.id ?? rows[0]?.id ?? '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'تعذر تحميل الخزائن'));
  }, []);

  async function handleSave() {
    setError(null);
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError('أدخل مبلغًا صحيحًا'); return; }
    if (!fromId || !toId) { setError('اختر الخزينتين'); return; }
    if (fromId === toId) { setError('اختر خزينتين مختلفتين'); return; }
    setSaving(true);
    try {
      await transferBetweenCashboxes({ date, fromCashboxId: fromId, toCashboxId: toId, amount: amt, description, createdBy: user?.id ?? null });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'خطأ'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <div className="card p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800 flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" /> تحويل بين الخزائن</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">من خزينة</label>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="input-base">
              {cashboxes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">إلى خزينة</label>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="input-base">
              {cashboxes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">التاريخ</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input-base" /></div>
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">المبلغ (ج.م)</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-base num" /></div>
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">البيان</label><input value={description} onChange={(e) => setDescription(e.target.value)} className="input-base" /></div>
          {error && <div className="flex items-center gap-2 text-sm text-rose-600"><AlertCircle className="h-4 w-4" />{error}</div>}
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">{saving ? 'جارٍ الحفظ...' : 'تحويل'}</button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
