// インポート・共有データの検証とサイズ制限（DOMに依存しない純粋ロジック）
const UtaLogData = (() => {
  const LIMITS = {
    importBytes: 5 * 1024 * 1024,
    shareBytes: 1024 * 1024,
    encodedShareChars: 2 * 1024 * 1024,
    songs: 5000,
    shareSongs: 1000,
    title: 200,
    artist: 200,
    artworkUrl: 2048,
    memo: 5000,
    tags: 30,
    tag: 60,
    scores: 10000,
    sungDates: 10000,
    setlists: 500,
    setlistItems: 5000,
    setlistName: 100,
    totalHistoryEntries: 100000,
    totalSetlistItems: 20000,
    exportBytes: 20 * 1024 * 1024,
  };

  function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}の形式が不正です`);
    }
  }

  function checkedString(value, label, max, required = false) {
    if (value === undefined || value === null) value = "";
    if (typeof value !== "string") throw new Error(`${label}は文字列である必要があります`);
    const result = value.trim();
    if (required && !result) throw new Error(`${label}が空です`);
    if (result.length > max) throw new Error(`${label}が${max}文字を超えています`);
    return result;
  }

  function checkedNumber(value, label, { min, max, integer = false, fallback } = {}) {
    if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}が数値ではありません`);
    if (integer && !Number.isInteger(value)) throw new Error(`${label}は整数である必要があります`);
    if (min !== undefined && value < min) throw new Error(`${label}が下限未満です`);
    if (max !== undefined && value > max) throw new Error(`${label}が上限を超えています`);
    return value;
  }

  function validateIncomingSongs(incoming, maxSongs = LIMITS.songs) {
    if (!Array.isArray(incoming)) throw new Error("曲リストの形式が違います");
    if (incoming.length > maxSongs) throw new Error(`曲数が上限（${maxSongs}曲）を超えています`);
    const now = Date.now();
    const validated = incoming.map((raw, index) => {
      const label = `${index + 1}曲目`;
      assertPlainObject(raw, label);
      const title = checkedString(raw.title, `${label}の曲名`, LIMITS.title, true);
      const artist = checkedString(raw.artist, `${label}の歌手名`, LIMITS.artist);
      const artworkUrl = checkedString(raw.artworkUrl, `${label}の画像URL`, LIMITS.artworkUrl);
      if (artworkUrl && !/^https?:\/\/[^\s"'<>\\]+$/i.test(artworkUrl)) {
        throw new Error(`${label}の画像URLはhttp(s)のみ使用できます`);
      }
      const rawTags = raw.tags === undefined ? [] : raw.tags;
      if (!Array.isArray(rawTags) || rawTags.length > LIMITS.tags) {
        throw new Error(`${label}のタグ数が上限（${LIMITS.tags}個）を超えています`);
      }
      const tags = [...new Set(rawTags.map((tag, tagIndex) =>
        checkedString(tag, `${label}のタグ${tagIndex + 1}`, LIMITS.tag, true)))];
      const key = checkedNumber(raw.key, `${label}のキー`, { min: -7, max: 7, integer: true, fallback: 0 });
      const rating = checkedNumber(raw.rating, `${label}の得意度`, { min: 0, max: 3, integer: true, fallback: 0 });
      const memo = checkedString(raw.memo, `${label}のメモ`, LIMITS.memo);

      const rawScores = raw.scores === undefined ? [] : raw.scores;
      if (!Array.isArray(rawScores) || rawScores.length > LIMITS.scores) {
        throw new Error(`${label}のスコア履歴が上限を超えています`);
      }
      const scores = rawScores.map((entry, scoreIndex) => {
        assertPlainObject(entry, `${label}のスコア${scoreIndex + 1}`);
        return {
          score: checkedNumber(entry.score, `${label}のスコア${scoreIndex + 1}`, { min: 0, max: 100 }),
          date: checkedNumber(entry.date, `${label}のスコア日`, { min: 1, fallback: now }),
        };
      });

      const rawDates = raw.sungDates === undefined ? [] : raw.sungDates;
      if (!Array.isArray(rawDates) || rawDates.length > LIMITS.sungDates) {
        throw new Error(`${label}の歌唱履歴が上限を超えています`);
      }
      let sungDates = rawDates.map((date, dateIndex) =>
        checkedNumber(date, `${label}の歌唱日${dateIndex + 1}`, { min: 1 }));
      if (!sungDates.length && raw.sungCount !== undefined) {
        const sungCount = checkedNumber(raw.sungCount, `${label}の歌唱回数`, {
          min: 0, max: LIMITS.sungDates, integer: true,
        });
        if (sungCount > 0) {
          const lastSungAt = raw.lastSungAt === undefined
            ? now
            : checkedNumber(raw.lastSungAt, `${label}の最終歌唱日`, { min: 1 });
          sungDates = Array(sungCount).fill(lastSungAt);
        }
      }
      sungDates.sort((a, b) => a - b);
      const createdAt = raw.createdAt === undefined
        ? now + index
        : checkedNumber(raw.createdAt, `${label}の作成日`, { min: 1 });
      const sourceId = raw.id === undefined ? "" : checkedString(raw.id, `${label}のID`, 128);
      return {
        sourceId,
        title,
        artist,
        artworkUrl,
        tags,
        key,
        rating,
        practicing: !!raw.practicing,
        memo,
        scores,
        sungDates,
        createdAt,
      };
    });
    const sourceIds = new Set();
    const totalHistory = validated.reduce((total, song) => total + song.scores.length + song.sungDates.length, 0);
    if (totalHistory > LIMITS.totalHistoryEntries) {
      throw new Error("履歴の合計件数が上限を超えています");
    }
    validated.forEach(song => {
      if (!song.sourceId) return;
      if (sourceIds.has(song.sourceId)) throw new Error("曲IDが重複しています");
      sourceIds.add(song.sourceId);
    });
    return validated;
  }

  function validateBackupSetlists(rawSetlists) {
    if (rawSetlists === undefined) return [];
    if (!Array.isArray(rawSetlists) || rawSetlists.length > LIMITS.setlists) {
      throw new Error("バックアップ内のセットリスト形式が不正です");
    }
    let totalItems = 0;
    return rawSetlists.map((raw, index) => {
      assertPlainObject(raw, `${index + 1}件目のセットリスト`);
      const name = checkedString(raw.name, `${index + 1}件目のセットリスト名`, LIMITS.setlistName, true);
      if (!Array.isArray(raw.items) || raw.items.length > LIMITS.setlistItems) {
        throw new Error(`「${name}」の曲数が上限を超えています`);
      }
      totalItems += raw.items.length;
      if (totalItems > LIMITS.totalSetlistItems) throw new Error("セットリストの合計曲数が上限を超えています");
      const items = raw.items.map((item, itemIndex) => {
        assertPlainObject(item, `「${name}」の${itemIndex + 1}曲目`);
        const next = {
          sourceId: checkedString(item.id, `「${name}」の曲ID`, 128, true),
          done: !!item.done,
        };
        if (Number.isFinite(item.sungAt) && item.sungAt > 0) next.sungAt = item.sungAt;
        return next;
      });
      return {
        name,
        createdAt: raw.createdAt === undefined
          ? Date.now() + index
          : checkedNumber(raw.createdAt, `「${name}」の作成日`, { min: 1 }),
        items,
      };
    });
  }

  async function readStreamLimited(stream, maxBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("共有データの展開後サイズが上限を超えています");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.byteLength; });
    return result;
  }

  return { LIMITS, validateIncomingSongs, validateBackupSetlists, readStreamLimited };
})();
