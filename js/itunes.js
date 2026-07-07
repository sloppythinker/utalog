// 曲名・歌手名サジェスト検索
// 基本は iTunes Search API (fetch)。iPhone Safari はUA判定で musics:// へ
// リダイレクトされ失敗するため、失敗時は Deezer API (JSONP、UA判定なし) に
// フォールバックする。
const ITunes = (() => {
  let seq = 0;

  async function fetchJson(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 6000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function jsonp(url, ms) {
    return new Promise((resolve, reject) => {
      const cbName = "__dzCb" + (++seq);
      const s = document.createElement("script");
      let settled = false;
      const timer = setTimeout(() => done(null), ms || 8000);

      function done(data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[cbName];
        s.remove();
        if (data === null) reject(new Error("jsonp failed"));
        else resolve(data);
      }

      window[cbName] = (data) => done(data);
      s.src = url + "&output=jsonp&callback=" + cbName;
      s.onerror = () => done(null);
      document.head.appendChild(s);
    });
  }

  function itunesUrl(params) {
    return "https://itunes.apple.com/search?" + new URLSearchParams(
      Object.assign({ country: "JP", media: "music", lang: "ja_jp" }, params));
  }

  function mapItunesSong(r) {
    return {
      title: r.trackName || "",
      artist: r.artistName || "",
      artworkUrl: (r.artworkUrl100 || "").replace("100x100", "200x200"),
    };
  }

  // 曲名検索（曲名にマッチする候補。歌手名だけの一致は呼び出し側で除外）
  async function search(term, limit = 8) {
    if (!term.trim()) return [];
    try {
      const data = await fetchJson(itunesUrl({ term, entity: "song", limit: String(limit * 3) }));
      return (data.results || []).map(mapItunesSong).filter(r => r.title);
    } catch (e) { /* iPhone Safari等 */ }
    try {
      const data = await jsonp("https://api.deezer.com/search?" +
        new URLSearchParams({ q: term, limit: String(limit * 3) }));
      return (data.data || []).map(t => ({
        title: t.title || "",
        artist: (t.artist && t.artist.name) || "",
        artworkUrl: (t.album && (t.album.cover_medium || t.album.cover)) || "",
      })).filter(r => r.title);
    } catch (e) {
      return [];
    }
  }

  // 歌手名検索（歌手のみ返す。曲は返さない）
  async function searchArtists(term, limit = 6) {
    if (!term.trim()) return [];
    try {
      const data = await fetchJson(itunesUrl({ term, entity: "song", attribute: "artistTerm", limit: "25" }));
      const seen = new Set();
      const out = [];
      for (const r of data.results || []) {
        const name = r.artistName || "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, artworkUrl: (r.artworkUrl100 || "").replace("100x100", "200x200") });
        if (out.length >= limit) break;
      }
      return out;
    } catch (e) { /* iPhone Safari等 */ }
    try {
      const data = await jsonp("https://api.deezer.com/search/artist?" +
        new URLSearchParams({ q: term, limit: String(limit) }));
      return (data.data || []).map(a => ({
        name: a.name || "",
        artworkUrl: a.picture_medium || a.picture || "",
      })).filter(a => a.name);
    } catch (e) {
      return [];
    }
  }

  // 歌手名から画像を1枚取得（ジャケット or アーティスト写真）
  async function artistImage(name) {
    if (!name.trim()) return "";
    try {
      const data = await fetchJson(itunesUrl({ term: name, entity: "song", attribute: "artistTerm", limit: "1" }));
      const r = (data.results || [])[0];
      if (r && r.artworkUrl100) return r.artworkUrl100.replace("100x100", "200x200");
    } catch (e) { /* フォールバックへ */ }
    try {
      const data = await jsonp("https://api.deezer.com/search/artist?" +
        new URLSearchParams({ q: name, limit: "1" }), 5000);
      const a = (data.data || [])[0];
      if (a && (a.picture_medium || a.picture)) return a.picture_medium || a.picture;
    } catch (e) { /* あきらめる */ }
    return "";
  }

  return { search, searchArtists, artistImage };
})();
