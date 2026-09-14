// 曲名・歌手名サジェスト検索。
// 外部コードをページ権限で実行する JSONP は使わず、CORS 対応 API のみに限定する。
const ITunes = (() => {
  const CACHE_TTL = 10 * 60 * 1000;
  const cache = new Map();
  let musicBrainzQueue = Promise.resolve();
  let lastMusicBrainzRequest = -Infinity;

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
  }

  // 曲名・歌手名検索を合わせて1秒に1回までにする。
  function musicBrainzJson(url, signal) {
    const request = musicBrainzQueue.then(async () => {
      checkAbort(signal);
      const wait = Math.max(0, 1100 - (performance.now() - lastMusicBrainzRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      checkAbort(signal);
      lastMusicBrainzRequest = performance.now();
      return fetchJson(url, 6000, signal);
    });
    musicBrainzQueue = request.catch(() => {});
    return request;
  }

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
    } catch (error) {
      checkAbort(externalSignal);
      if (ctl.signal.aborted) throw new DOMException("検索がタイムアウトしました", "TimeoutError");
      throw error;
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

  // 曲名検索（呼び出し側で曲名一致を優先し、関連候補も表示する）
  async function search(term, limit = 8, options = {}) {
    checkAbort(options.signal);
    if (!term.trim()) return [];
    const key = `song:${term.trim().toLowerCase()}:${limit}`;
    return cached(key, async () => {
      let responded = false;
      try {
        const data = await fetchJson(itunesUrl({ term, entity: "song", limit: String(limit * 3) }), 5000, options.signal);
        if (!Array.isArray(data.results)) throw new Error("検索結果の形式が不正です");
        responded = true;
        const out = (data.results || []).map(mapItunesSong).filter(r => r.title);
        if (out.length) return out;
      } catch (e) { /* 通信失敗・タイムアウト時は予備の検索先へ */ }
      checkAbort(options.signal);
      try {
        const data = await musicBrainzJson("https://musicbrainz.org/ws/2/recording?" +
          new URLSearchParams({ query: term, fmt: "json", limit: String(limit * 3) }), options.signal);
        if (!Array.isArray(data.recordings)) throw new Error("検索結果の形式が不正です");
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
        checkAbort(options.signal);
        if (responded) return [];
        throw new Error("候補を取得できませんでした。通信状態を確認して再検索してください。");
      }
    });
  }

  // 歌手名検索（歌手のみ返す。曲は返さない）
  async function searchArtists(term, limit = 6, options = {}) {
    checkAbort(options.signal);
    if (!term.trim()) return [];
    const key = `artist:${term.trim().toLowerCase()}:${limit}`;
    return cached(key, async () => {
      let responded = false;
      try {
        const data = await fetchJson(itunesUrl({ term, entity: "song", attribute: "artistTerm", limit: "25" }), 5000, options.signal);
        if (!Array.isArray(data.results)) throw new Error("検索結果の形式が不正です");
        responded = true;
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
      } catch (e) { /* 通信失敗・タイムアウト時は予備の検索先へ */ }
      checkAbort(options.signal);
      try {
        const data = await musicBrainzJson("https://musicbrainz.org/ws/2/artist?" +
          new URLSearchParams({ query: term, fmt: "json", limit: String(limit) }), options.signal);
        if (!Array.isArray(data.artists)) throw new Error("検索結果の形式が不正です");
        return (data.artists || []).map(a => ({
          name: a.name || "",
          artworkUrl: "",
        })).filter(a => a.name);
      } catch (e) {
        checkAbort(options.signal);
        if (responded) return [];
        throw new Error("候補を取得できませんでした。通信状態を確認して再検索してください。");
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
