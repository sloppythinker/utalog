(() => {
  const { LIMITS, validateIncomingSongs, validateBackupSetlists } = UtaLogData;
  const tests = [];

  function test(name, fn) { tests.push({ name, fn }); }
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function assertThrows(fn, message) {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    assert(threw, message);
  }

  test("空の歌唱履歴を持つ新規曲を受け入れる", () => {
    const song = validateIncomingSongs([
      { id: "s1", title: "  Test  ", sungDates: [], sungCount: 0, lastSungAt: 0 },
    ])[0];
    assert(song.title === "Test", "曲名がtrimされていない");
    assert(song.sungDates.length === 0, "空の歌唱履歴が変化した");
  });

  test("歌唱履歴を昇順へ正規化する", () => {
    const song = validateIncomingSongs([{ title: "Test", sungDates: [30, 10, 20] }])[0];
    assert(song.sungDates.join(",") === "10,20,30", "歌唱履歴が昇順ではない");
  });

  test("過大な旧形式の歌唱回数を拒否する", () => {
    assertThrows(
      () => validateIncomingSongs([{ title: "Test", sungCount: LIMITS.sungDates + 1 }]),
      "過大なsungCountを受け入れた",
    );
  });

  test("キー範囲外を拒否する", () => {
    assertThrows(
      () => validateIncomingSongs([{ title: "Test", key: 8 }]),
      "範囲外のキーを受け入れた",
    );
  });

  test("曲ID重複を拒否する", () => {
    assertThrows(
      () => validateIncomingSongs([{ id: "same", title: "A" }, { id: "same", title: "B" }]),
      "重複IDを受け入れた",
    );
  });

  test("バックアップのセットリスト参照を正規化する", () => {
    const list = validateBackupSetlists([
      { name: "確認", createdAt: 1, items: [{ id: "s1", done: true, sungAt: 2 }] },
    ])[0];
    assert(list.items[0].sourceId === "s1", "曲IDを保持できていない");
    assert(list.items[0].sungAt === 2, "歌唱記録との関連を保持できていない");
  });

  test("全曲合計の履歴上限を拒否する", () => {
    const dates = Array(LIMITS.sungDates).fill(1);
    const songs = Array.from({ length: 11 }, (_, i) => ({ title: `song-${i}`, sungDates: dates }));
    assertThrows(
      () => validateIncomingSongs(songs),
      "合計履歴上限を超えたデータを受け入れた",
    );
  });

  test("セットリスト項目の合計上限を拒否する", () => {
    const item = { id: "s1" };
    const perList = Math.floor(LIMITS.totalSetlistItems / 5) + 1;
    const lists = Array.from({ length: 5 }, (_, i) => ({
      name: `list-${i}`,
      items: Array(perList).fill(item),
    }));
    assertThrows(() => validateBackupSetlists(lists), "合計項目上限を超えたデータを受け入れた");
  });

  const lines = [];
  let failed = 0;
  tests.forEach(({ name, fn }) => {
    try {
      fn();
      lines.push(`✓ ${name}`);
    } catch (error) {
      failed++;
      lines.push(`✗ ${name}: ${error.message}`);
    }
  });
  lines.push(`\n${tests.length - failed}/${tests.length} tests passed`);
  document.getElementById("result").textContent = lines.join("\n");
  document.title = failed ? "FAIL - うたログ Data Tests" : "PASS - うたログ Data Tests";
  if (failed) throw new Error(`${failed} tests failed`);
})();
