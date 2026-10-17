// Wysyłka powiadomień push z GitHub Actions (bez Cloud Functions, bez planu Blaze).
// Uruchamiany co kilka minut: czyta nowe wpisy z bazy i wysyła je przez Firebase Cloud Messaging.
'use strict';
const lib = require('./lib');

async function run(db, msg) {
  const get = async p => (await db.ref(p).get()).val() || null;
  const st = (await get('pushState')) || {};
  const notifs = (await get('notifs')) || {};
  const reqs = (await get('friendReq')) || {};
  const dms = (await get('dmIdx')) || {};
  const weekId = await get('weekId');

  const items = []; // {kind, to, from, t}
  Object.keys(notifs).forEach(uid => Object.keys(notifs[uid] || {}).forEach(id => {
    const n = notifs[uid][id] || {};
    if ((n.type === 'gu' || n.type === 'gc') && typeof n.t === 'number') items.push({ kind: n.type, to: uid, from: n.from, t: n.t, c: 'n' });
  }));
  Object.keys(reqs).forEach(to => Object.keys(reqs[to] || {}).forEach(from => {
    const r = reqs[to][from] || {};
    if (typeof r.t === 'number') items.push({ kind: 'req', to: to, from: from, t: r.t, c: 'r' });
  }));
  Object.keys(dms).forEach(u => Object.keys(dms[u] || {}).forEach(o => {
    const d = dms[u][o] || {};
    if (d.seen === false && typeof d.t === 'number') items.push({ kind: 'dm', to: u, from: o, t: d.t, c: 'd' });
  }));

  const cur = { n: Number(st.n) || 0, r: Number(st.r) || 0, d: Number(st.d) || 0 };
  const next = Object.assign({}, cur);
  items.forEach(i => { if (i.t > next[i.c]) next[i.c] = i.t; });

  let sent = 0, weekly = 0;
  if (st.init) {
    for (const i of items) {
      if (i.t <= cur[i.c]) continue;
      try { sent += await lib.sendToUser(db, msg, i.to, i.kind, await lib.nickOf(db, i.from)); }
      catch (e) { console.error('send failed', i.kind, i.to, e && e.message); }
    }
    if (weekId && st.weekId && weekId !== st.weekId) {
      try { weekly = await lib.broadcastWeekly(db, msg); } catch (e) { console.error('weekly failed', e && e.message); }
    }
  } // pierwszy przebieg tylko ustawia punkt startowy, niczego nie wysyła
  await db.ref('pushState').set({ init: true, n: next.n, r: next.r, d: next.d, weekId: weekId || null, run: Date.now() });
  return { sent: sent, weekly: weekly, first: !st.init };
}

module.exports = { run };

if (require.main === module) {
  (async () => {
    const admin = require('firebase-admin');
    const key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(key), databaseURL: process.env.DATABASE_URL });
    const r = await run(admin.database(), admin.messaging());
    console.log('push worker:', JSON.stringify(r));
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
