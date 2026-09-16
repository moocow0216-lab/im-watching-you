import { buildPushPayload } from '@block65/webcrypto-web-push';
import { loadSignalSnapshot, buildCategories, sigFingerprint } from './engine.js';

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

function assertEnv() {
  const missing = ['WORKER_URL', 'ADMIN_TOKEN', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error('缺少環境變數（GitHub Actions Secrets 沒設定好）: ' + missing.join(', '));
  }
}

async function fetchBackendData() {
  const res = await fetch(`${WORKER_URL}/internal/data`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error('拿取後端資料失敗: HTTP ' + res.status);
  return res.json();
}

async function saveBackendState(state) {
  const res = await fetch(`${WORKER_URL}/internal/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error('寫回後端狀態失敗: HTTP ' + res.status);
}

async function removeDeadSubscription(endpoint) {
  try {
    await fetch(`${WORKER_URL}/internal/remove-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ endpoint }),
    });
  } catch (e) {
    console.error('清除失效訂閱失敗', endpoint, e.message);
  }
}

async function sendPush(subscription, { title, body, tag }) {
  const vapid = { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  const message = { data: JSON.stringify({ title, body, tag }), options: { ttl: 300 } };
  try {
    const payload = await buildPushPayload(message, subscription, vapid);
    const res = await fetch(subscription.endpoint, payload);
    console.log(`推播 -> ${title} (${subscription.endpoint.slice(0, 60)}...) 狀態 ${res.status}`);
    if (res.status === 404 || res.status === 410) {
      await removeDeadSubscription(subscription.endpoint);
    }
  } catch (e) {
    console.error('sendPush failed', subscription.endpoint, e.message);
  }
}

async function main() {
  assertEnv();

  const { subscriptions, state } = await fetchBackendData();
  console.log(`目前訂閱數: ${subscriptions.length}`);

  const symbolSet = new Set();
  subscriptions.forEach(s => (s.coins || []).forEach(c => symbolSet.add(c)));
  console.log(`需要檢查的幣種: ${[...symbolSet].join(', ') || '（無，還沒有人訂閱）'}`);

  const newState = { ...state };

  for (const symbol of symbolSet) {
    let snap;
    try {
      snap = await loadSignalSnapshot(symbol);
    } catch (e) {
      console.error('loadSignalSnapshot failed', symbol, e.message);
      continue;
    }

    const newCats = buildCategories(snap);
    const prevCats = state[symbol] || null;
    newState[symbol] = newCats;

    if (!prevCats) {
      console.log(`${symbol}: 第一次看到，建立基準值`);
      continue;
    }

    for (let i = 0; i < newCats.length; i++) {
      const cat = newCats[i];
      const oldCat = prevCats[i];
      if (!oldCat) continue;

      const newFp = cat.sigs.map(sigFingerprint).join('|');
      const oldFp = oldCat.sigs.map(sigFingerprint).join('|');
      if (newFp === oldFp) continue;

      let changedSig = null;
      for (let k = 0; k < cat.sigs.length; k++) {
        if (sigFingerprint(cat.sigs[k]) !== sigFingerprint(oldCat.sigs[k]) && cat.sigs[k]) {
          changedSig = cat.sigs[k];
          break;
        }
      }
      if (!changedSig || cat.lines.length === 0) continue;

      const coinName = symbol.replace('USDT', '');
      const title = `${coinName} · ${cat.name}`;
      const body = cat.lines.join(' ／ ');
      const tag = `${symbol}:${cat.name}`;
      console.log(`發現新訊號 -> ${title}: ${body}`);

      const targets = subscriptions.filter(s => (s.coins || []).includes(symbol));
      for (const target of targets) {
        await sendPush(target.subscription, { title, body, tag });
      }
    }
  }

  await saveBackendState(newState);
  console.log('完成，狀態已寫回後端。');
}

main().catch(e => {
  console.error('check-signals 執行失敗:', e);
  process.exit(1);
});
