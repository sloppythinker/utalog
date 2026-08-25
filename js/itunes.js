// 曲名・歌手名サジェスト検索。
// 外部コードをページ権限で実行する JSONP は使わず、CORS 対応 API のみに限定する。
const ITunes = (() => {
  const CACHE_TTL = 10 * 60 * 1000;
  const cache = new Map();

  async function fetchJson(url, ms, externalSignal) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 6000);
    const abort = () => ctl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctl.abort();
      else externalSignal.addEventListener("abort", abort, { once: true });
    }
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", abort);
    }
  }

  async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    const value = await loader();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return value;
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
  async function search(term, limit = 8, options = {}) {
    if (!term.trim()) return [];
    const key = `song:${term.trim().toLowerCase()}:${limit}`;
    return cached(key, async () => {
    try {
      const data = await fetchJson(itunesUrl({ term, entity: "song", limit: String(limit * 3) }), 5000, options.signal);
      const out = (data.results || []).map(mapItunesSong).filter(r => r.title);
      if (out.length) return out;
    } catch (e) { /* iPhone Safari等 */ }
    if (options.signal && options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const data = await fetchJson("https://musicbrainz.org/ws/2/recording?" +
        new URLSearchParams({ query: term, fmt: "json", limit: String(limit * 3) }), 5000, options.signal);
      const seen = new Set();
      const out = [];
      for (const r of data.recordings || []) {
        const title = r.title || "";
        const artist = (r["artist-credit"] && r["artist-credit"][0] && r["artist-credit"][0].name) || "";
        if (!title) continue;
        const k = title + "\n" + artist;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ title, artist, artworkUrl: "" });
      }
      return out;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return [];
    }
    });
  }

  // 歌手名検索（歌手のみ返す。曲は返さない）
  async function searchArtists(term, limit = 6, options = {}) {
    if (!term.trim()) return [];
    const key = `artist:${term.trim().toLowerCase()}:${limit}`;
    return cached(key, async () => {
    try {
      const data = await fetchJson(itunesUrl({ term, entity: "song", attribute: "artistTerm", limit: "25" }), 5000, options.signal);
      const seen = new Set();
      const out = [];
      for (const r of data.results || []) {
        const name = r.artistName || "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, artworkUrl: (r.artworkUrl100 || "").replace("100x100", "200x200") });
        if (out.length >= limit) break;
      }
      if (out.length) return out;
    } catch (e) { /* iPhone Safari等 */ }
    if (options.signal && options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const data = await fetchJson("https://musicbrainz.org/ws/2/artist?" +
        new URLSearchParams({ query: term, fmt: "json", limit: String(limit) }), 5000, options.signal);
      return (data.artists || []).map(a => ({
        name: a.name || "",
        artworkUrl: "",
      })).filter(a => a.name);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return [];
    }
    });
  }

  // 歌手名から画像を1枚取得（ジャケット or アーティスト写真）
  async function artistImage(name, options = {}) {
    if (!name.trim()) return "";
    try {
      const data = await fetchJson(itunesUrl({ term: name, entity: "song", attribute: "artistTerm", limit: "1" }), 5000, options.signal);
      const r = (data.results || [])[0];
      if (r && r.artworkUrl100) return r.artworkUrl100.replace("100x100", "200x200");
    } catch (e) { /* フォールバックへ */ }
    return "";
  }

  return { search, searchArtists, artistImage };
})();
