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
      let result;
      let settled = false;
      const abort = error => {
        if (settled) return;
        try { t.abort(); } catch (_) { /* 既に中断済み */ }
        settled = true;
        reject(error);
      };
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
      try { result = fn(store, abort); }
      catch (error) { abort(error); }
    }));
  }

  function getAll() {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function snapshot(song) {
    // オブジェクトのプロパティ順の違いを更新競合と誤認しない。
    return song == null ? null : JSON.stringify(song, (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value);
  }

  function conflict() {
    const error = new Error("別の画面で曲が変更されています。入力は残しています。一度閉じて最新の内容を開き直してください");
    error.name = "ConflictError";
    return error;
  }

  function bulkPut(songs, options = {}) {
    return tx("readwrite", (store, abort) => {
      const write = () => {
        try { songs.forEach(song => store.put(song)); }
        catch (error) { abort(error); }
      };
      if (!songs.length) return 0;
      if (!options.expected && !options.maxSongs) {
        write();
        return songs.length;
      }
      let remaining = songs.length;
      let additions = 0;
      songs.forEach(song => {
        const request = store.get(song.id);
        request.onsuccess = () => {
          try {
            if (options.expected && (!options.expected.has(song.id) ||
                snapshot(request.result) !== options.expected.get(song.id))) {
              abort(conflict());
              return;
            }
            if (!request.result) additions++;
            if (--remaining) return;
            if (options.maxSongs && additions) {
              const count = store.count();
              count.onsuccess = () => {
                if (count.result + additions > options.maxSongs) {
                  abort(new Error(`曲数が上限（${options.maxSongs}曲）を超えます`));
                } else write();
              };
            } else write();
          } catch (error) { abort(error); }
        };
      });
      return songs.length;
    });
  }

  function put(song, options = {}) {
    const checked = { ...options };
    if (Object.prototype.hasOwnProperty.call(options, "expected")) {
      checked.expected = new Map([[song.id, options.expected]]);
    }
    return bulkPut([song], checked).then(() => song);
  }

  function remove(id, options = {}) {
    return tx("readwrite", (store, abort) => {
      if (!Object.prototype.hasOwnProperty.call(options, "expected")) { store.delete(id); return; }
      const request = store.get(id);
      request.onsuccess = () => {
        if (snapshot(request.result) !== options.expected) { abort(conflict()); return; }
        try { store.delete(id); } catch (error) { abort(error); }
      };
    });
  }

  function bulkRemove(ids) {
    return tx("readwrite", store => { ids.forEach(id => store.delete(id)); return ids.length; });
  }

  function updateArtwork(original, artworkUrl) {
    return tx("readwrite", (store, abort) => {
      const change = {};
      const request = store.get(original.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.title !== original.title || current.artist !== original.artist ||
            (current.artworkUrl || "") !== (original.artworkUrl || "")) return;
        change.before = current;
        change.after = { ...current, artworkUrl, updatedAt: Date.now() };
        try { store.put(change.after); } catch (error) { abort(error); }
      };
      return change;
    }).then(change => change.after ? change : null);
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  return { getAll, put, bulkPut, remove, bulkRemove, updateArtwork, newId, snapshot };
})();
