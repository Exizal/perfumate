import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyChangeset, emptyState, type Changeset, type DataState } from '../domain/types';
import { DomainError } from '../domain/batch';
import { commit, loadAll, openDatabase, replaceAll, type DB } from './db';

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'error';

interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

interface StoreValue {
  state: DataState;
  status: SaveStatus;
  lastError: string | null;
  persisted: boolean | null;
  /** Compute a changeset from the latest state, persist it, then update memory. */
  run: (producer: (s: DataState) => Changeset) => Promise<Changeset | null>;
  replace: (s: DataState) => Promise<boolean>;
  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
  errorText: (e: unknown) => string;
  setErrorTranslator: (fn: (code: string) => string) => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DataState>(emptyState());
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [lastError, setLastError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dbRef = useRef<DB | null>(null);
  const stateRef = useRef(state);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const translator = useRef<(code: string) => string>((c) => c);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await openDatabase();
        dbRef.current = db;
        const loaded = await loadAll(db);
        if (cancelled) return;
        stateRef.current = loaded;
        setState(loaded);
        setStatus('saved');
        if (navigator.storage?.persisted) setPersisted(await navigator.storage.persisted());
      } catch (e) {
        setStatus('error');
        setLastError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const errorText = useCallback((e: unknown) => {
    if (e instanceof DomainError) return translator.current(e.code);
    if (e && typeof e === 'object' && 'code' in e) return translator.current(String((e as { code: string }).code));
    return String(e instanceof Error ? e.message : e);
  }, []);

  const run = useCallback((producer: (s: DataState) => Changeset) => {
    // Serialize writes so each producer sees the result of the previous one.
    const p = queue.current.then(async () => {
      const db = dbRef.current;
      if (!db) throw new Error('Database not ready');
      let cs: Changeset;
      try {
        cs = producer(stateRef.current);
      } catch (e) {
        toast(errorText(e), 'error');
        return null;
      }
      setStatus('saving');
      try {
        await commit(db, cs);
      } catch (e) {
        setStatus('error');
        setLastError(String(e));
        toast(String(e), 'error');
        return null;
      }
      stateRef.current = applyChangeset(stateRef.current, cs);
      setState(stateRef.current);
      setStatus('saved');
      return cs;
    });
    queue.current = p.catch(() => undefined);
    return p;
  }, [toast, errorText]);

  const replace = useCallback(async (s: DataState) => {
    const db = dbRef.current;
    if (!db) return false;
    setStatus('saving');
    try {
      await replaceAll(db, s);
      const loaded = await loadAll(db);
      stateRef.current = loaded;
      setState(loaded);
      setStatus('saved');
      return true;
    } catch (e) {
      setStatus('error');
      setLastError(String(e));
      toast(String(e), 'error');
      return false;
    }
  }, [toast]);

  const value = useMemo<StoreValue>(() => ({
    state, status, lastError, persisted, run, replace, toasts, toast,
    dismiss: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    errorText,
    setErrorTranslator: (fn) => { translator.current = fn; },
  }), [state, status, lastError, persisted, run, replace, toasts, toast, errorText]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}

export function useData(): DataState {
  return useStore().state;
}
