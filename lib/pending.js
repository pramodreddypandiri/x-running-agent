const { loadJSON, saveJSON } = require('./storage');

function makePendingStore(filePath) {
  function load() { return loadJSON(filePath, {}); }
  function save(state) { saveJSON(filePath, state); }

  return {
    set(id, data) {
      const state = load();
      state[id] = { ...data, createdAt: data.createdAt || Date.now() };
      save(state);
    },
    get(id) {
      return load()[id];
    },
    delete(id) {
      const state = load();
      if (state[id]) {
        delete state[id];
        save(state);
      }
    },
    entries() {
      return Object.entries(load());
    },
    update(id, mutator) {
      const state = load();
      if (!state[id]) return false;
      const next = mutator(state[id]);
      state[id] = next || state[id];
      save(state);
      return true;
    },
    findByPredicate(pred) {
      return Object.entries(load()).find(([, v]) => pred(v));
    },
    gc(ttlMs) {
      const state = load();
      const now = Date.now();
      let removed = 0;
      for (const [id, data] of Object.entries(state)) {
        if (data.createdAt && now - data.createdAt > ttlMs) {
          delete state[id];
          removed++;
        }
      }
      if (removed > 0) save(state);
      return removed;
    },
  };
}

module.exports = { makePendingStore };
