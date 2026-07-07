// iTunes Search API（JSONP方式 — CORS制限を回避）
// 各リクエストは自己完結。連続入力時も互いに干渉しない（古い結果は呼び出し側で破棄）
const ITunes = (() => {
  let seq = 0;

  function search(term, limit = 8) {
    return new Promise((resolve) => {
      if (!term.trim()) { resolve([]); return; }
      const cbName = "__itunesCb" + (++seq);
      const s = document.createElement("script");
      let settled = false;
      const timer = setTimeout(() => cleanup([]), 8000);

      function cleanup(results) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[cbName];
        s.remove();
        resolve(results);
      }

      window[cbName] = (data) => {
        const results = (data.results || []).map(r => ({
          title: r.trackName || "",
          artist: r.artistName || "",
          artworkUrl: (r.artworkUrl100 || "").replace("100x100", "200x200"),
        })).filter(r => r.title);
        cleanup(results);
      };

      s.src = "https://itunes.apple.com/search?" + new URLSearchParams({
        term, country: "JP", media: "music", entity: "song",
        limit: String(limit), lang: "ja_jp", callback: cbName,
      });
      s.onerror = () => cleanup([]);
      document.head.appendChild(s);
    });
  }

  return { search };
})();
