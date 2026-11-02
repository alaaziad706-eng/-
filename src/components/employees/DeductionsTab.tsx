import { useState, useEffect, useCallback } from 'react';
import { Plus, X, AlertCircle, MinusCircle } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import Badge from '@/components/ui/Badge';
import { formatEGP, formatShortDate } from '@/lib/format';
import {
  listEmployees, listDeductions, recordDeduction,
  type Employee, type EmployeeDeduction,
} from '@/services/employeeService';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function DeductionsTab({ canAdd }: { canAdd: boolean }) {
  const [deductions, setDeductions] = useState<EmployeeDeduction[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [month, setMonth] = useState(currentMonth());
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    const [d, e] = await Promise.all([listDeductions(month), listEmployees()]);
    setDeductions(d); setEmployees(e);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="card p-4 flex items-end gap-3">
        <div><label className="text-sm font-semibold text-slate-700 mb-1 block">الشهر</label><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="input-base" /></div>
        {canAdd && <button onClick={() => setShowModal(true)} className="btn-primary"><Plus className="h-4 w-4" /> خصم جديد</button>}
      </div>
      <div className="card overflow-hidden">
        {deductions.length === 0 ? (
          <EmptyState icon={MinusCircle} title="لا توجد خصومات لهذا الشهر" description="تُسجَّل هنا الخصومات بالمبلغ والسبب، وتُخصم تلقائيًا من صافي راتب الشهر." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 bg-slate-50/60 text-slate-500">
                <th className="px-4 py-3 text-right font-semibold">الموظف</th><th className="px-4 py-3 text-right font-semibold">الشهر</th>
                <th className="px-4 py-3 text-right font-semibold">المبلغ</th><th className="px-4 py-3 text-right font-semibold">السبب</th>
                <th className="px-4 py-3 text-right font-semibold">الحالة</th>
              </tr></thead>
              <tbody>
                {deductions.map((d) => (
                  <tr key={d.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-3 text-slate-700 font-semibold">{d.employee_name}</td>
                    <td className="px-4 py-3 num text-slate-600">{formatShortDate(d.month)}</td>
                    <td className="px-4 py-3 num font-semibold text-rose-600">{formatEGP(d.amount / 100)}</td>
                    <td className="px-4 py-3 text-slate-600">{d.reason}</td>
                    <td className="px-4 py-3">{d.applied ? <Badge tone="emerald" dot>مطبّق في المسير</Badge> : <Badge tone="amber" dot>بانتظار المسير</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showModal && <DeductionModal employees={employees} defaultMonth={month} onClose={() => setShowModal(false)} onSaved={load} />}
    </div>
  );
}

function DeductionModal({ employees, defaultMonth, onClose, onSaved }: {
  employees: Employee[]; defaultMonth: string; onClose: () => void; onSaved: () => void;
}) {
  const [empId, setEmpId] = useState('');
  const [month, setMonth] = useState(defaultMonth);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const amt = parseFloat(amount);
    if (!empId) { setError('اختر الموظف'); return; }
    if (!month) { setError('اختر الشهر'); return; }
    if (!amt || amt <= 0) { setError('أدخل مبلغًا صحيحًا'); return; }
    if (!reason.trim()) { setError('اكتب سبب الخصم'); return; }
    try {
      await recordDeduction({ employeeId: empId, month, amount: amt, reason });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'خطأ'); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <div className="card p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800">خصم جديد</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">الموظف</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="input-base">
              <option value="">اختر</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-sm font-semibold text-slate-700 mb-1 block">الشهر</label><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="input-base" /></div>
            <div><label className="text-sm font-semibold text-slate-700 mb-1 block">المبلغ (ج.م)</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-base num" /></div>
          </div>
          <div><label className="text-sm font-semibold text-slate-700 mb-1 block">السبب</label><input value={reason} onChange={(e) => setReason(e.target.value)} className="input-base" /></div>
          {error && <div className="flex items-center gap-2 text-sm text-rose-600"><AlertCircle className="h-4 w-4" />{error}</div>}
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={handleSave} className="btn-primary flex-1">حفظ</button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
