export type PendingAutosave = {
  readonly updateId: string;
  readonly articleId: string;
  readonly steps: readonly unknown[];
  readonly createdAt: number;
  readonly clientSequence: number;
};
const DB_NAME = 'agentpress-editor';
const STORE = 'pending-autosaves';
export async function enqueueAutosave(value: PendingAutosave): Promise<void> {
  const database = await openDatabase();
  await request(database.transaction(STORE, 'readwrite').objectStore(STORE).put(value));
  database.close();
}
export async function acknowledgeAutosave(updateId: string): Promise<void> {
  const database = await openDatabase();
  await request(database.transaction(STORE, 'readwrite').objectStore(STORE).delete(updateId));
  database.close();
}
export async function listPendingAutosaves(articleId: string): Promise<readonly PendingAutosave[]> {
  const database = await openDatabase();
  const values = await request<unknown[]>(database.transaction(STORE).objectStore(STORE).getAll());
  database.close();
  return values
    .filter(isPendingAutosave)
    .filter((value) => value.articleId === articleId)
    .sort(comparePendingAutosaves);
}

export function comparePendingAutosaves(a: PendingAutosave, b: PendingAutosave): number {
  return (
    a.createdAt - b.createdAt ||
    a.clientSequence - b.clientSequence ||
    a.updateId.localeCompare(b.updateId)
  );
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const value = indexedDB.open(DB_NAME, 1);
    value.onupgradeneeded = () => {
      if (!value.result.objectStoreNames.contains(STORE))
        value.result.createObjectStore(STORE, { keyPath: 'updateId' });
    };
    value.onsuccess = () => {
      resolve(value.result);
    };
    value.onerror = () => {
      reject(value.error ?? new Error('IndexedDB open failed'));
    };
  });
}
function request<T = undefined>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => {
      resolve(value.result);
    };
    value.onerror = () => {
      reject(value.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function isPendingAutosave(value: unknown): value is PendingAutosave {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.updateId === 'string' &&
    typeof item.articleId === 'string' &&
    Array.isArray(item.steps) &&
    typeof item.createdAt === 'number' &&
    typeof item.clientSequence === 'number'
  );
}
