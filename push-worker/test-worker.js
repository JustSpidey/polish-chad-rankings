const w = require('./push-worker');
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); };
function fakeDb(tree) {
  const parts = p => p.split('/').filter(Boolean);
  const get = p => parts(p).reduce((v, k) => (v == null ? v : v[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; ks.slice(0, -1).forEach(k => { o = o[k] = o[k] || {}; }); if (v === null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = v; };
  return { tree, ref: p => ({ get: async () => { const v = get(p); return { val: () => (v === undefined ? null : v), exists: () => v !== undefined && v !== null }; }, set: async v => set(p, v), remove: async () => set(p, null), update: async u => Object.keys(u).forEach(k => set(k, u[k])) }) };
}
const msg = () => { const calls = []; return { calls, sendEachForMulticast: async m => { calls.push(m); return { responses: m.tokens.map(() => ({ success: true })) }; } }; };
(async () => {
  const db = fakeDb({ profiles: { a: { nick: 'Ala' }, b: { nick: 'Bob' } }, weekId: 'w5',
    pushTokens: { u1: { TOKEN_AAAAAAAAAAAAAAAAAAAA: { lang: 'pl' } }, u2: { TOKEN_BBBBBBBBBBBBBBBBBBBB: { lang: 'en' } } },
    notifs: { u1: { u_g_a: { type: 'gu', from: 'a', gid: 'g', t: 100 } } }, friendReq: { u2: { b: { t: 110 } } }, dmIdx: { u1: { a: { t: 120, seen: false } } } });
  let m = msg(); let r = await w.run(db, m);
  ok('first run: nothing sent, cursors set', r.first && m.calls.length === 0 && db.tree.pushState.init && db.tree.pushState.n === 100 && db.tree.pushState.r === 110 && db.tree.pushState.d === 120 && db.tree.pushState.weekId === 'w5');
  m = msg(); r = await w.run(db, m);
  ok('second run without news: nothing', m.calls.length === 0 && r.sent === 0);
  db.tree.notifs.u1.c_x = { type: 'gc', from: 'b', gid: 'g', cid: 'x', t: 200 };
  db.tree.notifs.u1.u_g_a.t = 100;
  db.tree.friendReq.u2.a = { t: 210 };
  db.tree.dmIdx.u1.b = { t: 220, seen: false };
  db.tree.dmIdx.u1.a = { t: 120, seen: true };
  m = msg(); r = await w.run(db, m);
  const titles = m.calls.map(c => c.data.title + '|' + c.data.body);
  ok('3 new items sent', r.sent === 3 && m.calls.length === 3);
  ok('texts', titles.some(t => t.includes('Nowy komentarz') && t.includes('Bob')) && titles.some(t => t.includes('Friend request') && t.includes('Ala')) && titles.some(t => t.includes('Nowa wiadomość') && t.includes('Bob')));
  m = msg(); r = await w.run(db, m);
  ok('no duplicates on next run', m.calls.length === 0);
  db.tree.dmIdx.u1.b = { t: 300, seen: true };
  m = msg(); await w.run(db, m); ok('seen dm not pushed', m.calls.length === 0);
  db.tree.weekId = 'w6';
  m = msg(); r = await w.run(db, m);
  ok('new week -> broadcast to both languages', r.weekly === 2 && m.calls.length === 2 && db.tree.pushState.weekId === 'w6');
  m = msg(); await w.run(db, m); ok('week broadcast only once', m.calls.length === 0);
  db.tree.notifs.u9 = { x: { type: 'gu', from: 'a', gid: 'g', t: 999 } };
  m = msg(); r = await w.run(db, m); ok('user without tokens: no send, no crash', r.sent === 0);
  console.log('worker', pass, 'pass', fail, 'fail'); process.exit(fail ? 1 : 0);
})();
