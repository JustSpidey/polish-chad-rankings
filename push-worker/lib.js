// Logika wysyłki powiadomień push (bez zależności od Firebase, żeby dało się ją testować).
'use strict';

const BAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

const TEXT = {
  gu:     { pl: ['🔥 Nowy upvote', n => n + ' ocenił(a) Twój Glow-Up'],           en: ['🔥 New upvote', n => n + ' upvoted your Glow-Up'] },
  gc:     { pl: ['💬 Nowy komentarz', n => n + ' skomentował(a) Twój Glow-Up'],    en: ['💬 New comment', n => n + ' commented on your Glow-Up'] },
  req:    { pl: ['👋 Zaproszenie do znajomych', n => n + ' chce być Twoim znajomym'], en: ['👋 Friend request', n => n + ' wants to be your friend'] },
  dm:     { pl: ['✉️ Nowa wiadomość', n => 'Od: ' + n],                              en: ['✉️ New message', n => 'From: ' + n] },
  weekly: { pl: ['🗳️ Nowy ranking!', () => 'Nowy tydzień, nowy ranking. Wejdź i zagłosuj!'], en: ['🗳️ New ranking!', () => 'New week, new ranking. Come and vote!'] }
};
// kategoria powiadomienia -> ustawienie użytkownika (domyślnie włączone)
const PREF = { gu: 'glow', gc: 'glow', req: 'social', dm: 'social', weekly: 'weekly' };

function build(kind, lang, name) {
  const t = (TEXT[kind] || TEXT.weekly)[lang === 'en' ? 'en' : 'pl'];
  return { title: t[0], body: t[1](name || (lang === 'en' ? 'Someone' : 'Ktoś')) };
}

async function nickOf(db, uid) {
  if (!uid) return '';
  const v = (await db.ref('profiles/' + uid + '/nick').get()).val();
  return typeof v === 'string' ? v : '';
}

// Wysyła do wszystkich urządzeń jednego użytkownika. Zwraca liczbę wysłanych.
async function sendToUser(db, messaging, uid, kind, name, opts) {
  opts = opts || {};
  if ((await db.ref('deletedAcc/' + uid).get()).exists()) { await db.ref('pushTokens/' + uid).remove(); return 0; }
  const prefs = (await db.ref('pushPrefs/' + uid).get()).val() || {};
  if (prefs[PREF[kind]] === false) return 0;
  const tokens = (await db.ref('pushTokens/' + uid).get()).val() || {};
  return sendTokens(db, messaging, [[uid, tokens]], kind, name, opts);
}

async function sendTokens(db, messaging, perUser, kind, name, opts) {
  const url = (opts && opts.url) || '/';
  const jobs = []; // {uid, token, lang}
  perUser.forEach(function (pair) {
    const uid = pair[0], toks = pair[1] || {};
    Object.keys(toks).forEach(function (tok) { jobs.push({ uid: uid, token: tok, lang: (toks[tok] && toks[tok].lang) === 'en' ? 'en' : 'pl' }); });
  });
  let sent = 0;
  for (const lang of ['pl', 'en']) {
    const group = jobs.filter(function (j) { return j.lang === lang; });
    const msg = build(kind, lang, name);
    for (let i = 0; i < group.length; i += 500) {
      const chunk = group.slice(i, i + 500);
      const res = await messaging.sendEachForMulticast({
        tokens: chunk.map(function (j) { return j.token; }),
        data: { title: msg.title, body: msg.body, url: url, tag: kind },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } }
      });
      const dead = [];
      res.responses.forEach(function (r, idx) {
        if (r.success) sent++;
        else if (r.error && BAD_TOKEN.indexOf(r.error.code) >= 0) dead.push(chunk[idx]);
      });
      if (dead.length) {
        const upd = {};
        dead.forEach(function (j) { upd['pushTokens/' + j.uid + '/' + j.token] = null; });
        await db.ref().update(upd);
      }
    }
  }
  return sent;
}

// Powiadomienie ogólne: nowy ranking do wszystkich, którzy nie wyłączyli „weekly".
async function broadcastWeekly(db, messaging) {
  const all = (await db.ref('pushTokens').get()).val() || {};
  const prefs = (await db.ref('pushPrefs').get()).val() || {};
  const deleted = (await db.ref('deletedAcc').get()).val() || {};
  const perUser = Object.keys(all).filter(function (u) { return !deleted[u] && !(prefs[u] && prefs[u].weekly === false); })
    .map(function (u) { return [u, all[u]]; });
  return sendTokens(db, messaging, perUser, 'weekly', '', {});
}

module.exports = { build, nickOf, sendToUser, sendTokens, broadcastWeekly, TEXT, PREF };
