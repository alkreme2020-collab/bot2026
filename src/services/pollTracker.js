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

  /** Remove all expired entries. */
  sweep() {
    const now = Date.now();
    for (const [phone, item] of recent.entries()) {
      if (now - item.ts > item.ttl) {
        recent.delete(phone);
      }
    }
  },
};

// Auto-sweep expired entries every 2 minutes
setInterval(() => recentPollSent.sweep(), 2 * 60 * 1000);
