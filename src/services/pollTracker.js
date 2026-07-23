const recent = new Map();

export const recentPollSent = {
  record(phone, values, ttlMs = 5000) {
    recent.set(phone, {
      values: [...new Set(values.map(v => String(v).trim()))],
      ts: Date.now(),
      ttl: ttlMs
    });
  },

  /** @returns {{values:string[], ts:number, ttl:number}|undefined} */
  get(phone) {
    const item = recent.get(phone);
    if (!item) return undefined;
    if (Date.now() - item.ts > item.ttl) {
      recent.delete(phone);
      return undefined;
    }
    return item;
  },

  clear(phone) {
    recent.delete(phone);
  },
};
