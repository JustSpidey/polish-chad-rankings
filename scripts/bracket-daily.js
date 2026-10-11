/*
 * Automatyczne kończenie rund turnieju (GitHub Actions + Firebase Admin SDK).
 * Gdy czas rundy minął, liczy zwycięzców (więcej głosów; remis = wyższy numer rozstawienia,
 * czyli strona "a"), otwiera następną rundę albo wyłania mistrza i zapisuje go w bracketHistory.
 * Logika jest wycinana z index.html (między BRACKET-LOGIC-START/END), więc jest tylko jedna kopia.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLogic(html) {
  const s = html.indexOf('// BRACKET-LOGIC-START'), e = html.indexOf('// BRACKET-LOGIC-END');
  if (s < 0 || e < 0) throw new Error('Nie znaleziono BRACKET-LOGIC w index.html');
  const ctx = {};
  vm.runInNewContext(html.slice(s, e) + '\nthis.bracketNext = bracketNext; this.bracketStart = bracketStart;', ctx);
  return ctx;
}

// Zwraca { skip } albo { updates }.
function planAdvance(logic, cur, counts, now, force) {
  if (!cur || !cur.id) return { skip: 'Brak turnieju.' };
  if (cur.champion) return { skip: 'Turniej zakończony (mistrz: ' + cur.champion + ').' };
  if (!force && now < Number(cur.rEnd)) return { skip: 'Runda ' + cur.rd + ' jeszcze trwa.' };
  const r = logic.bracketNext(cur, counts, now);
  return { updates: r.updates, done: r.done, champion: r.champion };
}

async function main() {
  const dry = process.env.DRY_RUN === 'true', force = process.env.FORCE === 'true';
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const logic = loadLogic(html);
  const admin = require('firebase-admin');
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT, dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!sa || !dbUrl) throw new Error('Brak FIREBASE_SERVICE_ACCOUNT lub FIREBASE_DATABASE_URL.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)), databaseURL: dbUrl });
  const db = admin.database();
  const cur = (await db.ref('bracket/current').once('value')).val();
  const counts = cur && cur.id ? (await db.ref('bracketCounts/' + cur.id).once('value')).val() : null;
  const r = planAdvance(logic, cur, counts, Date.now(), force);
  if (r.skip) { console.log(r.skip); return; }
  console.log(r.done ? 'Finał rozstrzygnięty, mistrz: ' + r.champion : 'Otwieram następną rundę.');
  if (dry) { console.log('DRY_RUN\n' + JSON.stringify(r.updates, null, 2)); return; }
  await db.ref().update(r.updates);
  console.log('Zapisano.');
}
if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
module.exports = { loadLogic, planAdvance };
