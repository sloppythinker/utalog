// 曲名・歌手名サジェスト検索。
// 外部コードをページ権限で実行する JSONP は使わず、CORS 対応 API のみに限定する。
const ITunes = (() => {
  const CACHE_TTL = 10 * 60 * 1000;
  const cache = new Map();
  const artworkCache = new Map();
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
    // 空の候補は保存しない。通信回復後の同じ入力でも必ず検索し直す。
    if (value.length) cache.set(key, { at: Date.now(), value });
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

  function coverUrls(recording) {
    const urls = [];
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    for (const release of recording.releases || []) {
      if (uuid.test(release.id || "")) urls.push(`https://coverartarchive.org/release/${release.id}/front-250`);
      const group = release["release-group"];
      if (group && uuid.test(group.id || "")) urls.push(`https://coverartarchive.org/release-group/${group.id}/front-250`);
    }
    return [...new Set(urls)].slice(0, 3);
  }

  function mapRecording(r) {
    const artworkUrls = coverUrls(r);
    return {
      title: r.title || "",
      artist: (r["artist-credit"] && r["artist-credit"][0] && r["artist-credit"][0].name) || "",
      artworkUrl: artworkUrls[0] || "",
      artworkUrls,
    };
  }

  // 曲名検索（呼び出し側で曲名一致を優先し、関連候補も表示する）
  async function search(term, limit = 8, options = {}) {
    checkAbort(options.signal);
    if (!term.trim()) return [];
    const key = `${options.artistOnly ? "artist-songs" : "song"}:${term.trim().toLowerCase()}:${limit}`;
    return cached(key, async () => {
      let responded = false;
      try {
        const params = { term, entity: "song", limit: String(limit * 3) };
        if (options.artistOnly) params.attribute = "artistTerm";
        const data = await fetchJson(itunesUrl(params), 5000, options.signal);
        if (!Array.isArray(data.results)) throw new Error("検索結果の形式が不正です");
        responded = true;
        const out = (data.results || []).map(mapItunesSong).filter(r => r.title &&
          (!options.artistOnly || imageName(r.artist).includes(imageName(term))));
        if (out.length) return out;
      } catch (e) { /* 通信失敗・タイムアウト時は予備の検索先へ */ }
      checkAbort(options.signal);
      try {
        // 複数語の従来検索も残し、歌手名だけの入力にはartist検索を追加する。
        const query = options.artistOnly ? `artist:${quoted(term)}`
          : `(${term}) OR artist:${quoted(term)}`;
        const data = await musicBrainzJson("https://musicbrainz.org/ws/2/recording?" +
          new URLSearchParams({ query, fmt: "json", limit: String(limit * 3) }), options.signal);
        if (!Array.isArray(data.recordings)) throw new Error("検索結果の形式が不正です");
        const seen = new Set();
        const out = [];
        for (const r of data.recordings || []) {
          const title = r.title || "";
          const artist = (r["artist-credit"] && r["artist-credit"][0] && r["artist-credit"][0].name) || "";
          if (!title) continue;
          if (options.artistOnly && !imageName(artist).includes(imageName(term))) continue;
          const k = title + "\n" + artist;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(mapRecording(r));
        }
        if (!out.length && !responded) throw new Error("主検索が失敗しています");
        return out;
      } catch (e) {
        checkAbort(options.signal);
        // 片方だけの空応答では「該当なし」と断定できない。再検索を可能にする。
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
        const out = (data.artists || []).map(a => ({
          name: a.name || "",
          artworkUrl: "",
        })).filter(a => a.name);
        if (!out.length && !responded) throw new Error("主検索が失敗しています");
        return out;
      } catch (e) {
        checkAbort(options.signal);
        throw new Error("候補を取得できませんでした。通信状態を確認して再検索してください。");
      }
    });
  }

  function imageAvailable(url, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const image = new Image();
      const finish = (ok, error) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (signal) signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(ok);
      };
      const abort = () => finish(false, new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(false), 4000);
      image.onload = () => finish(image.naturalWidth > 0);
      image.onerror = () => finish(false);
      if (signal) signal.addEventListener("abort", abort, { once: true });
      image.src = url;
    });
  }

  const imageName = value => (value || "").normalize("NFKC").toLowerCase().replace(/\s/g, "");
  const quoted = value => '"' + value.replace(/[\\"]/g, "\\$&") + '"';

  // 曲名と歌手名を照合し、実際に読み込める画像だけを保存する。
  async function songImage(title, artist, options = {}) {
    checkAbort(options.signal);
    if (!title.trim() && !artist.trim()) return "";
    const key = imageName(title) + "\n" + imageName(artist);
    const hit = artworkCache.get(key);
    if (hit && hit !== options.excludeUrl) return hit;
    const matches = row => (!title || imageName(row.title) === imageName(title)) &&
      (!artist || imageName(row.artist) === imageName(artist));
    const choose = async rows => {
      const urls = [...new Set(rows.filter(matches).flatMap(row => row.artworkUrls || [row.artworkUrl]))]
        .filter(url => url && url !== options.excludeUrl).slice(0, 3);
      for (const url of urls) {
        checkAbort(options.signal);
        if (await imageAvailable(url, options.signal)) {
          artworkCache.set(key, url);
          if (artworkCache.size > 50) artworkCache.delete(artworkCache.keys().next().value);
          return url;
        }
      }
      return "";
    };
    try {
      const params = { term: [artist, title].filter(Boolean).join(" "), entity: "song", limit: "12" };
      if (!title) params.attribute = "artistTerm";
      const data = await fetchJson(itunesUrl(params), 5000, options.signal);
      const url = await choose((data.results || []).map(mapItunesSong));
      if (url) return url;
    } catch (e) { /* フォールバックへ */ }
    checkAbort(options.signal);
    try {
      const query = [title && `recording:${quoted(title)}`, artist && `artist:${quoted(artist)}`].filter(Boolean).join(" AND ");
      const data = await musicBrainzJson("https://musicbrainz.org/ws/2/recording?" +
        new URLSearchParams({ query, fmt: "json", limit: "5" }), options.signal);
      return await choose((data.recordings || []).map(mapRecording));
    } catch (e) { checkAbort(options.signal); }
    return "";
  }

  function artistImage(name, options = {}) { return songImage("", name, options); }
  function searchByArtist(name, limit = 8, options = {}) {
    return search(name, limit, { ...options, artistOnly: true });
  }

  return { search, searchByArtist, searchArtists, artistImage, songImage };
})();
