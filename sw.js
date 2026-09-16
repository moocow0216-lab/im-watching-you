// sw.js — 「我在看著你」的 Service Worker
// 唯一負責的事：收到後端 Worker 推播來的 push 事件時，即使 App 完全沒開、
// 也能叫瀏覽器/系統把通知顯示出來；以及使用者點通知時，把 App 拉到前景。
// 這個檔案本身不會去跑 Binance/訊號邏輯 —— 那些都在後端 Cloudflare Worker 裡跑，
// 這裡只是「顯示」通知的最後一哩路。

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: '我在看著你', body: '偵測到新訊號', tag: 'signal' };
  try {
    if (event.data) {
      const data = event.data.json();
      payload = { ...payload, ...data };
    }
  } catch (e) {
    // 如果後端傳的不是 JSON，就退回純文字當 body
    try { payload.body = event.data ? event.data.text() : payload.body; } catch (e2) {}
  }

  const options = {
    body: payload.body,
    tag: payload.tag,
    icon: 'icon-180.png',
    badge: 'icon-180.png',
    data: { url: './index.html' },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
