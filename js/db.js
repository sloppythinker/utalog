// IndexedDB ラッパー
const DB = (() => {
  const DB_NAME = "karaoke-repertoire";
  const DB_VER = 1;
  const STORE = "songs";
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      let blocked = false;
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error("IndexedDBを開けませんでした"));
      };
      req.onblocked = () => {
        blocked = true;
        dbPromise = null;
        reject(new Error("別のタブがデータベースを使用中です。ほかのうたログを閉じて再試行してください"));
      };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      let settled = false;
      t.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(t.error || new Error("データの保存に失敗しました"));
      };
      t.onerror = fail;
      t.onabort = fail;
    }));
  }

  function getAll() {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function put(song) {
    return tx("readwrite", store => { store.put(song); return song; });
  }

  function bulkPut(songs) {
    return tx("readwrite", store => { songs.forEach(s => store.put(s)); return songs.length; });
  }

  function remove(id) {
    return tx("readwrite", store => { store.delete(id); });
  }

  function bulkRemove(ids) {
    return tx("readwrite", store => { ids.forEach(id => store.delete(id)); return ids.length; });
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  return { getAll, put, bulkPut, remove, bulkRemove, newId };
})();
