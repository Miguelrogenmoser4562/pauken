import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Repo } from "./db";
import type { Store } from "./db";
import { idbStore } from "./db/idb";
import { memoryStore } from "./db/memory";
import { CachingStore } from "./db/caching";
import { ServerStore, verifyKey } from "./api";
import { createEngine } from "./engine";
import type { Engine } from "./engine/types";
import { resilient } from "./engine/resilient";
import { detectProvider, loadApiKey } from "./engine/keys";
import { getEnginePrefs, saveEnginePrefs } from "./prefs";
import type { EnginePrefs, PaukenUser } from "./types";
import { reconcileJobs } from "./generation/pipeline";

let repoPromise: Promise<Repo> | null = null;

async function initLocalStore(): Promise<Store> {
  try {
    return await idbStore();
  } catch {
    return memoryStore();
  }
}

export function getRepo(prefs?: EnginePrefs): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      const p = prefs ?? getEnginePrefs();
      const localStore = await initLocalStore();

      let remoteStore: Store | null = null;
      if (p.serverUrl && p.userKey) {
        const user = await verifyKey(p.serverUrl, p.userKey).catch(() => null);
        if (user) {
          remoteStore = new ServerStore(p.serverUrl, p.userKey);
        }
      }

      const store = new CachingStore(localStore, remoteStore);
      const repo = new Repo(store);

      /* Initial sync from server to populate local cache */
      if (remoteStore) {
        store.pullAll().catch(() => {});
      }

      return repo;
    })();
  }
  return repoPromise;
}

export async function buildEngine(
  prefs: EnginePrefs = getEnginePrefs(),
): Promise<Engine | null> {
  if (!prefs.mode) return null;

  /* Server proxy mode: use server-side AI key */
  if (prefs.serverUrl && prefs.userKey) {
    try {
      return resilient(
        createEngine({
          mode: "cloud",
          serverUrl: prefs.serverUrl,
          userKey: prefs.userKey,
        }),
      );
    } catch {
      return null;
    }
  }

  /* Fall back to local API key */
  const key = await loadApiKey();
  const provider = prefs.cloudProvider || detectProvider(key);
  if (!provider) return null;
  return resilient(
    createEngine({
      mode: "cloud",
      provider,
      apiKey: key,
      model: prefs.cloudModel || undefined,
    }),
  );
}

const ALL_COLLECTIONS = [
  "notes", "folders", "classes", "flashcards",
  "quiz", "attempts", "review_logs", "chunks",
  "users", "class_members", "user_progress",
  "activity_events", "chat", "jobs", "reminders",
];

interface AppCtx {
  repo: Repo | null;
  engine: Engine | null;
  prefs: EnginePrefs;
  user: PaukenUser | null;
  ready: boolean;
  version: number;
  bump: () => void;
  reloadEngine: () => void;
  savePrefs: (p: EnginePrefs) => void;
  reconnect: (serverUrl: string, userKey: string) => Promise<PaukenUser | null>;
  disconnect: () => void;
  clearLocalData: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [prefs, setPrefs] = useState<EnginePrefs>(() => getEnginePrefs());
  const [user, setUser] = useState<PaukenUser | null>(null);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const reloadEngine = useCallback(() => {
    const p = getEnginePrefs();
    setPrefs(p);
    buildEngine(p).then(setEngine);
  }, []);

  const savePrefs = useCallback(
    (p: EnginePrefs) => {
      saveEnginePrefs(p);
      setPrefs(p);
      buildEngine(p).then(setEngine);
    },
    [],
  );

  const reconnect = useCallback(
    async (serverUrl: string, userKey: string): Promise<PaukenUser | null> => {
      const u = await verifyKey(serverUrl, userKey);
      if (!u) return null;
      const p = { ...getEnginePrefs(), serverUrl, userKey, avatar: u.avatar || "" };
      saveEnginePrefs(p);
      setPrefs(p);
      setUser(u);

      const localStore = await initLocalStore();
      const remoteStore = new ServerStore(serverUrl, userKey);
      const store = new CachingStore(localStore, remoteStore);
      await store.clearAllLocal().catch(() => {});
      store.pullAll().catch(() => {});
      repoPromise = Promise.resolve(new Repo(store));
      setRepo(await repoPromise);
      buildEngine(p).then(setEngine);
      return u;
    },
    [],
  );

  const disconnect = useCallback(() => {
    const p = { ...getEnginePrefs(), userKey: undefined, avatar: "" };
    saveEnginePrefs(p);
    setPrefs(p);
    setUser(null);
    repoPromise = null;
    getRepo().then(setRepo);
    buildEngine(p).then(setEngine);
  }, []);

  const clearLocalData = useCallback(async () => {
    const localStore = await initLocalStore();
    for (const col of ALL_COLLECTIONS) {
      await localStore.clear(col).catch(() => {});
    }
    repoPromise = null;
    const newRepo = await getRepo(prefs);
    setRepo(newRepo);
    bump();
  }, [prefs]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await getRepo(prefs);
      if (!alive) return;
      setRepo(r);

      if (prefs.serverUrl && prefs.userKey) {
        const u = await verifyKey(prefs.serverUrl, prefs.userKey);
        if (alive) {
          setUser(u);
          const next = { ...getEnginePrefs(), avatar: u?.avatar || getEnginePrefs().avatar };
          saveEnginePrefs(next);
        }
      }

      await reconcileJobs(r).catch(() => {});
      const e = await buildEngine().catch(() => null);
      if (!alive) return;
      setEngine(e);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<AppCtx>(
    () => ({
      repo,
      engine,
      prefs,
      user,
      ready,
      version,
      bump,
      reloadEngine,
      savePrefs,
      reconnect,
      disconnect,
      clearLocalData,
    }),
    [repo, engine, prefs, user, ready, version, bump, reloadEngine, savePrefs, reconnect, disconnect, clearLocalData],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}
