import type { Plugin } from 'vite'

/** Keep the loaded development build stable until the user explicitly reloads. */
export function manualUpdates(): Plugin {
  return {
    name: 'machitsumugi-manual-updates',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [{
          tag: 'script',
          injectTo: 'head-prepend',
          children: `(() => {
  const NativeWebSocket = window.WebSocket;
  const updateEvent = 'machitsumugi:update-available';
  let pending = false;
  const notify = () => {
    pending = true;
    window.dispatchEvent(new Event(updateEvent));
  };
  window.addEventListener('machitsumugi:check-for-update', () => {
    if (pending) window.dispatchEvent(new Event(updateEvent));
  });
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const protocolList = Array.isArray(protocols) ? protocols : [protocols];
      if (!protocolList.includes('vite-hmr')) return;
      // Register before Vite's listeners. Other WebSocket traffic is untouched.
      this.addEventListener('message', event => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        const changes = ['update', 'full-reload', 'prune', 'bundled-dev-update'];
        const sourceNotice = payload.type === 'custom' &&
          ['machitsumugi:source-changed', updateEvent].includes(payload.event);
        if (changes.includes(payload.type) || sourceNotice) {
          event.stopImmediatePropagation();
          notify();
        }
      }, true);
      // Vite normally polls and reloads after a disconnect, including a restart.
      this.addEventListener('close', event => {
        event.stopImmediatePropagation();
        notify();
      }, true);
    }
  };
})();`,
        }]
      },
    },
  }
}
