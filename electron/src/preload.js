const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
  dbStatus: () => invoke('db:status'),
  backupCreate: () => invoke('backup:create'),
  auth: {
    state: () => invoke('auth:state'),
    setupOwner: (input) => invoke('auth:setupOwner', input),
    login: (input) => invoke('auth:login', input),
    logout: () => invoke('auth:logout'),
    changePassword: (input) => invoke('auth:changePassword', input),
    currentUser: () => invoke('auth:currentUser'),
  },
  users: {
    list: () => invoke('users:list'),
    permissions: () => invoke('users:permissions'),
    create: (input) => invoke('users:create', input),
    update: (id, changes) => invoke('users:update', { id, changes }),
  },
  farm: {
    expenses: {
      categories: () => invoke('expenses:categories'),
      list: (args) => invoke('expenses:list', args),
      create: (input) => invoke('expenses:create', input),
      cancel: (input) => invoke('expenses:cancel', input),
    },
    incomes: {
      list: (args) => invoke('incomes:list', args),
      create: (input) => invoke('incomes:create', input),
      cancel: (input) => invoke('incomes:cancel', input),
    },
    parties: {
      list: (args) => invoke('parties:list', args),
      create: (input) => invoke('parties:create', input),
      statement: (args) => invoke('parties:statement', args),
      delete: (partyId) => invoke('parties:delete', { partyId }),
    },
    activities: {
      list: () => invoke('activities:list'),
    },
    products: {
      list: () => invoke('products:list'),
      create: (input) => invoke('products:create', input),
      update: (input) => invoke('products:update', input),
    },
    warehouses: {
      list: () => invoke('warehouses:list'),
      create: (input) => invoke('warehouses:create', input),
    },
    stock: {
      balances: (args) => invoke('stock:balances', args),
      movements: (args) => invoke('stock:movements', args),
      receive: (input) => invoke('stock:receive', input),
      issue: (input) => invoke('stock:issue', input),
      transfer: (input) => invoke('stock:transfer', input),
      counts: () => invoke('stock:counts'),
      count: (input) => invoke('stock:count', input),
    },
    invoices: {
      list: (args) => invoke('invoices:list', args),
      create: (input) => invoke('invoices:create', input),
      pay: (input) => invoke('invoices:pay', input),
      return: (input) => invoke('invoices:return', input),
      cancel: (input) => invoke('invoices:cancel', input),
    },
    customers: {
      credits: () => invoke('customers:credits'),
      refundCredit: (input) => invoke('customers:refundCredit', input),
    },
    treasury: {
      createCashbox: (input) => invoke('treasury:createCashbox', input),
      statement: (args) => invoke('treasury:statement', args),
      transfers: () => invoke('transfers:list'),
      createTransfer: (input) => invoke('transfers:create', input),
      checks: () => invoke('checks:list'),
      createCheck: (input) => invoke('checks:create', input),
    },
    employees: {
      list: () => invoke('employees:list'),
      create: (input) => invoke('employees:create', input),
      attendance: (args) => invoke('employees:attendance', args),
      recordAttendance: (input) => invoke('employees:recordAttendance', input),
      advances: (args) => invoke('employees:advances', args),
      createAdvance: (input) => invoke('employees:createAdvance', input),
      salaries: (args) => invoke('employees:salaries', args),
      createSalary: (input) => invoke('employees:createSalary', input),
      paySalary: (input) => invoke('employees:paySalary', input),
    },
    dashboard: {
      summary: (args) => invoke('dashboard:summary', args),
    },
    backups: {
      list: () => invoke('backup:list'),
      restore: (filename) => invoke('backup:restore', { filename }),
    },
  },
});
