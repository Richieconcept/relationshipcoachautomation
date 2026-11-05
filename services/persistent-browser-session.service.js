// Own one browser context for login and subsequent work, including concurrent opens.
export function persistentBrowserSession(launch) {
  let pending = null;
  return {
    get() {
      if (!pending) {
        const opening = Promise.resolve().then(launch);
        pending = opening;
        opening.then(context => {
          context.on('close', () => { if (pending === opening) pending = null; });
        }, () => { if (pending === opening) pending = null; });
      }
      return pending;
    },
    async close() {
      const closing = pending;
      if (!closing) return;
      try { const context = await closing; await context.close(); }
      finally { if (pending === closing) pending = null; }
    }
  };
}
