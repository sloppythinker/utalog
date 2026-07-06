(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- 状態 ----------
  let songs = [];
  let searchQuery = "";
  let activeTags = new Set();
  let sortMode = "new";

  // 編集モーダルの状態
  let editingId = null;   // null = 新規
  let editKey = 0;
  let editRating = 0;
  let editTags = new Set();
  let editArtworkUrl = "";
  let suggestTimer = null;

  // ---------- ユーティリティ ----------
  function keyLabel(k) {
    if (!k) return "原曲";
    return k > 0 ? `+${k}` : `${k}`;
  }

  function norm(s) {
    return (s || "").toLowerCase().replace(/[ぁ-ゖ]/g,
      ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
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
      const tags = (song.tags || []).map(t => `<span class="mini-tag">${esc(t)}</span>`).join("");
      const memo = song.memo ? `<span class="memo-mark">📝</span>` : "";
      card.innerHTML = `
        ${art}
        <div class="song-info">
          <div class="song-title-row"><span class="song-title">${esc(song.title)}</span></div>
          <div class="song-artist">${esc(song.artist) || "&nbsp;"}</div>
          <div class="song-meta">
            <span class="key-badge">キー ${keyLabel(song.key)}</span>
            ${stars}${tags}${memo}
          </div>
        </div>`;
      card.onclick = () => openEdit(song.id);
      box.appendChild(card);
    });
  }

  function render() {
    renderTagFilter();
    renderList();
  }

  // ---------- 曲追加・編集モーダル ----------
  function openEdit(id) {
    editingId = id || null;
    const song = id ? songs.find(s => s.id === id) : null;
    $("editModalTitle").textContent = song ? "曲を編集" : "曲を追加";
    $("inputTitle").value = song ? song.title : "";
    $("inputArtist").value = song ? song.artist || "" : "";
    $("inputMemo").value = song ? song.memo || "" : "";
    editKey = song ? song.key || 0 : 0;
    editRating = song ? song.rating || 0 : 0;
    editTags = new Set(song ? song.tags || [] : []);
    editArtworkUrl = song ? song.artworkUrl || "" : "";
    $("btnDelete").classList.toggle("hidden", !song);
    hideSuggest();
    updateKeyView();
    updateRatingView();
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

  // ---------- 設定 ----------
  function openSettings() {
    const tagCount = allTags().length;
    $("statsText").textContent = `登録曲数: ${songs.length}曲 ／ タグ: ${tagCount}個`;
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
          createdAt: Number(s.createdAt) || now + i,
          updatedAt: now,
        });
      });
      if (added.length) {
        await DB.bulkPut(added);
        songs.push(...added);
      }
      render();
      openSettings();
      toast(`${added.length}曲をインポートしました（重複${incoming.length - added.length}件スキップ）`);
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

  // ---------- 起動 ----------
  DB.getAll().then(list => {
    songs = list;
    render();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
