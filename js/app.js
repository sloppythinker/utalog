(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- 状態 ----------
  let songs = [];
  let searchQuery = "";
  let activeTags = new Set();
  let sortMode = "new";
  let setlist = [];   // [{id, done}]
  let receivedSongs = null;

  // 編集モーダルの状態
  let editingId = null;   // null = 新規
  let editKey = 0;
  let editRating = 0;
  let editTags = new Set();
  let editArtworkUrl = "";
  let editScores = [];
  let editSungCount = 0;
  let editLastSungAt = 0;
  let suggestTimer = null;

  try { setlist = JSON.parse(localStorage.getItem("utalog-setlist") || "[]"); } catch (e) { setlist = []; }

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
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
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

  // ---------- セットリスト（localStorage） ----------
  function saveSetlist() {
    localStorage.setItem("utalog-setlist", JSON.stringify(setlist));
    renderSetlistBadge();
  }

  function inSetlist(id) {
    return setlist.some(x => x.id === id);
  }

  function toggleSetlist(id) {
    if (inSetlist(id)) {
      setlist = setlist.filter(x => x.id !== id);
      toast("セットリストから外しました");
    } else {
      setlist.push({ id, done: false });
      toast("セットリストに追加しました");
    }
    saveSetlist();
  }

  function renderSetlistBadge() {
    const badge = $("setlistBadge");
    const remain = setlist.filter(x => !x.done).length;
    badge.textContent = remain;
    badge.classList.toggle("hidden", remain === 0);
  }

  async function recordSung(song) {
    song.sungCount = (song.sungCount || 0) + 1;
    song.lastSungAt = Date.now();
    song.updatedAt = Date.now();
    await DB.put(song);
  }

  async function unrecordSung(song) {
    song.sungCount = Math.max(0, (song.sungCount || 0) - 1);
    song.updatedAt = Date.now();
    await DB.put(song);
  }

  function renderSetlist() {
    // 削除済みの曲を掃除
    const before = setlist.length;
    setlist = setlist.filter(x => songs.some(s => s.id === x.id));
    if (setlist.length !== before) saveSetlist();

    const box = $("setlistList");
    box.innerHTML = "";
    $("setlistEmpty").classList.toggle("hidden", setlist.length > 0);

    setlist.forEach((item, idx) => {
      const song = songs.find(s => s.id === item.id);
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
      row.querySelector(".sl-check").onclick = async () => {
        item.done = !item.done;
        if (item.done) { await recordSung(song); toast(`「${song.title}」歌った！🎤`); }
        else { await unrecordSung(song); }
        saveSetlist();
        renderSetlist();
      };
      row.querySelectorAll(".sl-move").forEach(b => {
        b.onclick = () => {
          const dir = Number(b.dataset.dir);
          const j = idx + dir;
          if (j < 0 || j >= setlist.length) return;
          [setlist[idx], setlist[j]] = [setlist[j], setlist[idx]];
          saveSetlist();
          renderSetlist();
        };
      });
      row.querySelector(".sl-remove").onclick = () => {
        setlist.splice(idx, 1);
        saveSetlist();
        renderSetlist();
      };
      row.querySelector(".sl-info").onclick = () => openEdit(song.id);
      box.appendChild(row);
    });
  }

  // ---------- タブ ----------
  function switchTab(tab) {
    const isList = tab === "list";
    $("listView").classList.toggle("hidden", !isList);
    $("setlistView").classList.toggle("hidden", isList);
    $("tabList").classList.toggle("active", isList);
    $("tabSetlist").classList.toggle("active", !isList);
    if (!isList) renderSetlist();
  }

  // ---------- リスト描画 ----------
  function filteredSongs() {
    const q = norm(searchQuery);
    let list = songs.filter(s => {
      if (q && !norm(s.title).includes(q) && !norm(s.artist).includes(q)) return false;
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
      gobusata: (a, b) => (a.lastSungAt || 0) - (b.lastSungAt || 0),
    }[sortMode];
    return list.sort(cmp);
  }

  function renderTagFilter() {
    const box = $("tagFilter");
    box.innerHTML = "";
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

  function renderList() {
    const list = filteredSongs();
    const box = $("songList");
    box.innerHTML = "";
    const empty = $("emptyState");
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
      const art = song.artworkUrl
        ? `<img class="song-art" src="${esc(song.artworkUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\'song-art placeholder\'>🎵</div>'">`
        : `<div class="song-art placeholder">🎵</div>`;
      const stars = song.rating ? `<span class="rating-badge">${"★".repeat(song.rating)}</span>` : "";
      const best = bestScore(song);
      const scoreB = best !== null ? `<span class="score-badge">🏆${best}</span>` : "";
      const tags = (song.tags || []).map(t => `<span class="mini-tag">${esc(t)}</span>`).join("");
      const memo = song.memo ? `<span class="memo-mark">📝</span>` : "";
      card.innerHTML = `
        ${art}
        <div class="song-info">
          <div class="song-title-row"><span class="song-title">${esc(song.title)}</span></div>
          <div class="song-artist">${esc(song.artist) || "&nbsp;"}</div>
          <div class="song-meta">
            <span class="key-badge">キー ${keyLabel(song.key)}</span>
            ${stars}${scoreB}${tags}${memo}
          </div>
        </div>
        <button class="sl-quick ${inSetlist(song.id) ? "on" : ""}" aria-label="セットリストへ">📋</button>`;
      card.onclick = () => openEdit(song.id);
      const q = card.querySelector(".sl-quick");
      q.onclick = (e) => {
        e.stopPropagation();
        toggleSetlist(song.id);
        q.classList.toggle("on", inSetlist(song.id));
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
    editTags = new Set(song ? song.tags || [] : []);
    editArtworkUrl = song ? song.artworkUrl || "" : "";
    editScores = song ? [...(song.scores || [])] : [];
    editSungCount = song ? song.sungCount || 0 : 0;
    editLastSungAt = song ? song.lastSungAt || 0 : 0;
    $("btnDelete").classList.toggle("hidden", !song);
    const slBtn = $("btnToggleSetlist");
    slBtn.classList.toggle("hidden", !song);
    if (song) updateSetlistBtn();
    hideSuggest();
    updateKeyView();
    updateRatingView();
    renderScoreSection();
    updateSungView();
    renderTagPicker();
    $("editModal").classList.remove("hidden");
    if (!song) setTimeout(() => $("inputTitle").focus(), 250);
  }

  function updateSetlistBtn() {
    $("btnToggleSetlist").textContent = inSetlist(editingId)
      ? "📋 セットリストから外す" : "📋 セットリストに追加";
  }

  function closeEdit() {
    $("editModal").classList.add("hidden");
    hideSuggest();
  }

  async function saveEdit() {
    const title = $("inputTitle").value.trim();
    if (!title) { toast("曲名を入力してください"); return; }
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
      memo: $("inputMemo").value.trim(),
      scores: editScores,
      sungCount: editSungCount,
      lastSungAt: editLastSungAt,
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
    setlist = setlist.filter(x => x.id !== song.id);
    saveSetlist();
    closeEdit();
    render();
    toast("削除しました");
  }

  // キー ステッパー
  function updateKeyView() {
    $("keyValue").textContent = keyLabel(editKey);
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

  function addScore() {
    const v = parseFloat($("inputScore").value);
    if (isNaN(v) || v < 0 || v > 100) { toast("0〜100の点数を入力してください"); return; }
    editScores.push({ score: Math.round(v * 10) / 10, date: Date.now() });
    $("inputScore").value = "";
    renderScoreSection();
  }

  // 歌唱記録
  function updateSungView() {
    $("sungInfo").textContent = editSungCount
      ? `${editSungCount}回（最終: ${fmtDate(editLastSungAt)}）`
      : "まだ記録なし";
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

  // ---------- iTunes サジェスト ----------
  function hideSuggest() {
    $("suggestBox").classList.add("hidden");
    $("suggestBox").innerHTML = "";
  }

  async function showSuggest(term) {
    const box = $("suggestBox");
    const results = await ITunes.search(term);
    if ($("inputTitle").value.trim() !== term) return; // 入力が変わっていたら破棄
    if (results.length === 0) { hideSuggest(); return; }
    box.innerHTML = "";
    results.forEach(r => {
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
      box.appendChild(item);
    });
    const note = document.createElement("div");
    note.className = "suggest-note";
    note.textContent = "iTunes検索の候補（そのまま手入力もOK）";
    box.appendChild(note);
    box.classList.remove("hidden");
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
    $("receiveInfo").textContent = `${list.length}曲が共有されました`;
    const box = $("receiveList");
    box.innerHTML = "";
    list.forEach(s => {
      const row = document.createElement("div");
      row.className = "receive-row";
      row.innerHTML = `<span class="receive-title">${esc(s.title)}</span><span class="receive-artist">${esc(s.artist)}</span>`;
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
      added.push({
        id: DB.newId(),
        title: String(s.title),
        artist: String(s.artist || ""),
        artworkUrl: String(s.artworkUrl || ""),
        tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
        key: Number(s.key) || 0,
        rating: Math.min(3, Math.max(0, Number(s.rating) || 0)),
        memo: String(s.memo || ""),
        scores: Array.isArray(s.scores)
          ? s.scores.filter(x => x && typeof x.score === "number").map(x => ({ score: x.score, date: Number(x.date) || now }))
          : [],
        sungCount: Number(s.sungCount) || 0,
        lastSungAt: Number(s.lastSungAt) || 0,
        createdAt: Number(s.createdAt) || now + i,
        updatedAt: now,
      });
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
    const sungTotal = songs.reduce((n, s) => n + (s.sungCount || 0), 0);
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
  $("tabSetlist").onclick = () => switchTab("setlist");

  $("btnClearDone").onclick = () => {
    setlist = setlist.filter(x => !x.done);
    saveSetlist();
    renderSetlist();
  };
  $("btnClearSetlist").onclick = () => {
    if (setlist.length && !confirm("セットリストを空にしますか？（歌唱記録は残ります）")) return;
    setlist = [];
    saveSetlist();
    renderSetlist();
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

  $("btnAddScore").onclick = addScore;
  $("inputScore").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addScore(); }
  });

  $("btnSungToday").onclick = () => {
    editSungCount++;
    editLastSungAt = Date.now();
    updateSungView();
    toast("保存すると記録されます");
  };

  $("btnToggleSetlist").onclick = () => {
    toggleSetlist(editingId);
    updateSetlistBtn();
    renderSetlistBadge();
    renderList();
  };

  $("btnAddTag").onclick = addNewTag;
  $("inputNewTag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNewTag(); }
  });

  $("inputTitle").addEventListener("input", (e) => {
    editArtworkUrl = "";
    clearTimeout(suggestTimer);
    const term = e.target.value.trim();
    if (term.length < 2) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => showSuggest(term), 350);
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
  DB.getAll().then(async (list) => {
    songs = list;
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
