import type { ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';

export default function InventoryModal({ title, onClose, children, wide = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <div className={`card p-6 w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="إغلاق"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="flex items-center gap-2 text-sm text-rose-600"><AlertCircle className="h-4 w-4 shrink-0" />{message}</div>;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'حدث خطأ غير متوقع';
}
