self.onmessage = (event) => {
  try {
    const { data, maxBytes } = event.data || {};
    const serialized = JSON.stringify(data, null, 2);
    const blob = new Blob([serialized], { type: "application/json" });
    if (blob.size > maxBytes) {
      throw new Error(`バックアップが上限（${maxBytes / 1024 / 1024}MB）を超えています`);
    }
    self.postMessage({ blob });
  } catch (error) {
    self.postMessage({ error: error && error.message ? error.message : "バックアップを生成できませんでした" });
  }
};
