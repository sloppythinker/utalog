(() => {
  const $ = (id) => document.getElementById(id);
  const { LIMITS, validateIncomingSongs, validateBackupSetlists, readStreamLimited } = UtaLogData;
  const BACKUP_VERSION = 2;
  const LIST_PAGE_SIZE = 100;
  const HISTORY_DISPLAY_LIMIT = 300;
  const DIAG_KEY = "utalog-diagnostics";
  const STORAGE_KEYS = {
    setlists: "utalog-setlists",
    oldSetlist: "utalog-setlist",
    lastBackup: "utalog-last-backup",
  };

  // ---------- 状態 ----------
  let songs = [];
  let searchQuery = "";
  let activeTags = new Set();
  let filterPracticing = false;
  let sortMode = "new";
  let setlists = [];          // [{id, name, createdAt, items:[{id, done}]}]
  let currentSetlistId = null;
  let pickerSongId = null;
  let receivedSongs = null;
  let listDisplayLimit = LIST_PAGE_SIZE;
  let searchRenderTimer = null;
  let titleSuggestController = null;
  let artistSuggestController = null;

  // 編集モーダルの状態
  let editingId = null;   // null = 新規
  let editKey = 0;
  let editRating = 0;
  let editPracticing = false;
  let editTags = new Set();
  let editArtworkUrl = "";
  let editScores = [];
  let editSungDates = [];
  let scoreSungDates = new Map();
  let editInitialSnapshot = "";
  let isSavingEdit = false;
  let suggestTimer = null;
  let artistSuggestTimer = null;

  function diagnostic(type, detail = "") {
    try {
      const current = JSON.parse(localStorage.getItem(DIAG_KEY) || "[]");
      current.push({ at: Date.now(), type, detail: String(detail).slice(0, 160) });
      localStorage.setItem(DIAG_KEY, JSON.stringify(current.slice(-50)));
    } catch (_) { /* 診断ログで本処理を止めない */ }
  }

  // ---------- ユーティリティ ----------
  function keyLabel(k) {
    if (!k) return "原曲";
    return k > 0 ? `+${k}` : `${k}`;
  }

  function norm(s) {
    return (s || "").toLowerCase().replace(/[ぁ-ゖ]/g,
      ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
  }

  // 検索・重複判定・サジェスト共通の正規化（NFKC→小文字→かな統一→空白除去）
  function normSearch(s) {
    return norm((s || "").normalize("NFKC")).replace(/[\s　]/g, "");
  }

  function bestScore(song) {
    if (!song.scores || song.scores.length === 0) return null;
    return Math.max(...song.scores.map(x => x.score));
  }

  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  function allTags() {
    const counts = new Map();
    songs.forEach(s => (s.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  }

  // 属性値(src="...")にも使うため、引用符まで含めてエスケープする
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, ch => ESC_MAP[ch]);
  }

  // アートワーク読込失敗時は音符プレースホルダーへ差し替える（errorはバブルしないためcapture）
  const ART_CLASSES = ["song-art", "history-art", "roulette-art", "suggest-art"];
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG") return;
    const cls = ART_CLASSES.find(c => img.classList.contains(c));
    if (!cls) return;
    const ph = document.createElement("div");
    ph.className = `${cls} placeholder`;
    ph.textContent = "🎵";
    img.replaceWith(ph);
  }, true);

  let toastTimer = null;
  function toast(msg, actionLabel, action) {
    const el = $("toast");
    el.replaceChildren(document.createTextNode(msg));
    if (actionLabel && action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = actionLabel;
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await action();
        } catch (e) {
          reportError("操作の取り消し", e);
        }
      };
      el.appendChild(btn);
    }
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), action ? 5000 : 2600);
  }

  function reportError(action, error) {
    console.error(`[うたログ] ${action}`, error);
    diagnostic("error", `${action}:${error && error.name ? error.name : "Error"}`);
    const detail = error && error.name === "QuotaExceededError"
      ? "端末の空き容量を確認してください"
      : error && error.message ? error.message : "もう一度お試しください";
    toast(`${action}に失敗しました: ${detail}`);
  }

  // ---------- 歌唱記録（sungDates = 歌った日時の配列） ----------
  function sungCountOf(song) { return (song.sungDates || []).length; }
  function lastSungOf(song) {
    const d = song.sungDates || [];
    return d.length ? Math.max(...d) : 0;
  }

  function historyEntryCount(excludeId = null) {
    return songs.reduce((total, song) => song.id === excludeId
      ? total
      : total + (song.scores || []).length + (song.sungDates || []).length, 0);
  }

  function syncSungFields(song) {
    song.sungCount = sungCountOf(song);
    song.lastSungAt = lastSungOf(song);
  }

  async function recordSung(song, timestamp = Date.now()) {
    if ((song.sungDates || []).length >= LIMITS.sungDates) {
      throw new Error("歌唱履歴が上限に達しています。バックアップ後に古い履歴を整理してください");
    }
    if (historyEntryCount() >= LIMITS.totalHistoryEntries) {
      throw new Error("履歴の合計件数が上限に達しています。バックアップ後に古い履歴を整理してください");
    }
    const next = { ...song, sungDates: [...(song.sungDates || []), timestamp], updatedAt: Date.now() };
    syncSungFields(next);
    await DB.put(next);
    Object.assign(song, next);
    return timestamp;
  }

  async function unrecordSung(song, timestamp) {
    const dates = [...(song.sungDates || [])];
    const index = Number.isFinite(timestamp) ? dates.lastIndexOf(timestamp) : -1;
    if (index < 0) return false;
    dates.splice(index, 1);
    const next = { ...song, sungDates: dates, updatedAt: Date.now() };
    syncSungFields(next);
    await DB.put(next);
    Object.assign(song, next);
    return true;
  }

  // ---------- 複数セットリスト（localStorage） ----------
  function defaultListName() {
    const base = `${fmtDate(Date.now())}のリスト`;
    if (!setlists.some(l => l.name === base)) return base;
    let n = 2;
    while (setlists.some(l => l.name === `${base}(${n})`)) n++;
    return `${base}(${n})`;
  }

  function normalizeStoredSetlists(value) {
    if (!Array.isArray(value)) throw new Error("セットリストの形式が不正です");
    if (value.length > LIMITS.setlists) throw new Error("セットリスト数が上限を超えています");
    let totalItems = 0;
    return value.map((list, listIndex) => {
      if (!list || typeof list !== "object" || Array.isArray(list)) {
        throw new Error(`セットリスト${listIndex + 1}の形式が不正です`);
      }
      const name = typeof list.name === "string" ? list.name.trim() : "";
      if (!name || name.length > 10000) {
        throw new Error(`セットリスト${listIndex + 1}の名前が不正です`);
      }
      if (!Array.isArray(list.items) || list.items.length > LIMITS.setlistItems) {
        throw new Error(`「${name}」の曲数が上限を超えています`);
      }
      totalItems += list.items.length;
      if (totalItems > LIMITS.totalSetlistItems) throw new Error("セットリストの合計曲数が上限を超えています");
      const items = list.items.map((item, itemIndex) => {
        if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) {
          throw new Error(`「${name}」の${itemIndex + 1}曲目が不正です`);
        }
        const normalized = { id: item.id, done: !!item.done };
        if (Number.isFinite(item.sungAt) && item.sungAt > 0) normalized.sungAt = item.sungAt;
        return normalized;
      });
      return {
        id: typeof list.id === "string" && list.id ? list.id : DB.newId(),
        name,
        createdAt: Number.isFinite(list.createdAt) && list.createdAt > 0 ? list.createdAt : Date.now(),
        items,
      };
    });
  }

  function loadSetlists() {
    let currentRaw = null;
    try {
      currentRaw = localStorage.getItem(STORAGE_KEYS.setlists);
      setlists = normalizeStoredSetlists(JSON.parse(currentRaw || "[]"));
    } catch (e) {
      setlists = [];
      if (currentRaw) {
        try { localStorage.setItem(`${STORAGE_KEYS.setlists}-recovery-${Date.now()}`, currentRaw); } catch (_) { /* 退避不能 */ }
      }
      reportError("セットリストの読み込み", e);
    }
    // 旧形式（単一リスト）からの移行
    let old = null;
    try { old = localStorage.getItem(STORAGE_KEYS.oldSetlist); } catch (e) { reportError("旧セットリストの読み込み", e); }
    if (old !== null) {
      try {
        const items = JSON.parse(old);
        if (Array.isArray(items) && items.length) {
          const migrated = normalizeStoredSetlists([
            { id: DB.newId(), name: defaultListName(), createdAt: Date.now(), items },
          ])[0];
          setlists.push(migrated);
        }
        if (saveSetlists()) localStorage.removeItem(STORAGE_KEYS.oldSetlist);
      } catch (e) {
        reportError("旧セットリストの移行", e);
      }
    }
  }

  function saveSetlists() {
    try {
      localStorage.setItem(STORAGE_KEYS.setlists, JSON.stringify(setlists));
      renderSetlistBadge();
      return true;
    } catch (e) {
      reportError("セットリストの保存", e);
      return false;
    }
  }

  function canAddSetlistItems(count) {
    const total = setlists.reduce((sum, list) => sum + list.items.length, 0);
    if (total + count <= LIMITS.totalSetlistItems) return true;
    toast(`セットリスト全体で登録できるのは${LIMITS.totalSetlistItems}曲までです`);
    return false;
  }

  function createSetlist(name) {
    if (setlists.length >= LIMITS.setlists) {
      toast(`セットリストは${LIMITS.setlists}件までです`);
      return null;
    }
    const listName = (name || defaultListName()).trim();
    if (!listName || listName.length > LIMITS.setlistName) {
      toast(`セットリスト名は${LIMITS.setlistName}文字以内にしてください`);
      return null;
    }
    const list = { id: DB.newId(), name: listName, createdAt: Date.now(), items: [] };
    setlists.unshift(list);
    if (!saveSetlists()) {
      setlists.shift();
      return null;
    }
    return list;
  }

  function currentSetlist() {
    return setlists.find(l => l.id === currentSetlistId) || null;
  }

  function renderSetlistBadge() {
    const badge = $("setlistBadge");
    const remain = setlists.reduce((n, l) => n + l.items.filter(x => !x.done).length, 0);
    badge.textContent = remain;
    badge.classList.toggle("hidden", remain === 0);
  }

  function cleanSetlists() {
    let changed = false;
    const songIds = new Set(songs.map(s => s.id));
    setlists.forEach(l => {
      const before = l.items.length;
      l.items = l.items.filter(x => songIds.has(x.id));
      if (l.items.length !== before) changed = true;
    });
    if (changed) saveSetlists();
  }

  // ---------- セットリスト一覧（YouTube再生リスト風） ----------
  function renderPlList() {
    cleanSetlists();
    const box = $("plList");
    box.innerHTML = "";
    $("plEmpty").classList.toggle("hidden", setlists.length > 0);

    setlists.forEach(list => {
      const total = list.items.length;
      const done = list.items.filter(x => x.done).length;
      const row = document.createElement("div");
      row.className = "pl-row";
      row.innerHTML = `
        <div class="pl-meta">
          <div class="pl-name">${esc(list.name)}</div>
          <div class="pl-sub">${fmtDate(list.createdAt)}作成・${done}/${total}曲 歌った</div>
          <div class="pl-progress"><div class="pl-progress-bar" style="width:${total ? Math.round(done / total * 100) : 0}%"></div></div>
        </div>
        <span class="pl-chevron">›</span>`;
      row.onclick = () => openSetlistDetail(list.id);
      box.appendChild(row);
    });
  }

  // ---------- セットリスト詳細 ----------
  function openSetlistDetail(id) {
    currentSetlistId = id;
    $("plListView").classList.add("hidden");
    $("plDetailView").classList.remove("hidden");
    renderSetlistDetail();
  }

  function closeSetlistDetail() {
    currentSetlistId = null;
    $("plDetailView").classList.add("hidden");
    $("plListView").classList.remove("hidden");
    renderPlList();
  }

  function renderSetlistDetail() {
    const list = currentSetlist();
    if (!list) { closeSetlistDetail(); return; }
    $("plName").textContent = list.name;
    const done = list.items.filter(x => x.done).length;
    $("plSub").textContent = `${done}/${list.items.length}曲 歌った`;

    const box = $("setlistList");
    const songsById = new Map(songs.map(song => [song.id, song]));
    box.innerHTML = "";
    $("setlistEmpty").classList.toggle("hidden", list.items.length > 0);

    list.items.forEach((item, idx) => {
      const song = songsById.get(item.id);
      if (!song) return;
      const row = document.createElement("div");
      row.className = "sl-item" + (item.done ? " done" : "");
      row.innerHTML = `
        <button class="sl-check ${item.done ? "on" : ""}" aria-label="歌った">${item.done ? "✓" : ""}</button>
        <div class="sl-info">
          <div class="song-title">${idx + 1}. ${esc(song.title)}</div>
          <div class="song-artist">${esc(song.artist) || "&nbsp;"} <span class="key-badge">キー ${keyLabel(song.key)}</span></div>
        </div>
        <div class="sl-btns">
          <button class="sl-move" data-dir="-1" aria-label="上へ">↑</button>
          <button class="sl-move" data-dir="1" aria-label="下へ">↓</button>
          <button class="sl-remove" aria-label="外す">✕</button>
        </div>`;
      const toggleDone = async () => {
        const wasDone = item.done;
        const previousSungAt = item.sungAt;
        try {
          if (!wasDone) {
            const sungAt = await recordSung(song);
            item.done = true;
            item.sungAt = sungAt;
            if (!saveSetlists()) {
              await unrecordSung(song, sungAt);
              item.done = false;
              delete item.sungAt;
              return;
            }
            toast(`「${song.title}」歌った！🎤`);
          } else {
            // 旧データには対応時刻がないため、無関係な履歴を消さず完了状態だけ戻す。
            const removed = Number.isFinite(previousSungAt)
              ? await unrecordSung(song, previousSungAt)
              : false;
            item.done = false;
            delete item.sungAt;
            if (!saveSetlists()) {
              if (removed) await recordSung(song, previousSungAt);
              item.done = true;
              if (Number.isFinite(previousSungAt)) item.sungAt = previousSungAt;
              return;
            }
            toast(removed ? "歌唱記録を取り消しました" : "完了を戻しました（過去の歌唱履歴は残しました）");
          }
          renderSetlistDetail();
        } catch (e) {
          item.done = wasDone;
          if (Number.isFinite(previousSungAt)) item.sungAt = previousSungAt;
          else delete item.sungAt;
          reportError("歌唱記録の更新", e);
        }
      };
      row.querySelector(".sl-check").onclick = toggleDone;
      row.querySelectorAll(".sl-move").forEach(b => {
        b.onclick = () => {
          const dir = Number(b.dataset.dir);
          const j = idx + dir;
          if (j < 0 || j >= list.items.length) return;
          [list.items[idx], list.items[j]] = [list.items[j], list.items[idx]];
          if (!saveSetlists()) {
            [list.items[idx], list.items[j]] = [list.items[j], list.items[idx]];
            return;
          }
          renderSetlistDetail();
        };
      });
      row.querySelector(".sl-remove").onclick = () => {
        const removed = list.items.splice(idx, 1)[0];
        if (!saveSetlists()) {
          list.items.splice(idx, 0, removed);
          return;
        }
        renderSetlistDetail();
      };
      row.querySelector(".sl-info").onclick = toggleDone;
      box.appendChild(row);
    });
  }

  // ---------- ピッカー（曲をどのリストに入れるか） ----------
  function openPicker(songId) {
    pickerSongId = songId;
    renderPicker();
    $("pickerModal").classList.remove("hidden");
  }

  function renderPicker() {
    const box = $("pickerList");
    box.innerHTML = "";
    if (setlists.length === 0) {
      box.innerHTML = `<p class="hint">セットリストはまだありません。下のボタンで作成できます。</p>`;
      return;
    }
    setlists.forEach(list => {
      const member = list.items.some(x => x.id === pickerSongId);
      const row = document.createElement("button");
      row.className = "picker-row" + (member ? " on" : "");
      row.innerHTML = `
        <span class="picker-check">${member ? "✓" : ""}</span>
        <span class="picker-name">${esc(list.name)}</span>
        <span class="picker-count">${list.items.length}曲</span>`;
      row.onclick = () => {
        if (member) {
          const previousItems = list.items;
          list.items = list.items.filter(x => x.id !== pickerSongId);
          if (!saveSetlists()) { list.items = previousItems; return; }
          toast(`「${list.name}」から外しました`);
        } else {
          if (list.items.length >= LIMITS.setlistItems) {
            toast(`1つのセットリストは${LIMITS.setlistItems}曲までです`);
            return;
          }
          if (!canAddSetlistItems(1)) return;
          list.items.push({ id: pickerSongId, done: false });
          if (!saveSetlists()) { list.items.pop(); return; }
          toast(`「${list.name}」に追加しました`);
        }
        renderPicker();
        renderList();
      };
      box.appendChild(row);
    });
  }

  // ---------- タブ ----------
  function switchTab(tab) {
    const views = { list: "listView", setlist: "setlistView", history: "historyView" };
    const tabs = { list: "tabList", setlist: "tabSetlist", history: "tabHistory" };
    Object.keys(views).forEach(k => {
      $(views[k]).classList.toggle("hidden", k !== tab);
      $(tabs[k]).classList.toggle("active", k === tab);
    });
    if (tab === "setlist") {
      if (currentSetlistId && currentSetlist()) renderSetlistDetail();
      else { currentSetlistId = null; $("plDetailView").classList.add("hidden"); $("plListView").classList.remove("hidden"); renderPlList(); }
    }
    if (tab === "history") renderHistory();
  }

  // ---------- 歌った履歴 ----------
  function renderHistory() {
    const startedAt = performance.now();
    const box = $("historyList");
    box.innerHTML = "";
    const byDay = new Map(); // 日付0時のts → Map(songId → 回数)
    const events = [];
    songs.forEach(s => (s.sungDates || []).forEach(ts => events.push({ ts, id: s.id })));
    events.sort((a, b) => b.ts - a.ts);
    const visibleEvents = events.slice(0, HISTORY_DISPLAY_LIMIT);
    visibleEvents.forEach(({ ts, id }) => {
      const d = new Date(ts);
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (!byDay.has(key)) byDay.set(key, new Map());
      const m = byDay.get(key);
      m.set(id, (m.get(id) || 0) + 1);
    });
    const days = [...byDay.keys()].sort((a, b) => b - a);
    const songsById = new Map(songs.map(song => [song.id, song]));
    $("historyEmpty").classList.toggle("hidden", days.length > 0);
    const youbi = ["日", "月", "火", "水", "木", "金", "土"];
    days.forEach(day => {
      const m = byDay.get(day);
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const head = document.createElement("div");
      head.className = "history-date";
      head.innerHTML = `
        <span>${fmtDate(day)}（${youbi[new Date(day).getDay()]}）・${total}曲</span>
        <button class="history-replay">📋 セットに</button>`;
      head.querySelector(".history-replay").onclick = () => {
        const defName = `${fmtDate(day)}の再演リスト`;
        const name = prompt("セットリスト名", defName);
        if (name === null) return;
        const replayItems = [...m.keys()].filter(id => songsById.has(id)).map(id => ({ id, done: false }));
        if (!canAddSetlistItems(replayItems.length)) return;
        const list = createSetlist(name.trim() || defName);
        if (!list) return;
        list.items = replayItems;
        if (!saveSetlists()) { list.items = []; return; }
        toast(`「${list.name}」を作成しました（${list.items.length}曲）`);
      };
      box.appendChild(head);
      m.forEach((count, id) => {
        const song = songsById.get(id);
        if (!song) return;
        const row = document.createElement("div");
        row.className = "history-row";
        const art = song.artworkUrl
          ? `<img class="history-art" src="${esc(song.artworkUrl)}" alt="" loading="lazy">`
          : `<div class="history-art placeholder">🎵</div>`;
        row.innerHTML = `
          ${art}
          <div class="history-info">
            <div class="song-title">${esc(song.title)}${count > 1 ? ` <span class="history-count">×${count}</span>` : ""}</div>
            <div class="song-artist">${esc(song.artist) || "&nbsp;"}</div>
          </div>
          <span class="key-badge">キー ${keyLabel(song.key)}</span>`;
        row.onclick = () => openEdit(song.id);
        box.appendChild(row);
      });
    });
    if (events.length > visibleEvents.length) {
      const note = document.createElement("p");
      note.className = "hint history-limit-note";
      note.textContent = `表示を直近${HISTORY_DISPLAY_LIMIT}件に限定しています（全${events.length}件）`;
      box.appendChild(note);
    }
    const elapsed = Math.round(performance.now() - startedAt);
    if (elapsed >= 32) diagnostic("render-history", `${elapsed}ms/${visibleEvents.length}`);
  }

  // ---------- リスト描画 ----------
  function filteredSongs() {
    const q = normSearch(searchQuery);
    let list = songs.filter(s => {
      if (q && !normSearch(s.title).includes(q) && !normSearch(s.artist).includes(q)) return false;
      if (filterPracticing && !s.practicing) return false;
      for (const t of activeTags) if (!(s.tags || []).includes(t)) return false;
      return true;
    });
    const cmp = {
      new: (a, b) => b.createdAt - a.createdAt,
      old: (a, b) => a.createdAt - b.createdAt,
      title: (a, b) => a.title.localeCompare(b.title, "ja"),
      artist: (a, b) => (a.artist || "").localeCompare(b.artist || "", "ja"),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || b.createdAt - a.createdAt,
      score: (a, b) => (bestScore(b) ?? -1) - (bestScore(a) ?? -1),
      gobusata: (a, b) => lastSungOf(a) - lastSungOf(b),
    }[sortMode];
    return list.sort(cmp);
  }

  function renderTagFilter() {
    const box = $("tagFilter");
    box.innerHTML = "";
    if (songs.some(s => s.practicing)) {
      const pbtn = document.createElement("button");
      pbtn.className = "tag-chip practice-chip" + (filterPracticing ? " active" : "");
      pbtn.textContent = "📖覚え中";
      pbtn.onclick = () => { filterPracticing = !filterPracticing; render(); };
      box.appendChild(pbtn);
    }
    allTags().forEach(tag => {
      const btn = document.createElement("button");
      btn.className = "tag-chip" + (activeTags.has(tag) ? " active" : "");
      btn.textContent = tag;
      btn.onclick = () => {
        activeTags.has(tag) ? activeTags.delete(tag) : activeTags.add(tag);
        render();
      };
      box.appendChild(btn);
    });
  }

  const KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "英", "他"];

  function kanaRowOf(s) {
    const ch = norm((s || "").normalize("NFKC")).trim().charAt(0);
    if (!ch) return "他";
    if (/[a-z0-9]/.test(ch)) return "英";
    const c = ch.charCodeAt(0);
    if (c === 0x30f4) return "あ"; // ヴ
    if (c === 0x30f5 || c === 0x30f6) return "か"; // ヵヶ
    const ranges = [
      ["あ", 0x30a1, 0x30aa], ["か", 0x30ab, 0x30b4], ["さ", 0x30b5, 0x30be],
      ["た", 0x30bf, 0x30c9], ["な", 0x30ca, 0x30ce], ["は", 0x30cf, 0x30dd],
      ["ま", 0x30de, 0x30e2], ["や", 0x30e3, 0x30e8], ["ら", 0x30e9, 0x30ed],
      ["わ", 0x30ee, 0x30f3],
    ];
    for (const [row, lo, hi] of ranges) if (c >= lo && c <= hi) return row;
    return "他";
  }

  function updateKanaJump(list) {
    const bar = $("kanaJump");
    const active = (sortMode === "title" || sortMode === "artist") && list.length > 0;
    bar.classList.toggle("hidden", !active);
    if (!active) { bar.innerHTML = ""; return; }
    const present = new Set(list.map(s => kanaRowOf(sortMode === "artist" ? s.artist : s.title)));
    bar.innerHTML = "";
    KANA_ROWS.forEach(row => {
      const b = document.createElement("button");
      b.textContent = row;
      b.disabled = !present.has(row);
      b.onclick = () => {
        const target = [...document.querySelectorAll("#songList .song-card")]
          .find(c => c.dataset.kana === row);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      bar.appendChild(b);
    });
  }

  function renderList() {
    const startedAt = performance.now();
    const allMatches = filteredSongs();
    const list = allMatches.slice(0, listDisplayLimit);
    const setlistSongIds = new Set(setlists.flatMap(setlist => setlist.items.map(item => item.id)));
    const box = $("songList");
    box.innerHTML = "";
    const empty = $("emptyState");
    updateKanaJump(list);
    if (list.length === 0) {
      empty.classList.remove("hidden");
      $("emptyMessage").innerHTML = songs.length === 0
        ? "まだ曲が登録されていません。<br>「＋」ボタンから持ち歌を追加しましょう！"
        : "条件に合う曲がありません。";
      return;
    }
    empty.classList.add("hidden");

    const fragment = document.createDocumentFragment();
    list.forEach(song => {
      const card = document.createElement("div");
      card.className = "song-card";
      card.dataset.kana = kanaRowOf(sortMode === "artist" ? song.artist : song.title);
      const art = song.artworkUrl
        ? `<img class="song-art" src="${esc(song.artworkUrl)}" alt="" loading="lazy">`
        : `<div class="song-art placeholder">🎵</div>`;
      const stars = song.rating ? `<span class="rating-badge">${"★".repeat(song.rating)}</span>` : "";
      const best = bestScore(song);
      const scoreB = best !== null ? `<span class="score-badge">🏆${best}</span>` : "";
      const memo = song.memo ? `<span class="memo-mark">📝</span>` : "";
      const prac = song.practicing ? `<span class="practicing-badge">📖覚え中</span>` : "";
      const tags = (song.tags || []).length
        ? `<div class="song-tags">${song.tags.map(t => `<span class="mini-tag">${esc(t)}</span>`).join("")}</div>`
        : "";
      card.innerHTML = `
        ${art}
        <div class="song-info">
          <div class="song-title-row"><span class="song-title">${esc(song.title)}</span></div>
          <div class="song-artist">${esc(song.artist) || "&nbsp;"}</div>
          <div class="song-meta">
            <span class="key-badge">キー ${keyLabel(song.key)}</span>
            ${stars}${scoreB}${memo}${prac}
          </div>
          ${tags}
        </div>
        <div class="song-quick-actions">
          <button class="sung-quick" aria-label="今日歌った">🎤</button>
          <button class="sl-quick ${setlistSongIds.has(song.id) ? "on" : ""}" aria-label="セットリストへ">📋</button>
        </div>`;
      card.onclick = () => openEdit(song.id);
      const q = card.querySelector(".sl-quick");
      q.onclick = (e) => {
        e.stopPropagation();
        openPicker(song.id);
      };
      const sung = card.querySelector(".sung-quick");
      sung.onclick = async (e) => {
        e.stopPropagation();
        sung.disabled = true;
        try {
          const sungAt = await recordSung(song);
          renderList();
          toast(`「${song.title}」を歌唱記録に追加しました`, "取り消す", async () => {
            const removed = await unrecordSung(song, sungAt);
            if (removed) {
              renderList();
              toast("歌唱記録を取り消しました");
            }
          });
        } catch (error) {
          reportError("歌唱記録の保存", error);
          sung.disabled = false;
        }
      };
      fragment.appendChild(card);
    });
    box.appendChild(fragment);
    if (allMatches.length > list.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "settings-btn list-more";
      more.textContent = `さらに表示（残り${allMatches.length - list.length}曲）`;
      more.onclick = () => { listDisplayLimit += LIST_PAGE_SIZE; renderList(); };
      box.appendChild(more);
    }
    const elapsed = Math.round(performance.now() - startedAt);
    if (elapsed >= 32) diagnostic("render-list", `${elapsed}ms/${list.length}`);
  }

  function render() {
    renderTagFilter();
    renderList();
    renderSetlistBadge();
  }

  // ---------- 曲追加・編集モーダル ----------
  function currentEditSnapshot() {
    return JSON.stringify({
      title: $("inputTitle").value,
      artist: $("inputArtist").value,
      memo: $("inputMemo").value,
      key: editKey,
      rating: editRating,
      practicing: editPracticing,
      tags: [...editTags].sort(),
      artworkUrl: editArtworkUrl,
      scores: editScores,
      sungDates: editSungDates,
    });
  }

  function openEdit(id) {
    editingId = id || null;
    const song = id ? songs.find(s => s.id === id) : null;
    $("editModalTitle").textContent = song ? "曲を編集" : "曲を追加";
    $("inputTitle").value = song ? song.title : "";
    $("inputArtist").value = song ? song.artist || "" : "";
    $("inputMemo").value = song ? song.memo || "" : "";
    $("inputScore").value = "";
    $("inputSungDate").value = localDateTime(Date.now());
    editKey = song ? song.key || 0 : 0;
    editRating = song ? song.rating || 0 : 0;
    editPracticing = song ? !!song.practicing : false;
    updatePracticingView();
    editTags = new Set(song ? song.tags || [] : []);
    editArtworkUrl = song ? song.artworkUrl || "" : "";
    editScores = song ? [...(song.scores || [])] : [];
    editSungDates = song ? [...(song.sungDates || [])] : [];
    scoreSungDates = new Map();
    $("scoreSungTarget").replaceChildren();
    $("btnDelete").classList.toggle("hidden", !song);
    $("btnEditToSetlist").classList.toggle("hidden", !song);
    hideSuggest();
    updateKeyView();
    updateRatingView();
    renderScoreSection();
    updateSungView();
    renderTagPicker();
    editInitialSnapshot = currentEditSnapshot();
    $("editModal").classList.remove("hidden");
    if (!song) setTimeout(() => $("inputTitle").focus(), 250);
  }

  function closeEdit(force = false) {
    if (!force && editInitialSnapshot && currentEditSnapshot() !== editInitialSnapshot) {
      if (!confirm("入力中の変更を破棄しますか？")) return false;
    }
    $("editModal").classList.add("hidden");
    hideSuggest();
    editInitialSnapshot = "";
    return true;
  }

  async function saveEdit() {
    if (isSavingEdit) return;
    const title = $("inputTitle").value.trim();
    if (!title) { toast("曲名を入力してください"); return; }
    isSavingEdit = true;
    $("editModal").inert = true;
    const saveButton = $("btnSaveEdit");
    saveButton.disabled = true;
    const originalLabel = saveButton.textContent;
    saveButton.textContent = "保存中…";
    try {
      const artistName = $("inputArtist").value.trim();
      const shouldFetchArtwork = !editArtworkUrl && !!artistName;
      const now = Date.now();
      const base = editingId ? songs.find(s => s.id === editingId) : null;
      const song = {
        id: editingId || DB.newId(),
        title,
        artist: $("inputArtist").value.trim(),
        artworkUrl: editArtworkUrl,
        tags: [...editTags],
        key: editKey,
        rating: editRating,
        practicing: editPracticing,
        memo: $("inputMemo").value.trim(),
        scores: editScores,
        sungDates: editSungDates,
        sungCount: editSungDates.length,
        lastSungAt: editSungDates.length ? Math.max(...editSungDates) : 0,
        createdAt: base ? base.createdAt : now,
        updatedAt: now,
      };
      validateIncomingSongs([song]);
      const nextHistoryCount = (song.scores || []).length + (song.sungDates || []).length;
      if (historyEntryCount(song.id) + nextHistoryCount > LIMITS.totalHistoryEntries) {
        throw new Error("履歴の合計件数が上限を超えています");
      }
      await DB.put(song);
      if (base) Object.assign(base, song); else songs.push(song);
      const wasEditing = !!editingId;
      closeEdit(true);
      render();
      toast(wasEditing ? "更新しました" : `「${title}」を追加しました`);
      editingId = null;
      // 画像は保存操作を待たせず、取得できた場合だけ後から追記する。
      if (shouldFetchArtwork) {
        ITunes.artistImage(artistName).then(async artworkUrl => {
          if (!artworkUrl) return;
          const current = songs.find(item => item.id === song.id);
          if (!current || current.artworkUrl || current.artist !== artistName) return;
          const updated = { ...current, artworkUrl, updatedAt: Date.now() };
          await DB.put(updated);
          Object.assign(current, updated);
          renderList();
        }).catch(error => diagnostic("artwork-failed", error && error.name));
      }
      return song;
    } catch (e) {
      reportError("曲の保存", e);
      return null;
    } finally {
      isSavingEdit = false;
      $("editModal").inert = false;
      saveButton.disabled = false;
      saveButton.textContent = originalLabel;
    }
  }

  async function deleteSong() {
    const song = songs.find(s => s.id === editingId);
    if (!song) return;
    if (!confirm(`「${song.title}」を削除しますか？`)) return;
    const previousSetlists = structuredClone(setlists);
    try {
      await DB.remove(song.id);
      songs = songs.filter(s => s.id !== song.id);
      setlists.forEach(l => { l.items = l.items.filter(x => x.id !== song.id); });
      if (!saveSetlists()) {
        await DB.put(song);
        songs.push(song);
        setlists = previousSetlists;
        render();
        throw new Error("セットリストを更新できなかったため削除を取り消しました");
      }
      closeEdit(true);
      render();
      toast("削除しました");
    } catch (e) {
      reportError("曲の削除", e);
    }
  }

  // キー ステッパー
  function updateKeyView() {
    $("keyValue").textContent = keyLabel(editKey);
  }

  // 覚え中トグル
  function updatePracticingView() {
    $("btnPracticing").classList.toggle("on", editPracticing);
  }

  // 得意度
  function updateRatingView() {
    $("ratingStars").querySelectorAll("button").forEach(b => {
      b.classList.toggle("on", Number(b.dataset.star) <= editRating);
    });
  }

  // 採点スコア
  function renderScoreSection() {
    const bestEl = $("bestScore");
    const best = editScores.length ? Math.max(...editScores.map(x => x.score)) : null;
    bestEl.classList.toggle("hidden", best === null);
    if (best !== null) {
      const ordered = [...editScores].reverse().sort((a, b) => b.date - a.date);
      const latest = ordered[0].score, previous = ordered[1]?.score;
      const delta = previous === undefined ? null : Math.round((latest - previous) * 10) / 10;
      bestEl.textContent = `自己ベスト ${best}点 ／ 直近 ${latest}点 ／ 前回 ${previous === undefined ? "なし" : previous + "点"}${delta === null ? "" : ` ／ 前回比 ${delta > 0 ? "+" : ""}${delta}点`}`;
    }
    renderSungTargets();
    renderScoreChart();
    const hist = $("scoreHistory");
    hist.innerHTML = "";
    [...editScores].reverse().sort((a, b) => b.date - a.date).forEach(entry => {
      const row = document.createElement("div");
      row.className = "score-row";
      row.innerHTML = `<span>${entry.score} 点</span><span class="score-date">${fmtDate(entry.date)}</span><button class="score-del" aria-label="削除">✕</button>`;
      row.querySelector(".score-del").onclick = () => {
        editScores = editScores.filter(x => x !== entry);
        const sungAt = scoreSungDates.get(entry);
        if (sungAt !== undefined) {
          const sungIndex = editSungDates.lastIndexOf(sungAt);
          if (sungIndex >= 0) editSungDates.splice(sungIndex, 1);
          scoreSungDates.delete(entry);
          updateSungView();
        }
        renderScoreSection();
      };
      const dateInput = document.createElement("input");
      dateInput.type = "datetime-local";
      dateInput.setAttribute("aria-label", "歌った日時を変更");
      dateInput.value = localDateTime(entry.date);
      dateInput.onchange = () => {
        const timestamp = new Date(dateInput.value).getTime();
        if (!Number.isFinite(timestamp) || timestamp <= 0) { dateInput.value = localDateTime(entry.date); return; }
        const index = editSungDates.indexOf(entry.date);
        if (index >= 0) editSungDates[index] = timestamp;
        const updated = { ...entry, date: timestamp };
        editScores = editScores.map(item => item === entry ? updated : item);
        renderScoreSection(); updateSungView();
      };
      row.appendChild(dateInput);
      hist.appendChild(row);
    });
  }

  // スコア推移の折れ線グラフ（2件以上で表示）
  function renderScoreChart() {
    const chart = $("scoreChart");
    if (editScores.length < 2) {
      chart.classList.add("hidden");
      chart.innerHTML = "";
      return;
    }
    const pts = [...editScores].sort((a, b) => a.date - b.date);
    const vals = pts.map(p => p.score);
    const lo = Math.max(0, Math.floor(Math.min(...vals)) - 1);
    const hi = Math.min(100, Math.ceil(Math.max(...vals)) + 1);
    const W = 320, H = 96, PL = 34, PR = 12, PT = 12, PB = 18;
    const x = (i) => PL + (W - PL - PR) * i / (pts.length - 1);
    const y = (v) => PT + (H - PT - PB) * (1 - (v - lo) / Math.max(0.1, hi - lo));
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="3.5"/>`).join("");
    const bestV = Math.max(...vals);
    const firstD = fmtDate(pts[0].date).slice(5);
    const lastD = fmtDate(pts[pts.length - 1].date).slice(5);
    chart.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="score-svg" role="img" aria-label="スコア推移">
        <line x1="${PL}" y1="${y(hi)}" x2="${W - PR}" y2="${y(hi)}" class="grid"/>
        <line x1="${PL}" y1="${y(lo)}" x2="${W - PR}" y2="${y(lo)}" class="grid"/>
        <text x="${PL - 4}" y="${y(hi) + 4}" class="axis" text-anchor="end">${hi}</text>
        <text x="${PL - 4}" y="${y(lo) + 4}" class="axis" text-anchor="end">${lo}</text>
        <text x="${PL}" y="${H - 4}" class="axis">${firstD}</text>
        <text x="${W - PR}" y="${H - 4}" class="axis" text-anchor="end">${lastD}</text>
        <polyline points="${line}" class="line"/>
        <g class="dots">${dots}</g>
      </svg>
      <div class="hint">スコア推移（${pts.length}回・ベスト${bestV}点）</div>`;
    chart.classList.remove("hidden");
  }

  function localDateTime(timestamp) {
    const date = new Date(timestamp);
    return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function renderSungTargets() {
    const select = $("scoreSungTarget");
    const old = select.value;
    select.replaceChildren(new Option("新しく歌った1回として追加", "new"));
    const used = new Map();
    editScores.forEach(entry => used.set(entry.date, (used.get(entry.date) || 0) + 1));
    const available = [];
    editSungDates.forEach((date, index) => {
      if (used.get(date)) { used.set(date, used.get(date) - 1); return; }
      available.push({date, index});
    });
    available.sort((a, b) => b.date - a.date).forEach(({date, index}) => {
      select.add(new Option(`${localDateTime(date).replace("T", " ")} の歌唱に採点を追加`, String(index)));
    });
    if ([...select.options].some(option => option.value === old)) select.value = old;
    else {
      const today = available.find(item => new Date(item.date).toDateString() === new Date().toDateString());
      select.value = today ? String(today.index) : "new";
    }
    $("inputSungDate").disabled = select.value !== "new";
    if (select.value !== "new") $("inputSungDate").value = localDateTime(editSungDates[Number(select.value)]);
  }

  async function addScore() {
    if (isSavingEdit) return;
    const raw = $("inputScore").value.trim();
    const v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < 0 || v > 100) { toast("0〜100の点数を入力してください"); return; }
    const linked = $("scoreSungTarget").value !== "new";
    const now = Date.now();
    const timestamp = linked ? editSungDates[Number($("scoreSungTarget").value)] : $("inputSungDate").value === localDateTime(now) ? now : new Date($("inputSungDate").value).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= 0) { toast("歌った日時を入力してください"); return; }
    if (editScores.length >= LIMITS.scores || (!linked && editSungDates.length >= LIMITS.sungDates)) { toast("履歴が上限に達しています"); return; }
    const previousScores = [...editScores], previousDates = [...editSungDates];
    const entry = { score: Math.round(v * 10) / 10, date: timestamp };
    editScores = [...editScores, entry];
    if (!linked) editSungDates = [...editSungDates, timestamp];
    const saved = await saveEdit();
    if (!saved) { editScores = previousScores; editSungDates = previousDates; return; }
    const today = new Date(timestamp).toDateString() === new Date().toDateString();
    toast(linked ? "歌唱記録に採点を保存しました" : today ? "今日うたったに追加しました" : "指定した日の歌唱履歴に追加しました", "取り消す", async () => {
      const current = songs.find(song => song.id === saved.id);
      if (!current || !current.scores.includes(entry)) return;
      const dates = [...current.sungDates];
      if (!linked) { const index = dates.lastIndexOf(timestamp); if (index >= 0) dates.splice(index, 1); }
      const next = { ...current, scores: current.scores.filter(score => score !== entry), sungDates: dates, updatedAt: Date.now() };
      syncSungFields(next);
      await DB.put(next);
      Object.assign(current, next);
      if (editingId === next.id) openEdit(next.id);
      render();
      toast("採点の保存を取り消しました");
    });
  }

  // 歌唱記録
  function updateSungView() {
    $("sungInfo").textContent = editSungDates.length
      ? `${editSungDates.length}回（最終: ${fmtDate(Math.max(...editSungDates))}）`
      : "まだ記録なし";
    $("btnSungUndo").disabled = editSungDates.length === 0;
    const datesBox = $("unscoredDates");
    datesBox.replaceChildren();
    const used = new Map();
    editScores.forEach(entry => used.set(entry.date, (used.get(entry.date) || 0) + 1));
    editSungDates.forEach((date, index) => {
      if (used.get(date)) { used.set(date, used.get(date) - 1); return; }
      const label = document.createElement("label");
      label.textContent = "未採点の歌唱日時";
      const input = document.createElement("input");
      input.type = "datetime-local";
      input.value = localDateTime(date);
      input.onchange = () => {
        const timestamp = new Date(input.value).getTime();
        if (!Number.isFinite(timestamp) || timestamp <= 0) { input.value = localDateTime(date); return; }
        editSungDates[index] = timestamp;
        renderSungTargets(); updateSungView();
      };
      label.appendChild(input); datesBox.appendChild(label);
    });
  }

  // タグピッカー
  function renderTagPicker() {
    const box = $("tagPicker");
    box.innerHTML = "";
    const tags = [...new Set([...allTags(), ...editTags])];
    if (tags.length === 0) {
      box.innerHTML = `<span class="hint">下の欄からタグを作成できます（例: バラード、盛り上げ、十八番）</span>`;
      return;
    }
    tags.forEach(tag => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip" + (editTags.has(tag) ? " active" : "");
      btn.textContent = tag;
      btn.onclick = () => {
        editTags.has(tag) ? editTags.delete(tag) : editTags.add(tag);
        renderTagPicker();
      };
      box.appendChild(btn);
    });
  }

  function addNewTag() {
    const input = $("inputNewTag");
    const tag = input.value.trim();
    if (!tag) return;
    if (tag.length > LIMITS.tag) { toast(`タグは${LIMITS.tag}文字以内にしてください`); return; }
    if (!editTags.has(tag) && editTags.size >= LIMITS.tags) { toast(`タグは1曲${LIMITS.tags}個までです`); return; }
    editTags.add(tag);
    input.value = "";
    renderTagPicker();
  }

  // ---------- 曲名・歌手名サジェスト ----------
  function dismissSuggest(id) {
    if (id === "suggestBox") {
      clearTimeout(suggestTimer);
      if (titleSuggestController) titleSuggestController.abort();
    } else {
      clearTimeout(artistSuggestTimer);
      if (artistSuggestController) artistSuggestController.abort();
    }
    $(id).classList.add("hidden");
    $(id).innerHTML = "";
    $(id).setAttribute("aria-busy", "false");
  }

  function hideSuggest() {
    ["suggestBox", "suggestBoxArtist"].forEach(dismissSuggest);
  }

  function suggestStatus(box, message, retry) {
    const note = document.createElement("div");
    note.className = "suggest-note";
    note.textContent = message;
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "再検索";
      button.onclick = retry;
      note.append(" ", button);
    }
    box.replaceChildren(note);
    box.classList.remove("hidden");
  }

  // 矢印つきサジェストボックスを構築
  function buildSuggestBox(box, rows, note) {
    box.innerHTML = "";
    const arrows = document.createElement("div");
    arrows.className = "suggest-arrows";
    const list = document.createElement("div");
    list.className = "suggest-list";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.className = "suggest-close";
    close.setAttribute("aria-label", "候補を閉じる");
    close.onclick = () => dismissSuggest(box.id);
    arrows.appendChild(close);
    [["▲", -1], ["▼", 1]].forEach(([label, dir]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = () => list.scrollBy({ top: dir * 130, behavior: "smooth" });
      arrows.appendChild(b);
    });
    rows.forEach(row => list.appendChild(row));
    const noteEl = document.createElement("div");
    noteEl.className = "suggest-note";
    noteEl.textContent = note;
    list.appendChild(noteEl);
    box.appendChild(arrows);
    box.appendChild(list);
    box.classList.remove("hidden");
  }

  async function showSuggest(term) {
    const box = $("suggestBox");
    if (titleSuggestController) titleSuggestController.abort();
    titleSuggestController = new AbortController();
    const options = { signal: titleSuggestController.signal };
    const isCurrent = () => !options.signal.aborted && $("inputTitle").value.trim() === term &&
      !$("editModal").classList.contains("hidden");
    if (navigator.onLine === false) {
      suggestStatus(box, "オフラインのため候補検索を利用できません（手入力は可能です）", () => showSuggest(term));
      return;
    }
    suggestStatus(box, "曲名の候補を検索中…");
    box.setAttribute("aria-busy", "true");
    // 歌手名が入力済みなら「歌手名+曲名」でも検索し、その歌手の曲を優先
    const artistTerm = $("inputArtist").value.trim();
    let results;
    try {
      if (artistTerm) {
        const searches = await Promise.allSettled([
          ITunes.search(artistTerm + " " + term, 8, options),
          ITunes.search(term, 8, options),
        ]);
        const successful = searches.filter(result => result.status === "fulfilled");
        if (!successful.length) throw searches[0].reason;
        results = successful.flatMap(result => result.value);
      } else {
        results = await ITunes.search(term, 8, options);
      }
    } catch (error) {
      if (isCurrent()) {
        diagnostic("suggest-failed", error && error.name);
        suggestStatus(box, "候補を取得できませんでした。手入力するか再検索してください。", () => showSuggest(term));
      }
      return;
    } finally {
      if (isCurrent()) box.setAttribute("aria-busy", "false");
    }
    if (!isCurrent()) return;
    // 曲名一致を優先。表記揺れや「歌手名 曲名」の入力でもAPIの候補を捨てない。
    const nt = normSearch(term);
    const matched = results.filter(r => normSearch(r.title).includes(nt));
    if (matched.length) results = matched;
    const na = normSearch(artistTerm);
    if (na) {
      results.sort((a, b) =>
        Number(normSearch(b.artist).includes(na)) - Number(normSearch(a.artist).includes(na)));
    }
    // 同じ曲名+歌手名の重複を除去
    const seen = new Set();
    results = results.filter(r => {
      const k = normSearch(r.title) + "\n" + normSearch(r.artist);
      return seen.has(k) ? false : (seen.add(k), true);
    }).slice(0, 8);
    if (results.length === 0) {
      suggestStatus(box, "候補が見つかりませんでした。曲名を変えるか、そのまま手入力してください。");
      return;
    }
    const rows = results.map(r => {
      const item = document.createElement("div");
      item.className = "suggest-item";
      item.innerHTML = `
        <img class="suggest-art" src="${esc(r.artworkUrl)}" alt="" loading="lazy">
        <div class="suggest-text">
          <div class="suggest-title">${esc(r.title)}</div>
          <div class="suggest-artist">${esc(r.artist)}</div>
        </div>`;
      item.onclick = () => {
        $("inputTitle").value = r.title;
        $("inputArtist").value = r.artist;
        editArtworkUrl = r.artworkUrl;
        hideSuggest();
      };
      return item;
    });
    buildSuggestBox(box, rows, matched.length ? "曲名の候補（そのまま手入力もOK）" : "入力に関連する候補（曲名・歌手名を確認してください）");
  }

  async function showArtistSuggest(term) {
    const box = $("suggestBoxArtist");
    if (artistSuggestController) artistSuggestController.abort();
    artistSuggestController = new AbortController();
    const signal = artistSuggestController.signal;
    const isCurrent = () => !signal.aborted && $("inputArtist").value.trim() === term &&
      !$("editModal").classList.contains("hidden");
    if (navigator.onLine === false) {
      suggestStatus(box, "オフラインのため候補検索を利用できません（手入力は可能です）", () => showArtistSuggest(term));
      return;
    }
    suggestStatus(box, "歌手名の候補を検索中…");
    box.setAttribute("aria-busy", "true");
    let results;
    try {
      results = await ITunes.searchArtists(term, 6, { signal });
    } catch (error) {
      if (isCurrent()) {
        diagnostic("artist-suggest-failed", error && error.name);
        suggestStatus(box, "候補を取得できませんでした。手入力するか再検索してください。", () => showArtistSuggest(term));
      }
      return;
    } finally {
      if (isCurrent()) box.setAttribute("aria-busy", "false");
    }
    if (!isCurrent()) return;
    // 歌手名にマッチするものを優先（マッチゼロなら上位候補をそのまま表示）
    const nt = normSearch(term);
    const matched = results.filter(a => normSearch(a.name).includes(nt));
    if (matched.length) results = matched;
    results = results.slice(0, 6);
    if (results.length === 0) {
      suggestStatus(box, "候補が見つかりませんでした。歌手名を変えるか、そのまま手入力してください。");
      return;
    }
    const rows = results.map(a => {
      const item = document.createElement("div");
      item.className = "suggest-item";
      item.innerHTML = `
        <img class="suggest-art" src="${esc(a.artworkUrl)}" alt="" loading="lazy">
        <div class="suggest-text">
          <div class="suggest-title">${esc(a.name)}</div>
        </div>`;
      item.onclick = () => {
        $("inputArtist").value = a.name;
        if (!editArtworkUrl && a.artworkUrl) editArtworkUrl = a.artworkUrl;
        hideSuggest();
      };
      return item;
    });
    buildSuggestBox(box, rows, "歌手名の候補");
  }

  // ---------- 統計 ----------
  function renderStats() {
    const body = $("statsBody");
    const sungTotal = songs.reduce((n, s) => n + sungCountOf(s), 0);
    const practicing = songs.filter(s => s.practicing).length;

    // よく歌う曲 TOP5
    const topSongs = [...songs].filter(s => sungCountOf(s) > 0)
      .sort((a, b) => sungCountOf(b) - sungCountOf(a)).slice(0, 5);
    const maxSung = topSongs.length ? sungCountOf(topSongs[0]) : 1;

    // 月別歌唱回数（直近6ヶ月）
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ y: d.getFullYear(), m: d.getMonth(), label: `${d.getMonth() + 1}月`, count: 0 });
    }
    songs.forEach(s => (s.sungDates || []).forEach(ts => {
      const d = new Date(ts);
      const slot = months.find(x => x.y === d.getFullYear() && x.m === d.getMonth());
      if (slot) slot.count++;
    }));
    const maxMonth = Math.max(1, ...months.map(x => x.count));

    // ベストスコア TOP3
    const topScores = [...songs].filter(s => bestScore(s) !== null)
      .sort((a, b) => bestScore(b) - bestScore(a)).slice(0, 3);

    // タグ分布 TOP6
    const tagCounts = new Map();
    songs.forEach(s => (s.tags || []).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    const bar = (label, count, max, suffix) => `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${esc(label)}</span>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.max(3, Math.round(count / max * 100))}%"></div></div>
        <span class="stat-bar-count">${count}${suffix}</span>
      </div>`;

    body.innerHTML = `
      <div class="stat-summary">
        <div class="stat-cell"><strong>${songs.length}</strong><span>曲</span></div>
        <div class="stat-cell"><strong>${sungTotal}</strong><span>累計歌唱</span></div>
        <div class="stat-cell"><strong>${allTags().length}</strong><span>タグ</span></div>
        <div class="stat-cell"><strong>${practicing}</strong><span>覚え中</span></div>
      </div>
      <div class="settings-group">
        <h3>よく歌う曲 TOP5</h3>
        ${topSongs.length ? topSongs.map(s => bar(s.title, sungCountOf(s), maxSung, "回")).join("") : `<p class="hint">まだ歌唱記録がありません。</p>`}
      </div>
      <div class="settings-group">
        <h3>月別の歌唱回数（直近6ヶ月）</h3>
        <div class="stat-months">
          ${months.map(x => `
            <div class="stat-month">
              <span class="stat-month-count">${x.count || ""}</span>
              <div class="stat-month-bar" style="height:${Math.max(4, Math.round(x.count / maxMonth * 72))}px"></div>
              <span class="stat-month-label">${x.label}</span>
            </div>`).join("")}
        </div>
      </div>
      <div class="settings-group">
        <h3>ベストスコア TOP3</h3>
        ${topScores.length ? topScores.map((s, i) => `
          <div class="stat-score-row">
            <span class="stat-rank">${["🥇", "🥈", "🥉"][i]}</span>
            <span class="stat-score-title">${esc(s.title)}</span>
            <strong class="stat-score-val">${bestScore(s)}点</strong>
          </div>`).join("") : `<p class="hint">まだスコア記録がありません。</p>`}
      </div>
      <div class="settings-group">
        <h3>タグ分布</h3>
        ${topTags.length ? topTags.map(([t, c]) => bar(t, c, topTags[0][1], "曲")).join("") : `<p class="hint">タグはまだありません。</p>`}
      </div>`;
  }

  // ---------- おまかせ選曲ルーレット ----------
  let rouletteTimer = null;

  function renderRoulettePick(song, settled) {
    const box = $("rouletteResult");
    const art = song.artworkUrl
      ? `<img class="roulette-art" src="${esc(song.artworkUrl)}" alt="">`
      : `<div class="roulette-art placeholder">🎵</div>`;
    box.innerHTML = `
      ${art}
      <div class="roulette-title">${esc(song.title)}</div>
      <div class="roulette-artist">${esc(song.artist) || "&nbsp;"}</div>
      <div class="roulette-meta"><span class="key-badge">キー ${keyLabel(song.key)}</span>${song.rating ? `<span class="rating-badge">${"★".repeat(song.rating)}</span>` : ""}</div>`;
    box.classList.toggle("settled", settled);
    if (settled) {
      box.onclick = () => {
        $("rouletteModal").classList.add("hidden");
        openEdit(song.id);
      };
    } else {
      box.onclick = null;
    }
  }

  function spinRoulette() {
    const pool = filteredSongs();
    if (pool.length === 0) { toast("対象の曲がありません"); return; }
    $("rouletteModal").classList.remove("hidden");
    clearInterval(rouletteTimer);
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length === 1) { renderRoulettePick(target, true); return; }
    let n = 0;
    rouletteTimer = setInterval(() => {
      n++;
      if (n >= 10) {
        clearInterval(rouletteTimer);
        renderRoulettePick(target, true);
      } else {
        renderRoulettePick(pool[Math.floor(Math.random() * pool.length)], false);
      }
    }, 70);
  }

  // ---------- 共有 ----------
  function b64url(u8) {
    let s = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
      s += String.fromCharCode(...u8.subarray(i, i + chunkSize));
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(str) {
    if (!str || str.length > LIMITS.encodedShareChars || !/^[A-Za-z0-9_-]+$/.test(str)) {
      throw new Error("共有データの文字列が不正です");
    }
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    str += "=".repeat((4 - str.length % 4) % 4);
    const bin = atob(str);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  async function encodeShare(list) {
    if (!Array.isArray(list) || list.length > LIMITS.shareSongs) {
      throw new Error(`共有できるのは${LIMITS.shareSongs}曲までです`);
    }
    const compact = list.map(s => [s.title, s.artist || "", s.key || 0, s.tags || []]);
    const bytes = new TextEncoder().encode(JSON.stringify(compact));
    if (bytes.byteLength > LIMITS.shareBytes) throw new Error("共有データが大きすぎます");
    if (typeof CompressionStream !== "undefined") {
      const cs = new CompressionStream("deflate-raw");
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
      return "1." + b64url(new Uint8Array(buf));
    }
    return "0." + b64url(bytes);
  }

  async function decodeShare(hashVal) {
    if (typeof hashVal !== "string" || hashVal.length < 3 || hashVal[1] !== ".") {
      throw new Error("共有リンクの形式が不正です");
    }
    const mode = hashVal[0];
    if (mode !== "0" && mode !== "1") throw new Error("未対応の共有形式です");
    let bytes = b64urlDecode(hashVal.slice(2));
    if (mode === "1") {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("このブラウザは圧縮共有リンクに対応していません");
      }
      const ds = new DecompressionStream("deflate-raw");
      bytes = await readStreamLimited(new Blob([bytes]).stream().pipeThrough(ds), LIMITS.shareBytes);
    }
    if (bytes.byteLength > LIMITS.shareBytes) throw new Error("共有データが大きすぎます");
    const compact = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(compact) || compact.length > LIMITS.shareSongs) {
      throw new Error("共有された曲数が上限を超えています");
    }
    const expanded = compact.map((row, index) => {
      if (!Array.isArray(row) || row.length < 1 || row.length > 4) {
        throw new Error(`${index + 1}曲目の共有形式が不正です`);
      }
      return { title: row[0], artist: row[1] || "", key: row[2] ?? 0, tags: row[3] || [] };
    });
    return validateIncomingSongs(expanded, LIMITS.shareSongs).map(song => ({
      title: song.title,
      artist: song.artist,
      key: song.key,
      tags: song.tags,
    }));
  }

  async function makeShare() {
    const button = $("btnMakeShare");
    button.disabled = true;
    try {
      const list = $("shareScope").value === "filtered" ? filteredSongs() : songs;
      if (list.length === 0) { toast("共有する曲がありません"); return; }
      const hash = await encodeShare(list);
      const url = location.origin + location.pathname + "#share=" + hash;
      $("shareUrl").value = url;
      $("shareResult").classList.remove("hidden");
      $("btnNativeShare").classList.toggle("hidden", !navigator.share);
      const qrBox = $("qrBox");
      qrBox.innerHTML = "";
      if (url.length <= 1000 && typeof qrcode !== "undefined") {
        try {
          const qr = qrcode(0, "L");
          qr.addData(url);
          qr.make();
          qrBox.innerHTML = qr.createImgTag(4, 8);
          qrBox.insertAdjacentHTML("beforeend", `<p class="hint">QRコードを読み取ってもらえばそのまま開けます</p>`);
        } catch (e) {
          qrBox.innerHTML = `<p class="hint">QRコードを作成できませんでした。リンクをコピーして送ってください。</p>`;
        }
      } else {
        qrBox.innerHTML = `<p class="hint">曲数が多いためQRコードは省略されました。リンクをコピーして送ってください。</p>`;
      }
      toast(`${list.length}曲の共有リンクを作成しました`);
    } catch (e) {
      reportError("共有リンクの作成", e);
    } finally {
      button.disabled = false;
    }
  }

  function showReceive(list) {
    receivedSongs = list;
    const mine = new Set(songs.map(s => normSearch(s.title) + "|" + normSearch(s.artist)));
    const withFlag = list.map(s => ({ ...s, have: mine.has(normSearch(s.title) + "|" + normSearch(s.artist || "")) }));
    const haveCount = withFlag.filter(s => s.have).length;
    $("receiveInfo").textContent =
      `${list.length}曲が共有されました（かぶり${haveCount}曲・新しい曲${list.length - haveCount}曲）`;
    const box = $("receiveList");
    box.innerHTML = "";
    // 新しい曲を上に、かぶりは下にまとめ、端末を止めないよう段階表示する。
    const ordered = [...withFlag].sort((a, b) => Number(a.have) - Number(b.have));
    let shown = 0;
    const appendNext = () => {
      const fragment = document.createDocumentFragment();
      ordered.slice(shown, shown + LIST_PAGE_SIZE).forEach(s => {
      const row = document.createElement("div");
      row.className = "receive-row" + (s.have ? " have" : "");
      row.innerHTML = `
        <span class="receive-flag ${s.have ? "flag-have" : "flag-new"}">${s.have ? "かぶり" : "NEW"}</span>
        <span class="receive-title">${esc(s.title)}</span><span class="receive-artist">${esc(s.artist)}</span>`;
        fragment.appendChild(row);
      });
      shown = Math.min(shown + LIST_PAGE_SIZE, ordered.length);
      box.querySelector(".receive-more")?.remove();
      if (shown < ordered.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "settings-btn receive-more";
        more.textContent = `さらに表示（残り${ordered.length - shown}曲）`;
        more.onclick = appendNext;
        fragment.appendChild(more);
      }
      box.appendChild(fragment);
    };
    appendNext();
    $("receiveModal").classList.remove("hidden");
  }

  // ---------- インポート（共通マージ処理） ----------
  async function mergeSongs(incoming) {
    const validated = validateIncomingSongs(incoming);
    const existingByKey = new Map(songs.map(s => [normSearch(s.title) + "|" + normSearch(s.artist), s.id]));
    const now = Date.now();
    const added = [];
    const sourceIdMap = new Map();
    let duplicateCount = 0;
    validated.forEach((s, i) => {
      const k = normSearch(s.title) + "|" + normSearch(s.artist);
      const existingId = existingByKey.get(k);
      if (existingId) {
        duplicateCount++;
        if (s.sourceId) sourceIdMap.set(s.sourceId, existingId);
        return;
      }
      const song = {
        id: DB.newId(),
        title: s.title,
        artist: s.artist,
        artworkUrl: s.artworkUrl,
        tags: s.tags,
        key: s.key,
        rating: s.rating,
        practicing: s.practicing,
        memo: s.memo,
        scores: s.scores,
        sungDates: s.sungDates,
        createdAt: s.createdAt || now + i,
        updatedAt: now,
      };
      syncSungFields(song);
      added.push(song);
      existingByKey.set(k, song.id);
      if (s.sourceId) sourceIdMap.set(s.sourceId, song.id);
    });
    const addedHistoryCount = added.reduce((total, song) =>
      total + (song.scores || []).length + (song.sungDates || []).length, 0);
    if (historyEntryCount() + addedHistoryCount > LIMITS.totalHistoryEntries) {
      throw new Error("取り込み後の履歴件数が上限を超えます");
    }
    if (added.length) {
      await DB.bulkPut(added);
      songs.push(...added);
    }
    return { addedCount: added.length, duplicateCount, sourceIdMap, addedIds: added.map(song => song.id) };
  }

  // ---------- 設定 ----------
  function openSettings() {
    const tagCount = allTags().length;
    const sungTotal = songs.reduce((n, s) => n + sungCountOf(s), 0);
    $("statsText").textContent = `登録曲数: ${songs.length}曲 ／ タグ: ${tagCount}個 ／ 累計歌唱: ${sungTotal}回`;
    renderTagManager();
    updateBackupStatus();
    updateStorageStatus();
    updateDiagnosticOutput();
    $("settingsModal").classList.remove("hidden");
  }

  function updateDiagnosticOutput() {
    const output = $("diagnosticOutput");
    if (!output) return;
    try {
      const rows = JSON.parse(localStorage.getItem(DIAG_KEY) || "[]");
      output.textContent = rows.length
        ? rows.map(row => `${new Date(row.at).toLocaleString("ja-JP")} ${row.type} ${row.detail}`).join("\n")
        : "診断情報はまだありません";
    } catch (_) {
      output.textContent = "診断情報を読み込めませんでした";
    }
  }

  function renderTagManager() {
    const box = $("tagManager");
    box.innerHTML = "";
    const tags = allTags();
    if (tags.length === 0) {
      box.innerHTML = `<span class="hint">タグはまだありません。</span>`;
      return;
    }
    tags.forEach(tag => {
      const btn = document.createElement("button");
      btn.className = "tag-chip";
      btn.textContent = `${tag} ✕`;
      btn.onclick = async () => {
        if (!confirm(`タグ「${tag}」をすべての曲から削除しますか？`)) return;
        const changed = songs.filter(s => (s.tags || []).includes(tag)).map(s => ({
          ...s,
          tags: s.tags.filter(t => t !== tag),
          updatedAt: Date.now(),
        }));
        try {
          await DB.bulkPut(changed);
          const byId = new Map(changed.map(s => [s.id, s]));
          songs = songs.map(s => byId.get(s.id) || s);
          activeTags.delete(tag);
          renderTagManager();
          render();
          toast(`タグ「${tag}」を削除しました`);
        } catch (e) {
          reportError("タグの削除", e);
        }
      };
      box.appendChild(btn);
    });
  }

  function importSetlists(validatedSetlists, sourceIdMap) {
    const imported = validatedSetlists.map(raw => {
      const seen = new Set();
      const items = [];
      raw.items.forEach(item => {
        const mappedId = sourceIdMap.get(item.sourceId);
        if (!mappedId || seen.has(mappedId)) return;
        seen.add(mappedId);
        const next = { id: mappedId, done: item.done };
        if (Number.isFinite(item.sungAt)) next.sungAt = item.sungAt;
        items.push(next);
      });
      return { id: DB.newId(), name: raw.name, createdAt: raw.createdAt, items };
    });
    if (!imported.length) return 0;
    const currentItemCount = setlists.reduce((sum, list) => sum + list.items.length, 0);
    const importedItemCount = imported.reduce((sum, list) => sum + list.items.length, 0);
    if (setlists.length + imported.length > LIMITS.setlists ||
        currentItemCount + importedItemCount > LIMITS.totalSetlistItems) {
      throw new Error("取り込み後のセットリスト数または合計曲数が上限を超えます");
    }
    setlists.push(...imported);
    if (!saveSetlists()) {
      setlists.splice(setlists.length - imported.length, imported.length);
      throw new Error("セットリストを端末へ保存できませんでした");
    }
    return imported.length;
  }

  function updateBackupStatus() {
    const el = $("backupStatus");
    if (!el) return;
    try {
      const timestamp = Number(localStorage.getItem(STORAGE_KEYS.lastBackup));
      el.textContent = timestamp
        ? `最終バックアップ: ${fmtDate(timestamp)}`
        : "まだバックアップされていません";
    } catch (_) {
      el.textContent = "バックアップ日時を確認できません";
    }
  }

  async function updateStorageStatus() {
    const status = $("storageStatus");
    const button = $("btnPersistStorage");
    if (!navigator.storage) {
      status.textContent = "このブラウザでは保存状態を確認できません";
      button.classList.add("hidden");
      return;
    }
    try {
      const [persistent, estimate] = await Promise.all([
        navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
        navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null),
      ]);
      const usage = estimate && Number.isFinite(estimate.usage)
        ? `・使用量 ${Math.max(0.1, estimate.usage / 1024 / 1024).toFixed(1)}MB`
        : "";
      const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
      const installHint = standalone ? "" : "・iPhoneではホーム画面からの利用を推奨します";
      status.textContent = persistent
        ? `保護された端末保存です${usage}${installHint}`
        : `通常の端末保存です${usage}${installHint}`;
      button.classList.toggle("hidden", persistent || !navigator.storage.persist);
    } catch (e) {
      status.textContent = "保存状態を確認できませんでした";
      button.classList.toggle("hidden", !navigator.storage.persist);
    }
  }

  async function requestPersistentStorage() {
    const button = $("btnPersistStorage");
    button.disabled = true;
    try {
      const persistent = await navigator.storage.persist();
      toast(persistent ? "端末保存が保護されました" : "保護は許可されませんでした。バックアップをご利用ください");
      await updateStorageStatus();
    } catch (e) {
      reportError("端末保存の保護", e);
    } finally {
      button.disabled = false;
    }
  }

  function createBackupBlob(data) {
    if (typeof Worker === "undefined") {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      if (blob.size > LIMITS.exportBytes) throw new Error("バックアップがサイズ上限を超えています");
      return Promise.resolve(blob);
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker("js/backup-worker.js");
      worker.onmessage = event => {
        worker.terminate();
        if (event.data && event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.blob);
      };
      worker.onerror = () => {
        worker.terminate();
        reject(new Error("バックアップ処理を開始できませんでした"));
      };
      worker.postMessage({ data, maxBytes: LIMITS.exportBytes });
    });
  }

  async function exportJson() {
    const button = $("btnExport");
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "作成中…";
    let blob;
    try {
      const data = {
        app: "karaoke-repertoire",
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        songs,
        setlists,
      };
      blob = await createBackupBlob(data);
    } catch (error) {
      reportError("バックアップの作成", error);
      return;
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
    const filename = `karaoke-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = typeof File !== "undefined" ? new File([blob], filename, { type: blob.type }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: "うたログ バックアップ", files: [file] });
        localStorage.setItem(STORAGE_KEYS.lastBackup, String(Date.now()));
        updateBackupStatus();
        toast("バックアップファイルを共有しました");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
        diagnostic("backup-share-failed", error && error.name);
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    const objectUrl = a.href;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    toast("バックアップのダウンロードを開始しました。保存完了を確認してください");
  }

  async function importJson(file) {
    try {
      if (file.size > LIMITS.importBytes) {
        throw new Error(`ファイルサイズが上限（${LIMITS.importBytes / 1024 / 1024}MB）を超えています`);
      }
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.songs;
      if (!Array.isArray(incoming)) throw new Error("形式が違います");
      if (!Array.isArray(data)) {
        if (data.app && data.app !== "karaoke-repertoire") throw new Error("別のアプリのバックアップです");
        if (Number(data.version) > BACKUP_VERSION) throw new Error("このバックアップは新しいバージョンで作成されています");
      }
      // setlists も先に検証し、曲だけ入った後に形式エラーとなるのを防ぐ。
      const validatedSetlists = Array.isArray(data) ? [] : validateBackupSetlists(data.setlists);
      if (validatedSetlists.length) {
        const sourceIds = new Set(validateIncomingSongs(incoming).map(song => song.sourceId).filter(Boolean));
        validatedSetlists.forEach(list => list.items.forEach(item => {
          if (!sourceIds.has(item.sourceId)) {
            throw new Error(`セットリスト「${list.name}」が存在しない曲を参照しています`);
          }
        }));
      }
      const result = await mergeSongs(incoming);
      let importedSetlists = 0;
      try {
        importedSetlists = importSetlists(validatedSetlists, result.sourceIdMap);
      } catch (setlistError) {
        if (result.addedIds.length) await DB.bulkRemove(result.addedIds);
        const addedIdSet = new Set(result.addedIds);
        songs = songs.filter(song => !addedIdSet.has(song.id));
        throw new Error(`セットリストを保存できなかったため取り込みを取り消しました: ${setlistError.message}`);
      }
      render();
      openSettings();
      const setlistText = importedSetlists ? `・セットリスト${importedSetlists}件` : "";
      toast(`${result.addedCount}曲${setlistText}をインポートしました（重複${result.duplicateCount}件）`);
    } catch (e) {
      toast("インポート失敗: " + e.message);
      console.error("[うたログ] インポート失敗", e);
    }
  }

  // ---------- シートを下スワイプで閉じる ----------
  function enableSheetDrag(overlay, onClose) {
    const sheet = overlay.querySelector(".modal");
    let startY = null;
    let dy = 0;

    sheet.addEventListener("touchstart", (e) => {
      const t = e.target;
      // ハンドル・ヘッダー部分からのみドラッグ開始（ボタンは除外）
      if (!t.closest(".sheet-handle") && !t.closest(".modal-header")) return;
      if (t.closest("button")) return;
      startY = e.touches[0].clientY;
      dy = 0;
      sheet.style.transition = "none";
    }, { passive: true });

    sheet.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });

    sheet.addEventListener("touchend", () => {
      if (startY === null) return;
      sheet.style.transition = "transform 0.2s ease-out";
      if (dy > 110) {
        sheet.style.transform = "translateY(100%)";
        setTimeout(() => {
          onClose();
          sheet.style.transition = "";
          sheet.style.transform = "";
        }, 180);
      } else {
        sheet.style.transform = "";
        setTimeout(() => { sheet.style.transition = ""; }, 220);
      }
      startY = null;
      dy = 0;
    });
  }

  enableSheetDrag($("editModal"), closeEdit);
  enableSheetDrag($("pickerModal"), () => $("pickerModal").classList.add("hidden"));
  enableSheetDrag($("settingsModal"), () => $("settingsModal").classList.add("hidden"));
  enableSheetDrag($("shareModal"), () => $("shareModal").classList.add("hidden"));
  enableSheetDrag($("statsModal"), () => $("statsModal").classList.add("hidden"));
  enableSheetDrag($("receiveModal"), () => $("receiveModal").classList.add("hidden"));
  enableSheetDrag($("rouletteModal"), () => { clearInterval(rouletteTimer); $("rouletteModal").classList.add("hidden"); });

  // モーダルが開いたときのフォーカス移動・閉じ込め・復帰を共通化する。
  const modalPreviousFocus = new WeakMap();
  const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  function updateModalIsolation() {
    const visible = [...document.querySelectorAll(".modal-overlay:not(.hidden)")].at(-1) || null;
    [...document.body.children].forEach(child => {
      if (child.tagName === "SCRIPT" || child.id === "toast") return;
      child.inert = !!visible && child !== visible;
    });
  }
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    new MutationObserver(() => {
      if (!overlay.classList.contains("hidden")) {
        modalPreviousFocus.set(overlay, document.activeElement);
        requestAnimationFrame(() => overlay.querySelector(focusableSelector)?.focus());
      } else {
        const previous = modalPreviousFocus.get(overlay);
        if (previous && previous.isConnected) previous.focus();
      }
      updateModalIsolation();
    }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const close = overlay.querySelector("[id*='Close'], #btnCancelEdit");
        if (close) { e.preventDefault(); close.click(); }
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...overlay.querySelectorAll(focusableSelector)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });

  // ---------- イベント登録 ----------
  $("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    listDisplayLimit = LIST_PAGE_SIZE;
    $("btnClearSearch").classList.toggle("hidden", !searchQuery);
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(renderList, 150);
  });
  $("btnClearSearch").onclick = () => {
    $("searchInput").value = "";
    searchQuery = "";
    listDisplayLimit = LIST_PAGE_SIZE;
    $("btnClearSearch").classList.add("hidden");
    renderList();
  };
  $("sortSelect").onchange = (e) => { sortMode = e.target.value; listDisplayLimit = LIST_PAGE_SIZE; renderList(); };

  $("tabList").onclick = () => switchTab("list");
  $("tabSetlist").onclick = () => {
    // 詳細画面でタブを再タップしたら一覧に戻る
    const onSetlistTab = !$("setlistView").classList.contains("hidden");
    if (onSetlistTab && currentSetlistId) { closeSetlistDetail(); return; }
    switchTab("setlist");
  };
  $("tabHistory").onclick = () => switchTab("history");

  $("btnNewSetlist").onclick = () => {
    const name = prompt("セットリストの名前", defaultListName());
    if (name === null) return;
    if (!createSetlist(name.trim() || undefined)) return;
    renderPlList();
    toast("セットリストを作成しました");
  };

  $("btnPlBack").onclick = closeSetlistDetail;

  $("btnPlRename").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    const name = prompt("セットリストの名前", list.name);
    if (name === null || !name.trim()) return;
    if (name.trim().length > LIMITS.setlistName) {
      toast(`セットリスト名は${LIMITS.setlistName}文字以内にしてください`);
      return;
    }
    const previousName = list.name;
    list.name = name.trim();
    if (!saveSetlists()) { list.name = previousName; return; }
    renderSetlistDetail();
  };

  $("btnPlDelete").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    if (!confirm(`セットリスト「${list.name}」を削除しますか？（曲や歌唱記録は消えません）`)) return;
    const index = setlists.indexOf(list);
    setlists = setlists.filter(l => l.id !== list.id);
    if (!saveSetlists()) {
      setlists.splice(Math.max(0, index), 0, list);
      return;
    }
    closeSetlistDetail();
    renderList();
    toast("セットリストを削除しました");
  };

  $("btnClearDone").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    const previousItems = list.items;
    list.items = list.items.filter(x => !x.done);
    if (!saveSetlists()) { list.items = previousItems; return; }
    renderSetlistDetail();
  };
  $("btnClearSetlist").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    if (list.items.length && !confirm("このリストから全曲外しますか？（歌唱記録は残ります）")) return;
    const previousItems = list.items;
    list.items = [];
    if (!saveSetlists()) { list.items = previousItems; return; }
    renderSetlistDetail();
  };

  $("btnClosePicker").onclick = () => { $("pickerModal").classList.add("hidden"); renderList(); };
  $("pickerModal").addEventListener("click", (e) => {
    if (e.target === $("pickerModal")) { $("pickerModal").classList.add("hidden"); renderList(); }
  });
  $("btnPickerNew").onclick = () => {
    const name = prompt("セットリストの名前", defaultListName());
    if (name === null) return;
    if (!canAddSetlistItems(1)) return;
    const list = createSetlist(name.trim() || undefined);
    if (!list) return;
    list.items.push({ id: pickerSongId, done: false });
    if (!saveSetlists()) { list.items.pop(); return; }
    renderPicker();
    renderList();
    toast(`「${list.name}」を作成して追加しました`);
  };

  $("btnAdd").onclick = () => openEdit(null);
  $("btnCancelEdit").onclick = () => closeEdit(); // 直接渡すとclickイベントがforce扱いになり確認が飛ばされる
  $("btnSaveEdit").onclick = saveEdit;
  $("btnDelete").onclick = deleteSong;
  $("editModal").addEventListener("click", (e) => { if (e.target === $("editModal")) closeEdit(); });

  $("keyMinus").onclick = () => { if (editKey > -7) { editKey--; updateKeyView(); } };
  $("keyPlus").onclick = () => { if (editKey < 7) { editKey++; updateKeyView(); } };
  $("keyReset").onclick = () => { editKey = 0; updateKeyView(); };

  $("ratingStars").querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      const v = Number(b.dataset.star);
      editRating = (editRating === v) ? 0 : v;
      updateRatingView();
    };
  });

  $("btnPracticing").onclick = () => {
    editPracticing = !editPracticing;
    updatePracticingView();
  };

  $("scoreSungTarget").onchange = () => {
    const value = $("scoreSungTarget").value;
    $("inputSungDate").disabled = value !== "new";
    $("inputSungDate").value = localDateTime(value === "new" ? Date.now() : editSungDates[Number(value)]);
  };
  $("btnAddScore").onclick = addScore;
  $("inputScore").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addScore(); }
  });

  $("btnSungToday").onclick = () => {
    editSungDates.push(Date.now());
    $("scoreSungTarget").value = "";
    renderSungTargets();
    updateSungView();
    toast("保存すると記録されます");
  };
  $("btnSungUndo").onclick = () => {
    if (!editSungDates.length) return;
    const latest = Math.max(...editSungDates);
    editSungDates.splice(editSungDates.lastIndexOf(latest), 1);
    renderSungTargets();
    updateSungView();
    toast("1回分取り消しました（保存で確定）");
  };

  $("btnEditToSetlist").onclick = () => {
    if (editingId) openPicker(editingId);
  };

  $("btnYoutube").onclick = () => {
    const title = $("inputTitle").value.trim();
    if (!title) { toast("曲名を入力してください"); return; }
    const q = encodeURIComponent(`${title} ${$("inputArtist").value.trim()}`.trim());
    window.open(`https://www.youtube.com/results?search_query=${q}`, "_blank", "noopener");
  };

  $("btnRoulette").onclick = spinRoulette;
  $("btnSpinAgain").onclick = spinRoulette;
  $("btnRouletteClose").onclick = () => { clearInterval(rouletteTimer); $("rouletteModal").classList.add("hidden"); };
  $("rouletteModal").addEventListener("click", (e) => {
    if (e.target === $("rouletteModal")) { clearInterval(rouletteTimer); $("rouletteModal").classList.add("hidden"); }
  });

  $("btnAddTag").onclick = addNewTag;
  $("inputNewTag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNewTag(); }
  });

  function scheduleTitleSuggest(e) {
    editArtworkUrl = "";
    dismissSuggest("suggestBox");
    if (e.isComposing) return;
    const term = e.target.value.trim();
    if (term.length < 1) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => showSuggest(term).catch(error => {
      if (!error || error.name !== "AbortError") diagnostic("suggest-failed", error && error.name);
    }), 350);
  }
  $("inputTitle").addEventListener("input", scheduleTitleSuggest);
  $("inputTitle").addEventListener("compositionend", scheduleTitleSuggest);

  function scheduleArtistSuggest(e) {
    dismissSuggest("suggestBoxArtist");
    if (e.isComposing) return;
    const term = e.target.value.trim();
    if (term.length < 1) { hideSuggest(); return; }
    artistSuggestTimer = setTimeout(() => showArtistSuggest(term).catch(error => {
      if (!error || error.name !== "AbortError") diagnostic("artist-suggest-failed", error && error.name);
    }), 350);
  }
  $("inputArtist").addEventListener("input", scheduleArtistSuggest);
  $("inputArtist").addEventListener("compositionend", scheduleArtistSuggest);

  // 候補リストの外側をタップしたら閉じる（候補が邪魔で他の欄に入力できない対策）
  document.addEventListener("pointerdown", (e) => {
    const wrap = e.target.closest(".suggest-wrap");
    ["suggestBox", "suggestBoxArtist"].forEach(id => {
      const box = $(id);
      if (!wrap || !wrap.contains(box)) {
        dismissSuggest(id);
      }
    });
  });

  $("btnSettings").onclick = openSettings;
  $("btnCloseSettings").onclick = () => $("settingsModal").classList.add("hidden");
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden");
  });
  $("btnExport").onclick = exportJson;
  $("btnImport").onclick = () => $("importFile").click();
  $("btnPersistStorage").onclick = requestPersistentStorage;
  $("btnCopyDiagnostics").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("diagnosticOutput").textContent);
      toast("診断情報をコピーしました");
    } catch (error) {
      reportError("診断情報のコピー", error);
    }
  };
  $("btnClearDiagnostics").onclick = () => {
    try { localStorage.removeItem(DIAG_KEY); } catch (_) { /* 表示だけ更新 */ }
    updateDiagnosticOutput();
    toast("診断情報を消去しました");
  };
  $("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });

  $("btnOpenShare").onclick = () => {
    $("settingsModal").classList.add("hidden");
    $("shareResult").classList.add("hidden");
    $("shareModal").classList.remove("hidden");
  };
  $("btnOpenStats").onclick = () => {
    $("settingsModal").classList.add("hidden");
    renderStats();
    $("statsModal").classList.remove("hidden");
  };
  $("btnCloseStats").onclick = () => $("statsModal").classList.add("hidden");
  $("statsModal").addEventListener("click", (e) => {
    if (e.target === $("statsModal")) $("statsModal").classList.add("hidden");
  });
  $("btnCloseShare").onclick = () => $("shareModal").classList.add("hidden");
  $("shareModal").addEventListener("click", (e) => {
    if (e.target === $("shareModal")) $("shareModal").classList.add("hidden");
  });
  $("btnMakeShare").onclick = makeShare;
  $("btnCopyShare").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("shareUrl").value);
      toast("リンクをコピーしました");
    } catch (e) {
      $("shareUrl").select();
      document.execCommand("copy");
      toast("リンクをコピーしました");
    }
  };
  $("btnNativeShare").onclick = () => {
    navigator.share({ title: "うたログ - レパートリー共有", url: $("shareUrl").value }).catch(() => {});
  };

  $("btnCloseReceive").onclick = () => $("receiveModal").classList.add("hidden");
  $("btnImportReceive").onclick = async () => {
    if (!receivedSongs) return;
    try {
      const result = await mergeSongs(receivedSongs);
      $("receiveModal").classList.add("hidden");
      render();
      toast(`${result.addedCount}曲を取り込みました（重複${result.duplicateCount}件スキップ）`);
      receivedSongs = null;
      history.replaceState(null, "", location.pathname + location.search);
    } catch (e) {
      reportError("共有曲の取り込み", e);
    }
  };

  // ---------- 起動 ----------
  loadSetlists();
  DB.getAll().then(async (list) => {
    songs = list;
    // 旧データ移行: sungCountのみの曲に sungDates を生成
    const migrated = [];
    songs.forEach(s => {
      if (!Array.isArray(s.sungDates)) {
        const rawCount = Number(s.sungCount) || 0;
        const n = Number.isInteger(rawCount) && rawCount > 0
          ? Math.min(rawCount, LIMITS.sungDates)
          : 0;
        const legacyDate = [s.lastSungAt, s.updatedAt].find(date =>
          typeof date === "number" && Number.isFinite(date) && date > 0) || Date.now();
        s.sungDates = n > 0 ? Array(n).fill(legacyDate) : [];
        migrated.push(s);
      } else {
        const normalizedDates = s.sungDates
          .filter(date => typeof date === "number" && Number.isFinite(date) && date > 0)
          .slice(0, LIMITS.sungDates)
          .sort((a, b) => a - b);
        if (normalizedDates.length !== s.sungDates.length || normalizedDates.some((date, i) => date !== s.sungDates[i])) {
          s.sungDates = normalizedDates;
          syncSungFields(s);
          migrated.push(s);
        }
      }
    });
    if (migrated.length) await DB.bulkPut(migrated);
    render();
    const m = location.hash.match(/^#share=(.+)$/);
    if (m) {
      try {
        const shared = await decodeShare(decodeURIComponent(m[1]));
        if (shared.length) showReceive(shared);
      } catch (e) {
        toast("共有リンクの読み込みに失敗しました: " + e.message);
        console.error("[うたログ] 共有リンクの読み込み失敗", e);
      }
    }
  }).catch(e => {
    reportError("曲データの読み込み", e);
    $("emptyState").classList.remove("hidden");
    $("emptyMessage").textContent = "曲データを読み込めませんでした。ページを再読み込みしてください。";
  });

  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then(registration => {
      const offerUpdate = worker => {
        if (!worker) return;
        toast("うたログの更新があります", "更新する", () => {
          worker.postMessage({ type: "SKIP_WAITING" });
        });
      };
      if (registration.waiting) offerUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
    }).catch(e => {
      diagnostic("service-worker-failed", e && e.name);
      console.warn("[うたログ] Service Worker登録失敗", e);
    });
  }
})();
