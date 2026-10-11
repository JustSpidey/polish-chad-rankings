/*
 * Codzienna Flash Sonda (GitHub Actions + Firebase Admin SDK).
 * Bierze sondę z flash-polls.json (rotacja po numerze dnia), przenosi poprzednią
 * sondę wraz z wynikami do flashPrev i ustawia nową w flash/current.
 * Jest idempotentny: jeśli sonda na dziś już jest - nic nie robi.
 * Nie nadpisuje sondy własnej właściciela (id zaczyna się od "c"), dopóki trwa.
 */
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const OPT = ['a', 'b', 'c', 'd'];

function validPoll(p) {
  if (!p || typeof p.e !== 'string' || !p.e || p.e.length > 8) return false;
  for (const lang of ['pl', 'en']) {
    const o = p[lang];
    if (!o || typeof o.q !== 'string' || !o.q || o.q.length > 140) return false;
    if (typeof o.a !== 'string' || typeof o.b !== 'string') return false;
    for (const k of OPT) if (o[k] !== undefined && (typeof o[k] !== 'string' || !o[k] || o[k].length > 60)) return false;
  }
  const keys = l => OPT.filter(k => p[l][k] !== undefined).join('');
  return keys('pl') === keys('en') && keys('pl').length >= 2;
}

function pickPoll(polls, dayNo) {
  const ok = polls.filter(validPoll);
  if (!ok.length) throw new Error('Brak poprawnych sond w flash-polls.json');
  return ok[dayNo % ok.length];
}

// Zwraca zapis (multi-path update) albo null, gdy nie ma nic do zrobienia.
function computeFlash(opts) {
  const { polls, now, current, counts, force } = opts;
  const dayNo = Math.floor(now / DAY);
  const id = 'p' + dayNo;
  if (!force && current && current.id === id) return { skip: 'Sonda na dziś (' + id + ') już jest.' };
  if (!force && current && /^c/.test(current.id) && Number(current.end) > now)
    return { skip: 'Trwa sonda właściciela (' + current.id + ') - nie nadpisuję.' };
  const p = pickPoll(polls, dayNo);
  const cur = { id, ts: now, end: now + 26 * 3600000, e: p.e, pl: p.pl, en: p.en };
  const updates = {};
  updates['flash/current'] = cur;
  if (current && current.id && current.id !== id) {
    const c = {};
    OPT.forEach(k => { if (current.pl && current.pl[k] !== undefined) c[k] = Number((counts || {})[k]) || 0; });
    updates['flashPrev'] = { id: current.id, e: current.e, pl: current.pl, en: current.en, counts: c, ts: now };
    updates['flashCounts/' + current.id] = null;
    updates['flashLog/' + current.id] = null;
  }
  return { updates, id };
}

async function main() {
  const polls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flash-polls.json'), 'utf8'));
  const dry = process.env.DRY_RUN === 'true', force = process.env.FORCE === 'true';
  const now = Date.now();
  const admin = require('firebase-admin');
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT, dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!sa || !dbUrl) throw new Error('Brak FIREBASE_SERVICE_ACCOUNT lub FIREBASE_DATABASE_URL.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)), databaseURL: dbUrl });
  const db = admin.database();
  const current = (await db.ref('flash/current').once('value')).val();
  const counts = current && current.id ? (await db.ref('flashCounts/' + current.id).once('value')).val() : null;
  const r = computeFlash({ polls, now, current, counts, force });
  if (r.skip) { console.log(r.skip); return; }
  console.log('Nowa sonda: ' + r.id + ' - ' + r.updates['flash/current'].pl.q);
  if (dry) { console.log('DRY_RUN - nic nie zapisano.\n' + JSON.stringify(r.updates, null, 2)); return; }
  await db.ref().update(r.updates);
  console.log('Zapisano.');
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
module.exports = { validPoll, pickPoll, computeFlash };
