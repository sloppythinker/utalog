(() => {
  const $ = (id) => document.getElementById(id);

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

  // 編集モーダルの状態
  let editingId = null;   // null = 新規
  let editKey = 0;
  let editRating = 0;
  let editPracticing = false;
  let editTags = new Set();
  let editArtworkUrl = "";
  let editScores = [];
  let editSungDates = [];
  let suggestTimer = null;
  let artistSuggestTimer = null;

  // ---------- ユーティリティ ----------
  function keyLabel(k) {
    if (!k) return "原曲";
    return k > 0 ? `+${k}` : `${k}`;
  }

  function norm(s) {
    return (s || "").toLowerCase().replace(/[ぁ-ゖ]/g,
      ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
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

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }

  // ---------- 歌唱記録（sungDates = 歌った日時の配列） ----------
  function sungCountOf(song) { return (song.sungDates || []).length; }
  function lastSungOf(song) {
    const d = song.sungDates || [];
    return d.length ? d[d.length - 1] : 0;
  }

  function syncSungFields(song) {
    song.sungCount = sungCountOf(song);
    song.lastSungAt = lastSungOf(song);
  }

  async function recordSung(song) {
    song.sungDates = song.sungDates || [];
    song.sungDates.push(Date.now());
    syncSungFields(song);
    song.updatedAt = Date.now();
    await DB.put(song);
  }

  async function unrecordSung(song) {
    song.sungDates = song.sungDates || [];
    song.sungDates.pop();
    syncSungFields(song);
    song.updatedAt = Date.now();
    await DB.put(song);
  }

  // ---------- 複数セットリスト（localStorage） ----------
  function defaultListName() {
    const base = `${fmtDate(Date.now())}のリスト`;
    if (!setlists.some(l => l.name === base)) return base;
    let n = 2;
    while (setlists.some(l => l.name === `${base}(${n})`)) n++;
    return `${base}(${n})`;
  }

  function loadSetlists() {
    try { setlists = JSON.parse(localStorage.getItem("utalog-setlists") || "[]"); } catch (e) { setlists = []; }
    // 旧形式（単一リスト）からの移行
    const old = localStorage.getItem("utalog-setlist");
    if (old !== null) {
      try {
        const items = JSON.parse(old);
        if (Array.isArray(items) && items.length) {
          setlists.push({ id: DB.newId(), name: defaultListName(), createdAt: Date.now(), items });
        }
      } catch (e) { /* 壊れた旧データは破棄 */ }
      localStorage.removeItem("utalog-setlist");
      saveSetlists();
    }
  }

  function saveSetlists() {
    localStorage.setItem("utalog-setlists", JSON.stringify(setlists));
    renderSetlistBadge();
  }

  function createSetlist(name) {
    const list = { id: DB.newId(), name: name || defaultListName(), createdAt: Date.now(), items: [] };
    setlists.unshift(list);
    saveSetlists();
    return list;
  }

  function currentSetlist() {
    return setlists.find(l => l.id === currentSetlistId) || null;
  }

  function inAnySetlist(songId) {
    return setlists.some(l => l.items.some(x => x.id === songId));
  }

  function renderSetlistBadge() {
    const badge = $("setlistBadge");
    const remain = setlists.reduce((n, l) => n + l.items.filter(x => !x.done).length, 0);
    badge.textContent = remain;
    badge.classList.toggle("hidden", remain === 0);
  }

  function cleanSetlists() {
    let changed = false;
    setlists.forEach(l => {
      const before = l.items.length;
      l.items = l.items.filter(x => songs.some(s => s.id === x.id));
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
    box.innerHTML = "";
    $("setlistEmpty").classList.toggle("hidden", list.items.length > 0);

    list.items.forEach((item, idx) => {
      const song = songs.find(s => s.id === item.id);
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
        item.done = !item.done;
        if (item.done) { await recordSung(song); toast(`「${song.title}」歌った！🎤`); }
        else { await unrecordSung(song); toast("歌唱記録を取り消しました"); }
        saveSetlists();
        renderSetlistDetail();
      };
      row.querySelector(".sl-check").onclick = toggleDone;
      row.querySelectorAll(".sl-move").forEach(b => {
        b.onclick = () => {
          const dir = Number(b.dataset.dir);
          const j = idx + dir;
          if (j < 0 || j >= list.items.length) return;
          [list.items[idx], list.items[j]] = [list.items[j], list.items[idx]];
          saveSetlists();
          renderSetlistDetail();
        };
      });
      row.querySelector(".sl-remove").onclick = () => {
        list.items.splice(idx, 1);
        saveSetlists();
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
          list.items = list.items.filter(x => x.id !== pickerSongId);
          toast(`「${esc0(list.name)}」から外しました`);
        } else {
          list.items.push({ id: pickerSongId, done: false });
          toast(`「${esc0(list.name)}」に追加しました`);
        }
        saveSetlists();
        renderPicker();
        renderList();
      };
      box.appendChild(row);
    });
  }

  function esc0(s) { return s; } // toast はtextContentなのでエスケープ不要

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
    const box = $("historyList");
    box.innerHTML = "";
    const byDay = new Map(); // 日付0時のts → Map(songId → 回数)
    songs.forEach(s => (s.sungDates || []).forEach(ts => {
      const d = new Date(ts);
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (!byDay.has(key)) byDay.set(key, new Map());
      const m = byDay.get(key);
      m.set(s.id, (m.get(s.id) || 0) + 1);
    }));
    const days = [...byDay.keys()].sort((a, b) => b - a);
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
        const list = createSetlist(name.trim() || defName);
        list.items = [...m.keys()].filter(id => songs.some(s => s.id === id)).map(id => ({ id, done: false }));
        saveSetlists();
        toast(`「${list.name}」を作成しました（${list.items.length}曲）`);
      };
      box.appendChild(head);
      m.forEach((count, id) => {
        const song = songs.find(s => s.id === id);
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
  }

  // ---------- リスト描画 ----------
  function filteredSongs() {
    const q = norm(searchQuery);
    let list = songs.filter(s => {
      if (q && !norm(s.title).includes(q) && !norm(s.artist).includes(q)) return false;
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
    const list = filteredSongs();
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

    list.forEach(song => {
      const card = document.createElement("div");
      card.className = "song-card";
      card.dataset.kana = kanaRowOf(sortMode === "artist" ? song.artist : song.title);
      const art = song.artworkUrl
        ? `<img class="song-art" src="${esc(song.artworkUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\'song-art placeholder\'>🎵</div>'">`
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
        <button class="sl-quick ${inAnySetlist(song.id) ? "on" : ""}" aria-label="セットリストへ">📋</button>`;
      card.onclick = () => openEdit(song.id);
      const q = card.querySelector(".sl-quick");
      q.onclick = (e) => {
        e.stopPropagation();
        openPicker(song.id);
      };
      box.appendChild(card);
    });
  }

  function render() {
    renderTagFilter();
    renderList();
    renderSetlistBadge();
  }

  // ---------- 曲追加・編集モーダル ----------
  function openEdit(id) {
    editingId = id || null;
    const song = id ? songs.find(s => s.id === id) : null;
    $("editModalTitle").textContent = song ? "曲を編集" : "曲を追加";
    $("inputTitle").value = song ? song.title : "";
    $("inputArtist").value = song ? song.artist || "" : "";
    $("inputMemo").value = song ? song.memo || "" : "";
    $("inputScore").value = "";
    editKey = song ? song.key || 0 : 0;
    editRating = song ? song.rating || 0 : 0;
    editPracticing = song ? !!song.practicing : false;
    updatePracticingView();
    editTags = new Set(song ? song.tags || [] : []);
    editArtworkUrl = song ? song.artworkUrl || "" : "";
    editScores = song ? [...(song.scores || [])] : [];
    editSungDates = song ? [...(song.sungDates || [])] : [];
    $("btnDelete").classList.toggle("hidden", !song);
    $("btnEditToSetlist").classList.toggle("hidden", !song);
    hideSuggest();
    updateKeyView();
    updateRatingView();
    renderScoreSection();
    updateSungView();
    renderTagPicker();
    $("editModal").classList.remove("hidden");
    if (!song) setTimeout(() => $("inputTitle").focus(), 250);
  }

  function closeEdit() {
    $("editModal").classList.add("hidden");
    hideSuggest();
  }

  async function saveEdit() {
    const title = $("inputTitle").value.trim();
    if (!title) { toast("曲名を入力してください"); return; }
    // 画像がない場合は歌手名から取得を試みる
    const artistName = $("inputArtist").value.trim();
    if (!editArtworkUrl && artistName) {
      editArtworkUrl = await Promise.race([
        ITunes.artistImage(artistName),
        new Promise(r => setTimeout(() => r(""), 5000)),
      ]) || "";
    }
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
      lastSungAt: editSungDates.length ? editSungDates[editSungDates.length - 1] : 0,
      createdAt: base ? base.createdAt : now,
      updatedAt: now,
    };
    await DB.put(song);
    if (base) Object.assign(base, song); else songs.push(song);
    closeEdit();
    render();
    toast(editingId ? "更新しました" : `「${title}」を追加しました`);
    editingId = null;
  }

  async function deleteSong() {
    const song = songs.find(s => s.id === editingId);
    if (!song) return;
    if (!confirm(`「${song.title}」を削除しますか？`)) return;
    await DB.remove(song.id);
    songs = songs.filter(s => s.id !== song.id);
    setlists.forEach(l => { l.items = l.items.filter(x => x.id !== song.id); });
    saveSetlists();
    closeEdit();
    render();
    toast("削除しました");
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
    if (best !== null) bestEl.innerHTML = `ベスト <strong>${best}</strong> 点`;
    renderScoreChart();
    const hist = $("scoreHistory");
    hist.innerHTML = "";
    [...editScores].sort((a, b) => b.date - a.date).forEach(entry => {
      const row = document.createElement("div");
      row.className = "score-row";
      row.innerHTML = `<span>${entry.score} 点</span><span class="score-date">${fmtDate(entry.date)}</span><button class="score-del" aria-label="削除">✕</button>`;
      row.querySelector(".score-del").onclick = () => {
        editScores = editScores.filter(x => x !== entry);
        renderScoreSection();
      };
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

  function addScore() {
    const v = parseFloat($("inputScore").value);
    if (isNaN(v) || v < 0 || v > 100) { toast("0〜100の点数を入力してください"); return; }
    editScores.push({ score: Math.round(v * 10) / 10, date: Date.now() });
    $("inputScore").value = "";
    renderScoreSection();
  }

  // 歌唱記録
  function updateSungView() {
    $("sungInfo").textContent = editSungDates.length
      ? `${editSungDates.length}回（最終: ${fmtDate(editSungDates[editSungDates.length - 1])}）`
      : "まだ記録なし";
    $("btnSungUndo").disabled = editSungDates.length === 0;
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
    editTags.add(tag);
    input.value = "";
    renderTagPicker();
  }

  // ---------- 曲名・歌手名サジェスト ----------
  function normSuggest(s) {
    return norm((s || "").normalize("NFKC")).replace(/[\s　]/g, "");
  }

  function hideSuggest() {
    ["suggestBox", "suggestBoxArtist"].forEach(id => {
      $(id).classList.add("hidden");
      $(id).innerHTML = "";
    });
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
    close.onclick = () => { box.classList.add("hidden"); box.innerHTML = ""; };
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
    // 歌手名が入力済みなら「歌手名+曲名」でも検索し、その歌手の曲を優先
    const artistTerm = $("inputArtist").value.trim();
    let results;
    if (artistTerm) {
      const [byArtist, plain] = await Promise.all([
        ITunes.search(artistTerm + " " + term),
        ITunes.search(term),
      ]);
      results = byArtist.concat(plain);
    } else {
      results = await ITunes.search(term);
    }
    if ($("inputTitle").value.trim() !== term) return; // 入力が変わっていたら破棄
    // 曲名にマッチする候補だけ残す（歌手名だけの一致は除外）
    const nt = normSuggest(term);
    results = results.filter(r => normSuggest(r.title).includes(nt));
    const na = normSuggest(artistTerm);
    if (na) {
      results.sort((a, b) =>
        Number(normSuggest(b.artist).includes(na)) - Number(normSuggest(a.artist).includes(na)));
    }
    // 同じ曲名+歌手名の重複を除去
    const seen = new Set();
    results = results.filter(r => {
      const k = normSuggest(r.title) + "\n" + normSuggest(r.artist);
      return seen.has(k) ? false : (seen.add(k), true);
    }).slice(0, 8);
    if (results.length === 0) { $("suggestBox").classList.add("hidden"); return; }
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
    buildSuggestBox(box, rows, "曲名の候補（そのまま手入力もOK）");
  }

  async function showArtistSuggest(term) {
    const box = $("suggestBoxArtist");
    let results = await ITunes.searchArtists(term);
    if ($("inputArtist").value.trim() !== term) return;
    // 歌手名にマッチするものを優先（マッチゼロなら上位候補をそのまま表示）
    const nt = normSuggest(term);
    const matched = results.filter(a => normSuggest(a.name).includes(nt));
    if (matched.length) results = matched;
    results = results.slice(0, 6);
    if (results.length === 0) { box.classList.add("hidden"); return; }
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
    u8.forEach(b => s += String.fromCharCode(b));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(str);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  async function encodeShare(list) {
    const compact = list.map(s => [s.title, s.artist || "", s.key || 0, s.tags || []]);
    const bytes = new TextEncoder().encode(JSON.stringify(compact));
    if (typeof CompressionStream !== "undefined") {
      const cs = new CompressionStream("deflate-raw");
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
      return "1." + b64url(new Uint8Array(buf));
    }
    return "0." + b64url(bytes);
  }

  async function decodeShare(hashVal) {
    const mode = hashVal[0];
    let bytes = b64urlDecode(hashVal.slice(2));
    if (mode === "1") {
      const ds = new DecompressionStream("deflate-raw");
      bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
    }
    const compact = JSON.parse(new TextDecoder().decode(bytes));
    return compact.map(([title, artist, key, tags]) => ({
      title: String(title), artist: String(artist || ""),
      key: Number(key) || 0, tags: Array.isArray(tags) ? tags.map(String) : [],
    }));
  }

  async function makeShare() {
    const list = $("shareScope").value === "filtered" ? filteredSongs() : songs;
    if (list.length === 0) { toast("共有する曲がありません"); return; }
    const hash = await encodeShare(list);
    const url = location.origin + location.pathname + "#share=" + hash;
    $("shareUrl").value = url;
    $("shareResult").classList.remove("hidden");
    $("btnNativeShare").classList.toggle("hidden", !navigator.share);
    const qrBox = $("qrBox");
    qrBox.innerHTML = "";
    if (url.length <= 1800 && typeof qrcode !== "undefined") {
      try {
        const qr = qrcode(0, "L");
        qr.addData(url);
        qr.make();
        qrBox.innerHTML = qr.createImgTag(4, 8);
        qrBox.insertAdjacentHTML("beforeend", `<p class="hint">QRコードを読み取ってもらえばそのまま開けます</p>`);
      } catch (e) { /* データ過多でQR生成失敗時はリンクのみ */ }
    } else {
      qrBox.innerHTML = `<p class="hint">曲数が多いためQRコードは省略されました。リンクをコピーして送ってください。</p>`;
    }
    toast(`${list.length}曲の共有リンクを作成しました`);
  }

  function showReceive(list) {
    receivedSongs = list;
    const mine = new Set(songs.map(s => norm(s.title) + "|" + norm(s.artist)));
    const withFlag = list.map(s => ({ ...s, have: mine.has(norm(s.title) + "|" + norm(s.artist || "")) }));
    const haveCount = withFlag.filter(s => s.have).length;
    $("receiveInfo").textContent =
      `${list.length}曲が共有されました（かぶり${haveCount}曲・新しい曲${list.length - haveCount}曲）`;
    const box = $("receiveList");
    box.innerHTML = "";
    // 新しい曲を上に、かぶりは下にまとめる
    [...withFlag].sort((a, b) => Number(a.have) - Number(b.have)).forEach(s => {
      const row = document.createElement("div");
      row.className = "receive-row" + (s.have ? " have" : "");
      row.innerHTML = `
        <span class="receive-flag ${s.have ? "flag-have" : "flag-new"}">${s.have ? "かぶり" : "NEW"}</span>
        <span class="receive-title">${esc(s.title)}</span><span class="receive-artist">${esc(s.artist)}</span>`;
      box.appendChild(row);
    });
    $("receiveModal").classList.remove("hidden");
  }

  // ---------- インポート（共通マージ処理） ----------
  async function mergeSongs(incoming) {
    const existingKeys = new Set(songs.map(s => norm(s.title) + "|" + norm(s.artist)));
    const now = Date.now();
    const added = [];
    incoming.forEach((s, i) => {
      if (!s || !s.title) return;
      const k = norm(s.title) + "|" + norm(s.artist || "");
      if (existingKeys.has(k)) return;
      existingKeys.add(k);
      let sungDates = Array.isArray(s.sungDates) ? s.sungDates.filter(x => typeof x === "number") : [];
      if (!sungDates.length && Number(s.sungCount) > 0) {
        sungDates = Array(Number(s.sungCount)).fill(Number(s.lastSungAt) || now);
      }
      const song = {
        id: DB.newId(),
        title: String(s.title),
        artist: String(s.artist || ""),
        artworkUrl: String(s.artworkUrl || ""),
        tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
        key: Number(s.key) || 0,
        rating: Math.min(3, Math.max(0, Number(s.rating) || 0)),
        practicing: !!s.practicing,
        memo: String(s.memo || ""),
        scores: Array.isArray(s.scores)
          ? s.scores.filter(x => x && typeof x.score === "number").map(x => ({ score: x.score, date: Number(x.date) || now }))
          : [],
        sungDates,
        createdAt: Number(s.createdAt) || now + i,
        updatedAt: now,
      };
      syncSungFields(song);
      added.push(song);
    });
    if (added.length) {
      await DB.bulkPut(added);
      songs.push(...added);
    }
    return added.length;
  }

  // ---------- 設定 ----------
  function openSettings() {
    const tagCount = allTags().length;
    const sungTotal = songs.reduce((n, s) => n + sungCountOf(s), 0);
    $("statsText").textContent = `登録曲数: ${songs.length}曲 ／ タグ: ${tagCount}個 ／ 累計歌唱: ${sungTotal}回`;
    renderTagManager();
    $("settingsModal").classList.remove("hidden");
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
        const changed = songs.filter(s => (s.tags || []).includes(tag));
        changed.forEach(s => { s.tags = s.tags.filter(t => t !== tag); s.updatedAt = Date.now(); });
        await DB.bulkPut(changed);
        activeTags.delete(tag);
        renderTagManager();
        render();
        toast(`タグ「${tag}」を削除しました`);
      };
      box.appendChild(btn);
    });
  }

  function exportJson() {
    const data = {
      app: "karaoke-repertoire",
      version: 1,
      exportedAt: new Date().toISOString(),
      songs,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `karaoke-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("エクスポートしました");
  }

  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.songs;
      if (!Array.isArray(incoming)) throw new Error("形式が違います");
      const addedCount = await mergeSongs(incoming);
      render();
      openSettings();
      toast(`${addedCount}曲をインポートしました（重複${incoming.length - addedCount}件スキップ）`);
    } catch (e) {
      toast("インポート失敗: " + e.message);
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

  // ---------- イベント登録 ----------
  $("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    $("btnClearSearch").classList.toggle("hidden", !searchQuery);
    renderList();
  });
  $("btnClearSearch").onclick = () => {
    $("searchInput").value = "";
    searchQuery = "";
    $("btnClearSearch").classList.add("hidden");
    renderList();
  };
  $("sortSelect").onchange = (e) => { sortMode = e.target.value; renderList(); };

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
    createSetlist(name.trim() || undefined);
    renderPlList();
    toast("セットリストを作成しました");
  };

  $("btnPlBack").onclick = closeSetlistDetail;

  $("btnPlRename").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    const name = prompt("セットリストの名前", list.name);
    if (name === null || !name.trim()) return;
    list.name = name.trim();
    saveSetlists();
    renderSetlistDetail();
  };

  $("btnPlDelete").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    if (!confirm(`セットリスト「${list.name}」を削除しますか？（曲や歌唱記録は消えません）`)) return;
    setlists = setlists.filter(l => l.id !== list.id);
    saveSetlists();
    closeSetlistDetail();
    renderList();
    toast("セットリストを削除しました");
  };

  $("btnClearDone").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    list.items = list.items.filter(x => !x.done);
    saveSetlists();
    renderSetlistDetail();
  };
  $("btnClearSetlist").onclick = () => {
    const list = currentSetlist();
    if (!list) return;
    if (list.items.length && !confirm("このリストから全曲外しますか？（歌唱記録は残ります）")) return;
    list.items = [];
    saveSetlists();
    renderSetlistDetail();
  };

  $("btnClosePicker").onclick = () => { $("pickerModal").classList.add("hidden"); renderList(); };
  $("pickerModal").addEventListener("click", (e) => {
    if (e.target === $("pickerModal")) { $("pickerModal").classList.add("hidden"); renderList(); }
  });
  $("btnPickerNew").onclick = () => {
    const name = prompt("セットリストの名前", defaultListName());
    if (name === null) return;
    const list = createSetlist(name.trim() || undefined);
    list.items.push({ id: pickerSongId, done: false });
    saveSetlists();
    renderPicker();
    renderList();
    toast(`「${list.name}」を作成して追加しました`);
  };

  $("btnAdd").onclick = () => openEdit(null);
  $("btnCancelEdit").onclick = closeEdit;
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

  $("btnAddScore").onclick = addScore;
  $("inputScore").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addScore(); }
  });

  $("btnSungToday").onclick = () => {
    editSungDates.push(Date.now());
    updateSungView();
    toast("保存すると記録されます");
  };
  $("btnSungUndo").onclick = () => {
    if (!editSungDates.length) return;
    editSungDates.pop();
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

  $("inputTitle").addEventListener("input", (e) => {
    editArtworkUrl = "";
    clearTimeout(suggestTimer);
    const term = e.target.value.trim();
    if (term.length < 1) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => showSuggest(term), 350);
  });

  $("inputArtist").addEventListener("input", (e) => {
    clearTimeout(artistSuggestTimer);
    const term = e.target.value.trim();
    if (term.length < 1) { hideSuggest(); return; }
    artistSuggestTimer = setTimeout(() => showArtistSuggest(term), 350);
  });

  // 候補リストの外側をタップしたら閉じる（候補が邪魔で他の欄に入力できない対策）
  document.addEventListener("pointerdown", (e) => {
    const wrap = e.target.closest(".suggest-wrap");
    ["suggestBox", "suggestBoxArtist"].forEach(id => {
      const box = $(id);
      if (box.classList.contains("hidden")) return;
      if (!wrap || !wrap.contains(box)) {
        box.classList.add("hidden");
        box.innerHTML = "";
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
    const added = await mergeSongs(receivedSongs);
    $("receiveModal").classList.add("hidden");
    render();
    toast(`${added}曲を取り込みました（重複${receivedSongs.length - added}件スキップ）`);
    receivedSongs = null;
  };

  // ---------- 起動 ----------
  loadSetlists();
  DB.getAll().then(async (list) => {
    songs = list;
    // 旧データ移行: sungCountのみの曲に sungDates を生成
    const migrated = [];
    songs.forEach(s => {
      if (!Array.isArray(s.sungDates)) {
        const n = Number(s.sungCount) || 0;
        s.sungDates = n > 0 ? Array(n).fill(s.lastSungAt || s.updatedAt || Date.now()) : [];
        migrated.push(s);
      }
    });
    if (migrated.length) await DB.bulkPut(migrated);
    render();
    const m = location.hash.match(/^#share=(.+)$/);
    if (m) {
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const shared = await decodeShare(decodeURIComponent(m[1]));
        if (shared.length) showReceive(shared);
      } catch (e) {
        toast("共有リンクの読み込みに失敗しました");
      }
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
