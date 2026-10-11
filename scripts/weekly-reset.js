/*
 * Automatyczny tygodniowy reset rankingu (GitHub Actions + Firebase Admin SDK).
 * Robi to samo co przycisk "Resetuj ranking" na stronie: sortuje po głosach, liczy
 * trendy i aurę, zapisuje archiwum i zeruje głosy - jednym atomowym zapisem.
 *
 * Dane osób (imiona, pozycje startowe) i stałe aury są czytane z ../index.html,
 * więc nie ma drugiej kopii do pilnowania.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REVEAL_IDS = ['chad_16', 'chad_17', 'chad_18', 'chad_19', 'chad_20'];
const TZ = 'Europe/Warsaw';

// ---------- odczyt index.html ----------
function extractChads(html) {
  const start = html.indexOf('const chadsData = [');
  if (start < 0) throw new Error('Nie znaleziono chadsData w index.html');
  const open = html.indexOf('[', start);
  let depth = 0, quote = null, end = -1;
  for (let k = open; k < html.length; k++) {
    const c = html[k];
    if (quote) { if (c === '\\') { k++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '[') depth++;
    if (c === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error('Nie udało się wyciąć tablicy chadsData');
  return vm.runInNewContext('(' + html.slice(open, end + 1) + ')');
}
function extractConsts(html) {
  const num = (name, def) => {
    const m = html.match(new RegExp('\\b' + name + '\\s*=\\s*([0-9.]+)'));
    return m ? Number(m[1]) : def;
  };
  return {
    AURA_START: num('AURA_START', 50),
    AURA_PER_RANK: num('AURA_PER_RANK', 2),
    DUEL_AURA_STEP: num('DUEL_AURA_STEP', 0.1),
    DUEL_AURA_CAP: num('DUEL_AURA_CAP', 5)
  };
}

// ---------- czas (Warszawa) ----------
function warsawParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short'
  });
  const o = {};
  f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hour: Number(o.hour) % 24, dow };
}
const pad = n => String(n).padStart(2, '0');
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
// Klucz tygodnia w tym samym formacie co getWeekIdentifier() na stronie (najbliższa niedziela).
function weekKey(now) {
  const w = warsawParts(now);
  const sun = addDays(w.y, w.m, w.d, (7 - w.dow) % 7);
  return 'WEEK_' + sun.y + '_' + pad(sun.m) + '_' + pad(sun.d);
}
// Miesiąc, do którego należy właśnie zakończony tydzień (poniedziałek rano -> niedziela).
function monthKey(now) {
  const w = warsawParts(now);
  const day = w.dow === 1 ? addDays(w.y, w.m, w.d, -1) : { y: w.y, m: w.m, d: w.d };
  return day.y + '-' + pad(day.m);
}
const round1 = x => Math.round(x * 10) / 10;
const weekNum = k => { const n = parseInt(String(k).replace(/^w/, ''), 10); return isNaN(n) ? null : n; };

// ---------- logika resetu (czysta funkcja, bez dostępu do bazy) ----------
function scoreTips(tips, res) {
  const uids = Object.keys(tips || {}), total = uids.length, out = {};
  const KEYS = ['top', 'riser', 'faller'];
  const cnt = { top: {}, riser: {}, faller: {} };
  uids.forEach(function(u) {
    const t = tips[u] || {};
    KEYS.forEach(function(k) { if (typeof t[k] === 'string') cnt[k][t[k]] = (cnt[k][t[k]] || 0) + 1; });
  });
  uids.forEach(function(u) {
    const t = tips[u] || {};
    const r = { pts: 0, top: 0, riser: 0, faller: 0, picks: {} };
    KEYS.forEach(function(k) {
      if (typeof t[k] !== 'string') return;
      r.picks[k] = t[k];
      const win = k === 'top' ? (res.top ? [res.top] : []) : (res[k] || []);
      if (win.indexOf(t[k]) >= 0) {
        r[k] = 1;
        r.pts += Math.min(40, Math.max(10, Math.round(10 * total / cnt[k][t[k]])));
      }
    });
    out[u] = r;
  });
  return out;
}
function tipResults(ids, oldRanks, newRankings, wasLocked, topId) {
  const changes = {};
  let mx = -Infinity, mn = Infinity;
  ids.forEach(function(id) {
    if (wasLocked[id]) return;
    const ch = oldRanks[id] - newRankings[id];
    changes[id] = ch;
    if (ch > mx) mx = ch;
    if (ch < mn) mn = ch;
  });
  const res = { top: topId || null, riser: [], faller: [] };
  Object.keys(changes).forEach(function(id) {
    if (mx > 0 && changes[id] === mx) res.riser.push(id);
    if (mn < 0 && changes[id] === mn) res.faller.push(id);
  });
  return res;
}
function compactResult(res) {
  const o = { top: res.top };
  if (res.riser.length) o.riser = res.riser;
  if (res.faller.length) o.faller = res.faller;
  return o;
}
function tipUpdates(scored, board, nickOf, newWeekId, upd) {
  Object.keys(scored).forEach(function(u) {
    const r = scored[u], prev = board[u] || {};
    upd['tipBoard/' + u] = {
      nick: String(nickOf(u) || prev.nick || 'user').slice(0, 40),
      pts: (Number(prev.pts) || 0) + r.pts,
      rounds: (Number(prev.rounds) || 0) + 1,
      hits: (Number(prev.hits) || 0) + r.top + r.riser + r.faller
    };
    upd['tipLast/' + u] = { w: newWeekId, pts: r.pts, top: r.top, riser: r.riser, faller: r.faller, picks: r.picks };
  });
}

function computeReset(chadsData, state, consts, now, tsValue) {
  const { AURA_START, AURA_PER_RANK, DUEL_AURA_STEP, DUEL_AURA_CAP } = consts;
  const revealed = state.revealed16to20 === true;
  const savedRanks = state.rankings || {};
  const votesNow = state.votes || {}, duel = state.duelStats || {}, auraNow = state.aura || {};
  const tipsNow = state.tips || {}, board = state.tipBoard || {}, profiles = state.profiles || {};
  const oldW = state.weekId || 'w0';

  const chads = chadsData.map(c => ({
    id: c.id,
    name: c.name,
    oldRank: savedRanks[c.id] !== undefined ? Number(savedRanks[c.id]) : c.rank,
    wasLocked: !!c.locked && !(revealed && REVEAL_IDS.includes(c.id))
  }));
  const voteOf = id => {
    const v = votesNow[id];
    return typeof v === 'number' ? v : (Number(v && v.votes) || 0);
  };
  const active = chads.filter(c => c.name && String(c.name).trim() !== '');
  active.sort((a, b) => (voteOf(b.id) - voteOf(a.id)) || (a.oldRank - b.oldRank));

  const newRankings = {}, prevRankings = {}, deltas = {}, newAura = {}, votesMap = {};
  const oldRanks = {}, wasLocked = {};
  active.forEach((c, i) => {
    const newRank = i + 1;
    newRankings[c.id] = newRank;
    oldRanks[c.id] = c.oldRank;
    wasLocked[c.id] = c.wasLocked;
    const wl = duel[c.id] || {};
    const duelNet = (Number(wl.w) || 0) - (Number(wl.l) || 0);
    const duelAura = Math.max(-DUEL_AURA_CAP, Math.min(DUEL_AURA_CAP, round1(duelNet * DUEL_AURA_STEP)));
    const moves = c.wasLocked ? 0 : c.oldRank - newRank;
    const delta = c.wasLocked ? 0 : round1(moves * AURA_PER_RANK + duelAura);
    const base = typeof auraNow[c.id] === 'number' ? auraNow[c.id] : AURA_START;
    newAura[c.id] = Math.max(0, round1(base + delta));
    deltas[c.id] = delta;
    if (!c.wasLocked) prevRankings[c.id] = c.oldRank;
    const v = voteOf(c.id);
    if (v > 0) votesMap[c.id] = v;
  });

  const topId = active.length ? active[0].id : null;
  const n = (weekNum(state.weekId || 'w0') || 0) + 1;
  const newWeekId = 'w' + n;
  const hist = { n, ts: tsValue, month: monthKey(now), ranks: newRankings, deltas };
  if (topId && voteOf(topId) > 0) { hist.winner = topId; hist.winnerVotes = voteOf(topId); }
  if (Object.keys(votesMap).length) hist.votes = votesMap;

  const updates = {
    rankings: newRankings,
    prevRankings,
    aura: newAura,
    weekId: newWeekId,
    weekNo: n,
    currentWeek: weekKey(now),
    resetVersion: now.getTime(),
    revealed16to20: true,
    votes: null,
    duelStats: null
  };
  // Typer: punkty liczone tylko wtedy, gdy w tej rundzie w ogóle padły głosy.
  let result = null;
  if (topId && Object.keys(votesMap).length) {
    const res = tipResults(active.map(c => c.id), oldRanks, newRankings, wasLocked, topId);
    result = compactResult(res);
    hist.result = result;
    tipUpdates(scoreTips(tipsNow, res), board, u => (profiles[u] || {}).nick, newWeekId, updates);
  }
  updates['tips/' + oldW] = null;
  updates['history/' + newWeekId] = hist;
  return { updates, summary: { newWeekId, winner: hist.winner || null, deltas, newRankings, result } };
}

// ---------- uruchomienie ----------
async function main() {
  const dry = process.env.DRY_RUN === 'true';
  const force = process.env.FORCE === 'true';
  const now = new Date();
  const w = warsawParts(now);
  console.log('Czas w Warszawie: ' + w.y + '-' + pad(w.m) + '-' + pad(w.d) + ' godz. ' + w.hour + ' (dzień tyg. ' + w.dow + ')');

  // Zadania cron odpalają się kilka razy (zmiana czasu, opóźnienia GitHuba) - działamy tylko w poniedziałek rano.
  if (!force && !(w.dow === 1 && w.hour < 6)) {
    console.log('Nie jest poniedziałkowy poranek w Warszawie - pomijam (to normalne przy podwójnym harmonogramie).');
    return;
  }

  const admin = require('firebase-admin');
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!sa || !dbUrl) throw new Error('Brak FIREBASE_SERVICE_ACCOUNT lub FIREBASE_DATABASE_URL.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)), databaseURL: dbUrl });
  const db = admin.database();

  const names = ['votes', 'duelStats', 'aura', 'weekId', 'rankings', 'revealed16to20', 'history', 'tipBoard', 'profiles'];
  const snaps = await Promise.all(names.map(n => db.ref(n).once('value')));
  const state = {};
  names.forEach((n, i) => { state[n] = snaps[i].val(); });
  state.tips = (await db.ref('tips/' + (state.weekId || 'w0')).once('value')).val() || {};

  // Ochrona przed podwójnym resetem (np. gdy właściciel kliknął przycisk wcześniej).
  const lastTs = Math.max(0, ...Object.values(state.history || {}).map(h => Number(h && h.ts) || 0));
  const ageDays = (now.getTime() - lastTs) / 86400000;
  if (!force && lastTs && ageDays < 5.5) {
    console.log('Ostatni reset był ' + ageDays.toFixed(1) + ' dnia temu - pomijam, żeby nie zresetować dwa razy.');
    return;
  }

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { updates, summary } = computeReset(extractChads(html), state, extractConsts(html), now, admin.database.ServerValue.TIMESTAMP);

  console.log('Nowy tydzień: ' + summary.newWeekId + ', zwycięzca: ' + (summary.winner || '(brak głosów)'));
  console.log('Nowe pozycje: ' + JSON.stringify(summary.newRankings));
  console.log('Zmiany aury: ' + JSON.stringify(summary.deltas));
  if (dry) { console.log('DRY RUN - nic nie zapisano.'); return; }

  await db.ref().update(updates);
  console.log('Reset zapisany.');
}

module.exports = { computeReset, extractChads, extractConsts, weekKey, monthKey, warsawParts };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('BŁĄD:', err.message); process.exit(1); });
}
