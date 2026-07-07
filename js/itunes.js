// 曲名サジェスト検索
// 1) iTunes Search API (fetch)。iPhone Safari はUA判定で musics:// へ
//    リダイレクトされ失敗するため、失敗時は 2) Deezer API (JSONP) に
//    フォールバックする（DeezerはUA判定なし・スマホでも動く）。
const ITunes = (() => {
  let seq = 0;

  async function searchItunes(term, limit) {
    const url = "https://itunes.apple.com/search?" + new URLSearchParams({
      term, country: "JP", media: "music", entity: "song",
      limit: String(limit), lang: "ja_jp",
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return (data.results || []).map(r => ({
        title: r.trackName || "",
        artist: r.artistName || "",
        artworkUrl: (r.artworkUrl100 || "").replace("100x100", "200x200"),
      })).filter(r => r.title);
    } finally {
      clearTimeout(timer);
    }
  }

  function searchDeezer(term, limit) {
    return new Promise((resolve, reject) => {
      const cbName = "__dzCb" + (++seq);
      const s = document.createElement("script");
      let settled = false;
      const timer = setTimeout(() => done(null), 8000);

      function done(data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[cbName];
        s.remove();
        if (data === null) reject(new Error("deezer failed"));
        else resolve(data);
      }

      window[cbName] = (data) => done(data);
      s.src = "https://api.deezer.com/search?" + new URLSearchParams({
        q: term, limit: String(limit), output: "jsonp", callback: cbName,
      });
      s.onerror = () => done(null);
      document.head.appendChild(s);
    }).then(data => (data.data || []).map(t => ({
      title: t.title || "",
      artist: (t.artist && t.artist.name) || "",
      artworkUrl: (t.album && (t.album.cover_medium || t.album.cover)) || "",
    })).filter(r => r.title));
  }

  async function search(term, limit = 8) {
    if (!term.trim()) return [];
    try {
      return await searchItunes(term, limit);
    } catch (e) { /* iPhone Safari等ではここに来る */ }
    try {
      return await searchDeezer(term, limit);
    } catch (e) {
      return [];
    }
  }

  return { search };
})();
