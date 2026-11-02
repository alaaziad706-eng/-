import {
  getDesktopApi,
  type DesktopProductInput,
  type DesktopProductRow,
  type DesktopStockBalanceRow,
  type DesktopStockCountRow,
  type DesktopStockMovementRow,
  type DesktopWarehouseRow,
} from '@/lib/electronBridge';

export const MAIN_WAREHOUSE_ID = 'wh_main';

function poundsToPiastres(pounds: number): number {
  return Math.round(pounds * 100);
}

export const CATEGORY_LABELS: Record<string, string> = {
  feed: 'أعلاف', supplies: 'مستلزمات', medication: 'أدوية', spare_parts: 'قطع غيار', other: 'أخرى',
};

export const MOVEMENT_LABELS: Record<string, string> = {
  purchase: 'شراء', sale: 'بيع', sale_return: 'مرتجع بيع', purchase_return: 'مرتجع شراء',
  issue: 'صرف', adjustment: 'وارد يدوي', count: 'جرد', transfer: 'تحويل',
};

function requireDesktop() {
  const desktop = getDesktopApi();
  if (!desktop) throw new Error('إدارة المخزون متاحة داخل تطبيق سطح المكتب فقط');
  return desktop;
}

export async function listProducts(): Promise<DesktopProductRow[]> {
  const desktop = getDesktopApi();
  return desktop ? desktop.farm.products.list() : [];
}

export async function createProduct(input: DesktopProductInput): Promise<{ id: string }> {
  return requireDesktop().farm.products.create(input);
}

export async function updateProduct(id: string, input: DesktopProductInput): Promise<{ id: string }> {
  return requireDesktop().farm.products.update({ ...input, id });
}

export async function listWarehouses(): Promise<DesktopWarehouseRow[]> {
  const desktop = getDesktopApi();
  return desktop ? desktop.farm.warehouses.list() : [];
}

export async function createWarehouse(name: string): Promise<{ id: string }> {
  return requireDesktop().farm.warehouses.create({ name });
}

export async function listStockBalances(warehouseId: string): Promise<DesktopStockBalanceRow[]> {
  const desktop = getDesktopApi();
  return desktop ? desktop.farm.stock.balances({ warehouseId }) : [];
}

export async function listStockMovements(args?: { productId?: string | null; warehouseId?: string | null }): Promise<DesktopStockMovementRow[]> {
  const desktop = getDesktopApi();
  return desktop ? desktop.farm.stock.movements(args) : [];
}

export async function listStockCounts(): Promise<DesktopStockCountRow[]> {
  const desktop = getDesktopApi();
  return desktop ? desktop.farm.stock.counts() : [];
}

export interface StockEntryForm {
  date: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  unitCostPounds?: number;
  activityId?: string | null;
  notes?: string | null;
}

export async function receiveStock(form: StockEntryForm): Promise<{ totalCost: number }> {
  return requireDesktop().farm.stock.receive({
    date: form.date, productId: form.productId, warehouseId: form.warehouseId, quantity: form.quantity,
    unitCost: poundsToPiastres(form.unitCostPounds ?? 0), activityId: form.activityId ?? null, notes: form.notes ?? null,
  });
}

export async function issueStock(form: StockEntryForm): Promise<{ totalCost: number }> {
  return requireDesktop().farm.stock.issue({
    date: form.date, productId: form.productId, warehouseId: form.warehouseId, quantity: form.quantity,
    activityId: form.activityId ?? null, notes: form.notes ?? null,
  });
}

export async function transferStock(input: {
  date: string; productId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; notes?: string | null;
}): Promise<{ id: string; totalCost: number }> {
  return requireDesktop().farm.stock.transfer({ ...input, notes: input.notes ?? null });
}

export interface StockCountForm {
  date: string;
  warehouseId: string;
  notes?: string | null;
  items: { productId: string; countedQuantity: number; unitCostPounds?: number }[];
}

export async function recordStockCount(form: StockCountForm): Promise<{ id: string; docNumber: string; gains: number; losses: number }> {
  return requireDesktop().farm.stock.count({
    date: form.date,
    warehouseId: form.warehouseId,
    notes: form.notes ?? null,
    items: form.items.map((item) => ({
      productId: item.productId,
      countedQuantity: item.countedQuantity,
      ...(item.unitCostPounds !== undefined ? { unitCost: poundsToPiastres(item.unitCostPounds) } : {}),
    })),
  });
}
