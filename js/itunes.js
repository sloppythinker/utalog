// iTunes Search API（JSONP方式 — CORS制限を回避）
const ITunes = (() => {
  let seq = 0;
  let activeScript = null;

  function search(term, limit = 8) {
    return new Promise((resolve) => {
      if (!term.trim()) { resolve([]); return; }
      if (activeScript) {
        activeScript.remove();
        activeScript = null;
      }
      const cbName = "__itunesCb" + (++seq);
      const timer = setTimeout(() => cleanup([]), 6000);

      function cleanup(results) {
        clearTimeout(timer);
        delete window[cbName];
        if (activeScript) { activeScript.remove(); activeScript = null; }
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

      const url = "https://itunes.apple.com/search?" + new URLSearchParams({
        term, country: "JP", media: "music", entity: "song",
        limit: String(limit), lang: "ja_jp", callback: cbName,
      });
      const s = document.createElement("script");
      s.src = url;
      s.onerror = () => cleanup([]);
      activeScript = s;
      document.head.appendChild(s);
    });
  }

  return { search };
})();
