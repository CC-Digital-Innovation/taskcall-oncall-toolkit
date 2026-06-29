// Tests for the pure logic in src/engine.js. No deps; run with `node tests/run.js` or `npm test`.
// The engine installs window.TC inside an IIFE, so we eval it in a vm sandbox with the page
// globals stubbed, then poke at the pure helpers it exposes on window.TC._test plus a few
// public functions that don't need the live TaskCall page.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
// Minimal stand-in for TaskCall's prepareFinalSchedule, faithful where the resolver's edges depend on it:
// one shift per day in [startDate, startDate+days) per BASE layer, at its rotation_start for shift_length
// (overnight shifts cross midnight; DST falls out of JS local-time arithmetic exactly as the real one does).
// It does NOT emit a shift that started before startDate as a pre-start interval — the property the engine's
// edge handling relies on. Exception layers are ignored (these fixtures use base layers only).
function schedStub(startDate, days, layers) {
  const base = (layers || []).filter(L => !L.is_exception), out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    const wd = (day.getDay() + 6) % 7;
    for (const L of base) {
      if ((L.skip_days || []).indexOf(wd) >= 0) continue;
      const steps = L.rotations || []; if (!steps.length) continue;
      const vsS = String(L.valid_start || '').slice(0, 10);
      const vs = vsS ? new Date(+vsS.slice(0, 4), +vsS.slice(5, 7) - 1, +vsS.slice(8, 10)) : day;
      const since = Math.round((day - vs) / 86400000), freq = L.rotation_frequency || 1;
      const idx = ((Math.floor(since / freq) % steps.length) + steps.length) % steps.length;
      const roster = (steps[idx] || []).filter(u => u && u !== 'no-one');
      if (!roster.length) continue;
      const hp = String(L.rotation_start || '00:00:00').split(':').map(Number);
      const lp = String(L.shift_length || '24:00').split(':').map(Number);
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hp[0] || 0, hp[1] || 0);
      const e = new Date(s.getTime()); e.setHours(e.getHours() + (lp[0] || 0), e.getMinutes() + (lp[1] || 0));
      out.push({ rotation_start: s, rotation_end: e, on_call: roster.slice() });
    }
  }
  return [out];
}
const sandbox = {
  window: {}, document: {}, navigator: {},
  location: { href: 'https://app.us.taskcallapp.com/configurations/routines' },
  fetch: () => Promise.reject(new Error('no network in tests')),
  csrfToken: '',
  prepareFinalSchedule: schedStub,
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'engine.js' });
const TC = sandbox.window.TC;
const t = TC && TC._test;

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + name); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name + ' (got ' + g + ', want ' + w + ')', g === w);
}

// engine loaded and exposed its API
ok('window.TC exists', !!TC);
ok('test hook present', !!t);
ok('has oncall + routines API', TC && !!TC.oncall && !!TC.routines);

// date string <-> Date
eq('_dstr formats local date', t._dstr(new Date(2026, 6, 3)), '2026-07-03');
const pd = t._pd('2026-07-03');
ok('_pd parses to local Y/M/D', pd.getFullYear() === 2026 && pd.getMonth() === 6 && pd.getDate() === 3);
eq('_dstr(_pd()) round-trips', t._dstr(t._pd('2026-12-09')), '2026-12-09');

// day arithmetic, including month rollover
eq('_addDays simple', t._addDays('2026-07-03', 1), '2026-07-04');
eq('_addDays across month end', t._addDays('2026-07-31', 1), '2026-08-01');
eq('_addDays across year end', t._addDays('2026-12-31', 1), '2027-01-01');
eq('_daysBetween basic', t._daysBetween('2026-07-01', '2026-07-03'), 2);

// DST robustness: these are the cases the engine cares about. US spring-forward is 2026-03-08,
// fall-back is 2026-11-01. Calendar day count must stay 2 even though wall-elapsed is 47h / 49h.
eq('_daysBetween spans spring-forward', t._daysBetween('2026-03-07', '2026-03-09'), 2);
eq('_daysBetween spans fall-back', t._daysBetween('2026-10-31', '2026-11-02'), 2);
eq('_addDays across spring-forward', t._addDays('2026-03-07', 2), '2026-03-09');

// wall-clock minutes and HH:MM
eq('_wm of 09:30', t._wm(new Date(2026, 6, 3, 9, 30)), 570);
eq('_hhmm of 570', t._hhmm(570), '09:30');
eq('_hhmm of 1440', t._hhmm(1440), '24:00');

// shift-length parsing and the >24h guard the engine enforces before writing
eq('_slmin 08:30', t._slmin('08:30'), 510);
eq('_slmin 24:00', t._slmin('24:00'), 1440);
eq('_slmin empty', t._slmin(''), 0);
eq('_MAXSHIFT is 24:00 in minutes', t._MAXSHIFT, 1440);
ok('24:00 is allowed by the guard', t._slmin('24:00') <= t._MAXSHIFT);
ok('30:00 is rejected by the guard', t._slmin('30:00') > t._MAXSHIFT);

// python-style weekday (Mon=0..Sun=6), used for skip_days. 2026-07-03 is a Friday => 4.
eq('_pywd Friday', t._pywd('2026-07-03'), 4);
eq('_pywd Sunday', t._pywd('2026-07-05'), 6);
eq('_pywd Monday', t._pywd('2026-07-06'), 0);

// set equality used when coalescing same-roster bands
ok('_setEq order-insensitive', t._setEq(['a', 'b'], ['b', 'a']));
ok('_setEq detects difference', !t._setEq(['a'], ['a', 'b']));

// public, page-independent helpers
eq('rotate makes one step per person', TC.routines.rotate(['a', 'b', 'c']), [['a'], ['b'], ['c']]);
const L = TC.routines.layer([['a', 'b']], { layer_name: 'X' });
ok('layer sets name', L.layer_name === 'X');
ok('layer defaults shift_length', L.shift_length === '24:00');
ok('layer carries rotations', JSON.stringify(L.rotations) === JSON.stringify([['a', 'b']]));

// ---- Temporal-boundary regression matrix ----
// US DST 2026: spring-forward 03-08 (23h day), fall-back 11-01 (25h day).
const meta = { routine_name: 'T', timezone: 'America/New_York' };
const layer = (o) => Object.assign({ layer: 1, layer_name: 'L1', valid_start: '2026-06-01', valid_end: '9999-01-01', is_exception: false, rotation_start: '00:00:00', shift_length: '24:00', rotation_frequency: 1, skip_days: [], rotations: [['alice']] }, o);
const day = (res, d) => (res.slots[0].days.find(x => x.date === d) || {});

// #3 — fall-back DST day must TERMINATE (was an infinite loop + OOM) and yield one full-day segment.
const dst = TC.oncall.slotsFromLayers(meta, [layer({})], { from: '2026-11-01', to: '2026-11-01' });
ok('#3 slotsFromLayers terminates on the 25h fall-back day', !!dst);
const nov1 = day(dst, '2026-11-01').segs || [];
eq('#3 fall-back day is one full 0..24 segment', [nov1.length, Math.round((nov1[0] || {}).s), Math.round((nov1[0] || {}).e)], [1, 0, 24]);

// #12 — bar geometry is wall-clock (08:00->20:00 reads s=8,e=20) on BOTH DST days, not elapsed-ms.
const gf = (day(TC.oncall.slotsFromLayers(meta, [layer({ rotation_start: '08:00:00', shift_length: '12:00' })], { from: '2026-11-01', to: '2026-11-01' }), '2026-11-01').segs || [])[0] || {};
eq('#12 fall-back 08:00-20:00 bar reads s=8 e=20', [Math.round(gf.s), Math.round(gf.e)], [8, 20]);
const gs = (day(TC.oncall.slotsFromLayers(meta, [layer({ rotation_start: '08:00:00', shift_length: '12:00' })], { from: '2026-03-08', to: '2026-03-08' }), '2026-03-08').segs || [])[0] || {};
eq('#12 spring-forward 08:00-20:00 bar reads s=8 e=20', [Math.round(gs.s), Math.round(gs.e)], [8, 20]);

// #4 — _cleanLayer coerces an open-ended valid_end (null/'') to 9999-01-01, never the string "null".
eq('#4 _cleanLayer valid_end:null -> 9999-01-01', t._cleanLayer(layer({ valid_end: null })).valid_end, '9999-01-01');
eq('#4 _cleanLayer valid_end:"" -> 9999-01-01', t._cleanLayer(layer({ valid_end: '' })).valid_end, '9999-01-01');

// #8 — a daytime + adjacent long-overnight slice with the SAME roster must NOT coalesce into a >24:00 tile
// (the server rejects shift_length>24:00, which silently aborts the whole save).
const D8 = (h, m, dn) => new Date(2026, 6, dn, h, m || 0);
const ap8 = [{ alias: 'ovr1' }];
const tiles8 = t._coalesceTiles([
  { date: '2026-07-06', start: D8(6, 0, 6), end: D8(18, 0, 6), roster: ['sub'], applied: ap8 },   // 06:00-18:00
  { date: '2026-07-06', start: D8(18, 0, 6), end: D8(12, 0, 7), roster: ['sub'], applied: ap8 },  // 18:00 -> next 12:00 (18h)
]);
ok('#8 coalesce never emits a tile > 24:00', tiles8.every(tl => t._slmin(tl.shift_length) <= t._MAXSHIFT));

// ---- authoritative-SET interval algebra (unit) ----
eq('_atWall 13:00 is 13h local', t._atWall('2026-08-10', 13 * 60).getHours(), 13);
eq('_atWall 1440 carries to next midnight', [t._dstr(t._atWall('2026-08-10', 1440)), t._atWall('2026-08-10', 1440).getHours()], ['2026-08-11', 0]);
const cov = t._setCover('2026-08-10', '2026-08-10', '08:00:00', '04:00', []);
eq('_setCover partial-day -> one [08:00,12:00) interval', [cov.length, new Date(cov[0][0]).getHours(), new Date(cov[0][1]).getHours()], [1, 8, 12]);
const ovn = t._setCover('2026-08-09', '2026-08-09', '18:00:00', '12:00', []);
eq('_setCover overnight crosses midnight to 06:00 next day', [t._dstr(new Date(ovn[0][1])), new Date(ovn[0][1]).getHours()], ['2026-08-10', 6]);
eq('_setCover honors skip_days', t._setCover('2026-08-10', '2026-08-10', '00:00:00', '24:00', [(t._pd('2026-08-10').getDay() + 6) % 7]).length, 0);
const day0 = +t._pd('2026-08-10'), h = (n) => day0 + n * 3600000;
const segs = t._subIv(h(0), h(24), [[h(13), h(15)]]);
eq('_subIv carves a 13-15 hole -> 00-13 + 15-24', [segs.length, (segs[0][1] - segs[0][0]) / 3600000, (segs[1][1] - segs[1][0]) / 3600000], [2, 13, 9]);
eq('_subIv full cover -> empty', t._subIv(h(8), h(12), [[h(0), h(24)]]).length, 0);
ok('_hitsIv detects an overnight tail bleeding into a day', t._hitsIv(h(-1), h(1), [[h(0), h(24)]]));
ok('_hitsIv: disjoint bands miss', !t._hitsIv(h(8), h(12), [[h(13), h(17)]]));
const bk = t._bakedSet('set9', h(17), h(24), ['briar']);
eq('_bakedSet -> SET tile dated by start, wall-clock length', [bk.is_exception, (bk.layer_name || '').slice(0, 4), bk.rotation_start, bk.shift_length, bk.valid_start], [true, 'SET:', '17:00:00', '07:00', '2026-08-10']);

// ---- a FAITHFUL prepareFinalSchedule stub: suppress base under exceptions, then exceptions UNION (verified below
// to reproduce 9 live-resolver probes exactly). Lets the engine's setRoster/swap be driven end-to-end in node. ----
function schedFaithful(startDate, days, layers) {
  const exc = [], baseSh = [];
  // Start ONE day early so an overnight shift begun the evening before the window emits its post-midnight tail into
  // the window (the real prepareFinalSchedule looks back and clips it to the window start; _resolveIvs clips the rest).
  for (let i = -1; i < days; i++) {
    const dd = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i), dStr = t._dstr(dd), wd = (dd.getDay() + 6) % 7;
    for (const L of (layers || [])) {
      if ((L.skip_days || []).indexOf(wd) >= 0) continue;
      const vs = String(L.valid_start || '').slice(0, 10), ve = String(L.valid_end || '9999-01-01').slice(0, 10);
      if (vs && dStr < vs) continue; if (ve && dStr >= ve) continue;
      const steps = L.rotations || []; if (!steps.length) continue;
      const since = vs ? Math.round((dd - t._pd(vs)) / 86400000) : 0, freq = L.rotation_frequency || 1;
      const idx = (((Math.floor(since / freq)) % steps.length) + steps.length) % steps.length;
      const roster = (steps[idx] || []).filter(u => u && u !== 'no-one'); if (!roster.length) continue;
      const RS = t._slmin(String(L.rotation_start || '00:00:00').slice(0, 5)), SL = t._slmin(L.shift_length || '24:00');
      const s = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate(), Math.floor(RS / 60), RS % 60);
      const e = new Date(s.getTime()); e.setMinutes(e.getMinutes() + SL);
      (L.is_exception ? exc : baseSh).push({ rotation_start: s, rotation_end: e, on_call: roster.slice() });
    }
  }
  const cuts = exc.map(x => [+x.rotation_start, +x.rotation_end]), out = exc.slice();
  baseSh.forEach(b => t._subIv(+b.rotation_start, +b.rotation_end, cuts).forEach(([a, c]) => out.push({ rotation_start: new Date(a), rotation_end: new Date(c), on_call: b.on_call.slice() })));
  return [out];
}
const atF = (layers, Y, Mo, Da, hh, mm) => { const ts = +new Date(Y, Mo - 1, Da, hh, mm || 0); const raw = (schedFaithful(new Date(Y, Mo - 1, Da - 1), 3, layers)[0] || []).filter(iv => iv.on_call && iv.on_call.length).map(iv => ({ s: +new Date(iv.rotation_start), e: +new Date(iv.rotation_end), on: iv.on_call })); const S = new Set(); raw.forEach(iv => { if (iv.s <= ts && ts < iv.e) iv.on.forEach(u => { if (u !== 'no-one') S.add(u); }); }); return [...S].sort().join(',') || '-'; };
const _base = (o) => Object.assign({ layer: 1, layer_name: 'Lane', valid_start: '2026-06-01', valid_end: '9999-01-01', is_exception: false, rotation_frequency: 1, skip_days: [], shift_length: '24:00', rotation_start: '00:00:00', rotations: [['vesper']] }, o);
const _exc = (name, from, to, roster, o) => Object.assign({ layer: 2, layer_name: name, valid_start: from, valid_end: t._addDays(to, 1), is_exception: true, rotation_frequency: 1, skip_days: [], shift_length: '24:00', rotation_start: '00:00:00', rotations: [roster] }, o || {});
// stub must reproduce the real resolver: exception suppresses base WITHIN its band; concurrent exceptions UNION.
eq('stub: exception suppresses base at noon', atF([_base({}), _exc('OVR:x', '2026-08-10', '2026-08-10', ['briar'])], 2026, 8, 10, 12), 'briar');
eq('stub: two overlapping exceptions UNION', atF([_base({}), _exc('SET:a', '2026-08-10', '2026-08-10', ['orin']), _exc('OVR:x', '2026-08-10', '2026-08-10', ['briar'])], 2026, 8, 10, 12), 'briar,orin');
eq('stub: partial-day exception, base outside band', [atF([_base({}), _exc('SET:a', '2026-08-10', '2026-08-10', ['orin'], { rotation_start: '08:00:00', shift_length: '04:00' })], 2026, 8, 10, 9), atF([_base({}), _exc('SET:a', '2026-08-10', '2026-08-10', ['orin'], { rotation_start: '08:00:00', shift_length: '04:00' })], 2026, 8, 10, 14)], ['orin', 'vesper']);
eq('stub: overnight exception tail suppresses base 00-06', [atF([_base({}), _exc('SET:a', '2026-08-09', '2026-08-09', ['orin'], { rotation_start: '18:00:00', shift_length: '12:00' })], 2026, 8, 10, 3), atF([_base({}), _exc('SET:a', '2026-08-09', '2026-08-09', ['orin'], { rotation_start: '18:00:00', shift_length: '12:00' })], 2026, 8, 10, 7)], ['orin', 'vesper']);

// no two exception tiles overlap in covered time (the invariant the SET-carve must preserve)
function noOverlap(layers) { const ivs = []; (layers || []).filter(L => L.is_exception).forEach(L => t._setCover(String(L.valid_start).slice(0, 10), t._addDays(String(L.valid_end).slice(0, 10), -1), L.rotation_start, L.shift_length, L.skip_days || []).forEach(iv => ivs.push(iv))); ivs.sort((a, b) => a[0] - b[0]); for (let i = 1; i < ivs.length; i++) if (ivs[i][0] < ivs[i - 1][1]) return false; return true; }
// fetch stub so _findRoutine/_save are driven in node; dryRun returns previewLayers without saving.
function setRoutine(layers, users) { const ref = 'RREF', name = 'Z', routine = { routine_ref_id: ref, routine_name: name, timezone: 'America/New_York', routine_layers: layers }; sandbox.fetch = async (p) => { let pl; if (p === '/configurations/list?param=users') pl = (users === undefined ? [['No One', 'no-one']] : users); else if (p === '/configurations/routines') pl = [{ routine_ref_id: ref, routine_name: name }]; else if (p === '/configurations/routines/' + ref) pl = routine; else pl = { ok: true }; return { status: 200, text: async () => JSON.stringify(pl), json: async () => pl }; }; }

// ---- SET/swap union, overnight, and partial-day regression scenarios ----
(async () => {
  sandbox.prepareFinalSchedule = schedFaithful; // exception-aware resolver for the engine's internal _resolveIvs
  const oc = TC.oncall;

  // #5 — a surgical swap landing inside an authoritative SET must refuse, not union back in.
  setRoutine([_base({})]);
  const a1 = await oc.setRoster('Z', ['orin'], '2026-08-10', '2026-08-10', { dryRun: true });
  setRoutine(a1.previewLayers);
  const a2 = await oc.swap('Z', 'vesper', 'briar', '2026-08-10', '2026-08-10', { dryRun: true });
  ok('#5 swap into a SET window is refused', a2.applied === false);
  eq('#5 SET stays sole at noon', atF(a1.previewLayers, 2026, 8, 10, 12), 'orin');

  // #6 — overnight swap tail (dated D-1) must be carved at midnight by a whole-day SET on D; pre-midnight survives.
  setRoutine([_base({ rotation_start: '17:00:00', shift_length: '08:30' })]);
  const b1 = await oc.swap('Z', 'vesper', 'briar', '2026-08-09', '2026-08-09', { dryRun: true });
  setRoutine(b1.previewLayers);
  const b2 = await oc.setRoster('Z', ['orin'], '2026-08-10', '2026-08-10', { dryRun: true });
  eq('#6 SET sole at D 00:30 (no overnight-tail union)', atF(b2.previewLayers, 2026, 8, 10, 0, 30), 'orin');
  eq('#6 swap survives pre-midnight at D-1 23:00', atF(b2.previewLayers, 2026, 8, 9, 23), 'briar');
  ok('#6 no overlapping exception tiles', noOverlap(b2.previewLayers));

  // #7 — overnight SET tail (dated D-1) must be carved at midnight by a whole-day SET on D.
  setRoutine([_base({})]);
  const c1 = await oc.setRoster('Z', ['orin'], '2026-08-09', '2026-08-09', { rotation_start: '18:00:00', shift_length: '12:00', dryRun: true });
  setRoutine(c1.previewLayers);
  const c2 = await oc.setRoster('Z', ['zane'], '2026-08-10', '2026-08-10', { dryRun: true });
  eq('#7 new SET sole at D 03:00 (no overnight-tail union)', atF(c2.previewLayers, 2026, 8, 10, 3), 'zane');
  eq('#7 prior SET survives pre-midnight at D-1 20:00', atF(c2.previewLayers, 2026, 8, 9, 20), 'orin');
  ok('#7 no overlapping exception tiles', noOverlap(c2.previewLayers));

  // #10 — two NON-overlapping partial-day SETs on one day must both survive (the second must not drop the first).
  setRoutine([_base({})]);
  const d1 = await oc.setRoster('Z', ['orin'], '2026-08-10', '2026-08-10', { rotation_start: '08:00:00', shift_length: '04:00', dryRun: true });
  setRoutine(d1.previewLayers);
  const d2 = await oc.setRoster('Z', ['briar'], '2026-08-10', '2026-08-10', { rotation_start: '13:00:00', shift_length: '04:00', dryRun: true });
  eq('#10 morning SET preserved at 09:00', atF(d2.previewLayers, 2026, 8, 10, 9), 'orin');
  eq('#10 afternoon SET at 14:00', atF(d2.previewLayers, 2026, 8, 10, 14), 'briar');
  eq('#10 base shows outside both bands at 18:00', atF(d2.previewLayers, 2026, 8, 10, 18), 'vesper');
  ok('#10 no overlapping exception tiles', noOverlap(d2.previewLayers));

  // #11 — a partial-day SET carved into a full-day swap: the swap survives OUTSIDE the SET band, not wiped wholesale.
  setRoutine([_base({})]);
  const e1 = await oc.swap('Z', 'vesper', 'briar', '2026-08-10', '2026-08-10', { dryRun: true });
  setRoutine(e1.previewLayers);
  const e2 = await oc.setRoster('Z', ['orin'], '2026-08-10', '2026-08-10', { rotation_start: '13:00:00', shift_length: '02:00', dryRun: true });
  eq('#11 swap survives before SET band at 09:00', atF(e2.previewLayers, 2026, 8, 10, 9), 'briar');
  eq('#11 SET inside its band at 14:00', atF(e2.previewLayers, 2026, 8, 10, 14), 'orin');
  eq('#11 swap survives after SET band at 16:00', atF(e2.previewLayers, 2026, 8, 10, 16), 'briar');
  ok('#11 no overlapping exception tiles', noOverlap(e2.previewLayers));

  // #14 — importRoutine must preserve deliberate exception layers (SET coverage + native overrides) and drop only the
  // extension's transient OVR swap tiles, with an honest per-kind count (was: dropped ALL exceptions, lumped the count).
  let createdBody = null;
  sandbox.fetch = async (p, opts) => { if (p === '/configurations/routines/create') createdBody = JSON.parse(opts.body); return { status: 200, text: async () => JSON.stringify({ ok: true }) }; };
  const snap = {
    format: 'taskcall-oncall-routine', version: 1, routine_name: 'Src', timezone: 'America/New_York', routine_layers: [
      _base({}),
      _exc('SET:set1~2026-08-10~2026-08-10~orin', '2026-08-10', '2026-08-10', ['orin']),
      { layer: 3, layer_name: 'Native holiday cover', valid_start: '2026-08-12', valid_end: '2026-08-13', is_exception: true, rotation_frequency: 1, skip_days: [], shift_length: '24:00', rotation_start: '00:00:00', rotations: [['briar']] },
      _exc('OVR:ovr1~vesper~zane~2026-08-11~2026-08-11', '2026-08-11', '2026-08-11', ['zane'])
    ]
  };
  const imp = await TC.oncall.importRoutine(snap, 'Clone');
  ok('#14 import lands', imp.created === true);
  eq('#14 keeps base + SET + native, drops only OVR', [imp.baseCount, imp.coverageTilesKept, imp.droppedOvrTiles], [1, 2, 1]);
  const inames = (createdBody.routine_layers || []).map(L => L.layer_name);
  ok('#14 SET coverage tile preserved in payload', inames.some(n => /^SET:/.test(n)));
  ok('#14 native exception preserved in payload', inames.indexOf('Native holiday cover') >= 0);
  ok('#14 transient OVR tile dropped from payload', !inames.some(n => /^OVR:/.test(n)));

  // MODE-AGREEMENT invariant: for an overnight routine, the {from,to} RANGE and the {at:instant} query must report
  // the SAME carry-in person at 00:30 on the first day. This guard FAILS if anyone "fixes" whosOn/_viewFrom by
  // re-adding a leading `-1` pad + date filter (which would DROP the prior-night tail the resolver already clips
  // into the window).
  setRoutine([_base({ rotation_start: '17:00:00', shift_length: '08:30' })]);
  const atRes = await TC.oncall.whosOn('Z', { at: '2026-08-10T00:30:00' });
  const rngRes = await TC.oncall.whosOn('Z', { from: '2026-08-10', to: '2026-08-10' });
  const atOn = ((atRes && atRes.on_call) || []).slice().sort().join(',');
  const t0030 = +new Date(2026, 7, 10, 0, 30);
  const rngOn = [...new Set(((rngRes && rngRes.shifts) || []).filter(s => s.date === '2026-08-10').filter(s => { const sd = new Date('2026-08-10T' + s.start), ed = new Date('2026-08-10T' + s.end); return +sd <= t0030 && t0030 < (+ed || +sd); }).flatMap(s => s.on_call || []))].sort().join(',');
  eq('mode-agreement: instant @00:30 sees the overnight carry-in', atOn, 'vesper');
  eq('mode-agreement: range and instant agree at 00:30 (no leading-edge drop)', rngOn, atOn);

  // "No One" placeholder dependency: time-off / coverage gaps need a non-paging placeholder user to exist (TaskCall drops
  // an empty roster on save). Detect it; refuse with a clear message when absent rather than silently not applying.
  t._noOneReset();
  setRoutine([_base({})], [['Alice', 'alice'], ['Bob', 'bob']]);   // account has NO "No One" user
  const phMissing = await TC.oncall.setRoster('Z', [], '2026-08-10', '2026-08-10', { timeOff: true, dryRun: true });
  ok('time-off is refused when no "No One" placeholder user exists', phMissing.applied === false && /No One/i.test(phMissing.warning || ''));
  t._noOneReset();
  setRoutine([_base({})], [['No One', 'no-one'], ['Alice', 'alice']]); // account HAS the placeholder
  const phOk = await TC.oncall.setRoster('Z', [], '2026-08-10', '2026-08-10', { timeOff: true, dryRun: true });
  ok('time-off proceeds (dry-run) when the "No One" placeholder exists', phOk.dryRun === true && phOk.applied === false && !/No One placeholder/i.test(phOk.warning || ''));
})().then(() => {
  console.log((failed ? 'FAILED' : 'ok') + ': ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch(e => { console.error('SCENARIO ERROR', e); process.exit(1); });
