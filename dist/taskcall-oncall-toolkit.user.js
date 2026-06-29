// ==UserScript==
// @name         On-Call Toolkit for TaskCall
// @namespace    taskcall.oncall.toolkit
// @version      1.0.0
// @description  View, edit & override TaskCall on-call schedules — swaps, covers, override-safe rotation editor
// @match        https://*.taskcallapp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// ---- engine (TaskCall on-call console, build-stamped) ----
// TaskCall on-call engine — installs window.TC on a logged-in TaskCall app tab (loaded by the
// extension/userscript in the page's MAIN world). Reuses the page's csrfToken global and your existing
// session cookie to read and write on-call config the same way the web app does. Writes are REAL changes
// to your live schedules — the panel previews every action as a dry run before it applies.
window.TC = (() => {
  // X-Requested-With is REQUIRED: path-based reads (e.g. /automation/conditional-routing/<ref>)
  // return the HTML SPA shell without it. Harmless on every other call, so always send it.
  const H = () => ({'X-CSRFToken': csrfToken, 'X-Requested-With':'XMLHttpRequest', 'Content-Type':'application/json'});
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  // The API intermittently returns "Sorry! Something went wrong" (and other 5xx) under load —
  // NOT an empty/zero result. Retry it; treat 4xx (405/404/403) as terminal.
  const isFlaky = j => (typeof j==='string' && /something went wrong/i.test(j))
    || (j && j.__text && /something went wrong/i.test(j.__text))
    || (j && j.__status && j.__status>=500);
  const post = async (p,b={}) => { let last;
    for (let i=0;i<5;i++){ const r=await fetch(p,{method:'POST',headers:H(),body:JSON.stringify(b)});
      const t=await r.text(); let j; try{j=JSON.parse(t)}catch(e){j={__status:r.status,__text:t.slice(0,120)}}
      last=j; if(!isFlaky(j)) return j; await sleep(700); }
    return last; };
  // A read/write that DID NOT land: null, a 4xx/5xx sentinel ({__status}), or the SPA login HTML ({__text} with '<').
  // post() never throws on an HTTP error — it returns one of these — so every read path must check before using the value.
  const _dead = r => r==null || (typeof r==='object' && ((r.__status && r.__status>=400) || (typeof r.__text==='string' && r.__text.indexOf('<')>=0)));
  // ===== on-call OVERRIDE ENGINE — temporary swaps on TaskCall routines =====
  // TaskCall overrides are BLANKET-within-time-band: any is_exception layer suppresses the
  // base in its wall-clock window and UNIONS with sibling exceptions. A surgical "swap X->Y, keep everyone else"
  // is therefore done by RECOMPILING from base every time: resolve the constant-roster intervals with the app's
  // own prepareFinalSchedule, substitute X->Y per interval where X is on, and emit ONE single-day exception TILE
  // per changed interval carrying the full corrected roster. Non-overlapping tiles => no union artifacts; multiple
  // swaps compose. Source of truth = the tiles: each tile's layer_name encodes the directive(s) that made it
  // ('OVR:alias~out~in~from~to;...'), so list/cancel/recompile are stateless & portable (no local state file).
  // Wall-clock round-trips through local Date components (prepareFinalSchedule runs in PT but built the Dates from
  // the routine's stored wall-clock, so reading getHours()/getDate() back recovers the routine-TZ values). Tiles
  // are single-day: valid_start=D, valid_end=D+1 (valid_start==valid_end 500s); covers only D.
  const _pad=n=>String(n).padStart(2,'0');
  const _dstr=d=>d.getFullYear()+'-'+_pad(d.getMonth()+1)+'-'+_pad(d.getDate());
  const _hms=d=>_pad(d.getHours())+':'+_pad(d.getMinutes())+':'+_pad(d.getSeconds());
  const _wm=d=>d.getHours()*60+d.getMinutes(); // wall-clock minutes since local midnight (DST-stable, unlike elapsed ms)
  const _pd=s=>{ const a=String(s).slice(0,10).split('-').map(Number); return new Date(a[0],a[1]-1,a[2]); };
  const _daysBetween=(a,b)=>Math.round((_pd(b)-_pd(a))/86400000);
  const _addDays=(s,n)=>{ const d=_pd(s); d.setDate(d.getDate()+n); return _dstr(d); };
  const _hhmm=m=>_pad(Math.floor(m/60))+':'+_pad(m%60);
  const _sched=()=>{ if(typeof prepareFinalSchedule!=='function') throw new Error('prepareFinalSchedule not loaded — must run on a TaskCall config page'); return prepareFinalSchedule; };
  const _cleanLayer=L=>({ layer:L.layer, layer_name:L.layer_name, valid_start:String(L.valid_start||'').slice(0,10), valid_end:String(L.valid_end||'9999-01-01').slice(0,10), is_exception:!!L.is_exception, rotation_start:L.rotation_start, shift_length:L.shift_length, rotation_frequency:L.rotation_frequency, skip_days:L.skip_days||[], rotations:(L.rotations||[]).map(st=>st.map(p=>Array.isArray(p)?p[1]:p)) });
  // MERGED constant-roster intervals over [fromDate,toDate] inclusive, resolved from `layers`.
  // prepareFinalSchedule returns ONE interval PER LAYER (concurrent layers are NOT merged), so we sweep-line
  // them into constant-roster slices: every tile we later write must carry the FULL concurrent roster for its
  // band, otherwise its blanket suppression would drop the co-on people. Boundaries = every layer interval's
  // start/end; each slice's roster = union of all layer intervals covering the slice midpoint.
  const _resolveIvs=(layers,fromDate,toDate)=>{ const start=_pd(fromDate); const days=_daysBetween(fromDate,toDate)+2;
    const spanStart=+start, spanEnd=+_pd(_addDays(toDate,1));
    const raw=(_sched()(start,days,layers)[0]||[]).filter(iv=>iv&&iv.on_call&&iv.on_call.length)
      .map(iv=>({s:+new Date(iv.rotation_start), e:+new Date(iv.rotation_end), roster:iv.on_call.map(p=>Array.isArray(p)?p[1]:p)}));
    const bset=new Set(); raw.forEach(iv=>{ bset.add(iv.s); bset.add(iv.e); }); const bounds=[...bset].sort((a,b)=>a-b);
    const merged=[];
    for(let i=0;i<bounds.length-1;i++){ const a=bounds[i], b=bounds[i+1], mid=(a+b)/2; const on=[];
      raw.forEach(iv=>{ if(iv.s<=mid && mid<iv.e) iv.roster.forEach(u=>{ if(on.indexOf(u)<0) on.push(u); }); });
      if(on.length) merged.push({a,b,on}); }
    const clipped=merged.filter(iv=> iv.b>spanStart && iv.a<spanEnd)
      .map(iv=>({a:Math.max(iv.a,spanStart), b:Math.min(iv.b,spanEnd), on:iv.on}));
    // A TaskCall shift can't exceed 24h (shift_length ≤ 24:00); multi-day coverage = a DAILY shift repeated.
    // So split any interval longer than a day into ≤24h per-day chunks (a continuously-staffed routine otherwise
    // yields one giant interval → a 168:00 shift the server hard-rejects, erroring the whole save). Overnight (<24h) intervals pass through.
    // Split a MULTI-DAY (>24h wall-clock) continuous interval into per-calendar-day chunks; a single shift that is ≤24h
    // — INCLUDING an overnight one crossing midnight (e.g. 20:00→08:00) — passes through WHOLE, dated by its start, so
    // swap/_compile's date-window match (iv.date in [from,to]) still lands on it. Cut at LOCAL midnight, never via a fixed
    // +86400000ms: a DST day is 23h/25h of real time, so a fixed-ms step would drift every later chunk's wall-clock start.
    // The 24:00 wall-clock length of a full day is recovered in _coalesceTiles. Gating is by WALL-CLOCK length so a 25h
    // fall-back day still resolves to one 24:00 tile rather than a leftover sliver.
    const slices=[];
    clipped.forEach(iv=>{ let s=iv.a; const eEnd=new Date(iv.b);
      while(true){ const sd=new Date(s);
        if(_wm(eEnd)-_wm(sd)+1440*_daysBetween(_dstr(sd),_dstr(eEnd))<=1440){ slices.push({date:_dstr(sd), roster:iv.on, start:sd, end:eEnd}); break; }
        const nextMid=+_pd(_addDays(_dstr(sd),1)); slices.push({date:_dstr(sd), roster:iv.on, start:sd, end:new Date(nextMid)}); s=nextMid; } });
    return slices; };
  // Union several routines' resolved slices into combined constant-roster bands (sweep-line). Used by
  // policyCoverage: a policy level may page MULTIPLE routines, so the level's roster at any instant is the
  // UNION of each routine's CURRENT on-call. Routines are resolved SEPARATELY (each with its own overrides)
  // then merged here — never by concatenating layers, which could let one routine's exception tile blank
  // another routine. Adjacent equal-roster bands coalesce. Returns [{startMs,endMs,date,start,end,roster}].
  const _setEq=(a,b)=>a.length===b.length && a.every(x=>b.indexOf(x)>=0);
  const _unionSlices=arrs=>{ const all=[]; arrs.forEach(a=>(a||[]).forEach(iv=>all.push({s:+iv.start,e:+iv.end,roster:iv.roster})));
    if(!all.length) return []; const bset=new Set(); all.forEach(iv=>{bset.add(iv.s);bset.add(iv.e);}); const bounds=[...bset].sort((a,b)=>a-b);
    const out=[]; for(let i=0;i<bounds.length-1;i++){ const a=bounds[i], b=bounds[i+1], mid=(a+b)/2; const on=[];
      all.forEach(iv=>{ if(iv.s<=mid && mid<iv.e) iv.roster.forEach(u=>{ if(on.indexOf(u)<0) on.push(u); }); });
      if(on.length){ const L=out[out.length-1]; if(L && L.e===a && _setEq(L.on,on)) L.e=b; else out.push({s:a,e:b,on:on.slice()}); } }
    return out.map(iv=>({startMs:iv.s, endMs:iv.e, date:_dstr(new Date(iv.s)), start:new Date(iv.s), end:new Date(iv.e), roster:iv.on})); };
  const _mkLayer=(vs,ve,rs,sl,skip,roster,applied)=>({ layer:0,
    layer_name:'OVR:'+applied.map(d=>[d.alias,d.out,d.in||'',d.from,d.to].join('~')).join(';'),
    valid_start:vs, valid_end:ve, is_exception:true, rotation_start:rs, shift_length:sl,
    rotation_frequency:1, skip_days:skip||[], rotations:[roster.slice()] });
  const _pywd=ds=>{ const d=_pd(ds); return (d.getDay()+6)%7; }; // 0=Mon..6=Sun (matches skip_days)
  // COALESCE the changed constant-roster slices into the MINIMAL set of exception layers (instead of one tile per
  // slice). (1) merge time-adjacent same-roster slices within a day; (2) group identical (time-band, roster,
  // directive-set) across days and emit ONE layer per weekly pattern (valid range + skip_days) when the dates form
  // "every weekday-in-set within [min,max]", else one layer per contiguous calendar run. Resolves identically to
  // the per-slice tiles but far fewer layers when the base roster is stable across time/days.
  const _coalesceTiles=changed=>{
    const byDate={}; changed.forEach(c=>{ (byDate[c.date]=byDate[c.date]||[]).push(c); });
    const slices=[];
    Object.keys(byDate).forEach(date=>{ const arr=byDate[date].slice().sort((a,b)=>a.start-b.start); let cur=null;
      arr.forEach(c=>{ const rk=c.roster.slice().sort().join(','); const asig=c.applied.map(d=>d.alias).slice().sort().join(',');
        const mlen=cur?_wm(c.end)-_wm(cur.start)+1440*_daysBetween(_dstr(cur.start),_dstr(c.end)):0; // merged wall-clock span
        if(cur && +cur.end===+c.start && cur.rk===rk && cur.asig===asig && mlen<=_MAXSHIFT){ cur.end=c.end; } // never merge past 24:00 (server rejects it)
        else { cur={date:date, start:c.start, end:c.end, roster:c.roster, applied:c.applied, rk:rk, asig:asig}; slices.push(cur); } }); });
    const groups={};
    slices.forEach(s=>{ const startHMS=_hms(s.start);
      // wall-clock length, NOT real elapsed ms: a full calendar day reads 24:00 even when DST makes it 23h/25h of real
      // time (a 23:00 shift_length would under-cover the day, and a 25:00 one would be rejected by the server, failing the save). dayDiff bridges midnight.
      const lenMin=Math.max(1, _wm(s.end)-_wm(s.start)+1440*_daysBetween(_dstr(s.start),_dstr(s.end)));
      const key=startHMS+'|'+lenMin+'|'+s.rk+'|'+s.asig;
      (groups[key]=groups[key]||{startHMS:startHMS, lenMin:lenMin, roster:s.roster, applied:s.applied, dates:[]}).dates.push(s.date); });
    const tiles=[];
    Object.keys(groups).forEach(k=>{ const g=groups[k]; const dates=[...new Set(g.dates)].sort();
      const sl=_hhmm(g.lenMin), min=dates[0], max=dates[dates.length-1], W={}; dates.forEach(d=>{ W[_pywd(d)]=1; });
      const expected=[]; for(let d=min; d<=max; d=_addDays(d,1)) if(W[_pywd(d)]) expected.push(d);
      const clean = expected.length===dates.length && expected.every((d,i)=>d===dates[i]);
      if(clean){ const skip=[0,1,2,3,4,5,6].filter(wd=>!W[wd]);
        tiles.push(_mkLayer(min,_addDays(max,1),g.startHMS,sl,skip,g.roster,g.applied)); }
      else { let i=0; while(i<dates.length){ let j=i; while(j+1<dates.length && _addDays(dates[j],1)===dates[j+1]) j++;
        tiles.push(_mkLayer(dates[i],_addDays(dates[j],1),g.startHMS,sl,[],g.roster,g.applied)); i=j+1; } } });
    return tiles; };
  const _readDirectives=layers=>{ const m={}; for(const L of (layers||[])){ if(!L.is_exception) continue; const nm=L.layer_name||''; if(nm.slice(0,4)!=='OVR:') continue;
    for(const seg of nm.slice(4).split(';')){ const p=seg.split('~'); if(p[0]&&!m[p[0]]) m[p[0]]={alias:p[0],out:p[1],in:p[2]||'',from:p[3],to:p[4]}; } } return Object.values(m); };
  const _nextAlias=ds=>{ let mx=0; for(const d of ds){ const m=/^ovr(\d+)$/.exec(d.alias||''); if(m) mx=Math.max(mx,+m[1]); } return 'ovr'+(mx+1); };
  // SET coverage overrides (set the roster for a window): a blanket exception tile named
  // 'SET:alias~from~to~user1,user2' (empty roster = intentional time-off gap → a 'no-one' tile). Unlike OVR swaps,
  // these are NOT recompiled from base — they're preserved verbatim through saveBase (they ride the "unmanaged
  // exception" path in _compile) and parsed back out here for listing/cancel. '~' and ',' are reserved in usernames.
  const _readSets=layers=>{ const out=[]; for(const L of (layers||[])){ if(!L.is_exception) continue; const nm=L.layer_name||''; if(nm.slice(0,4)!=='SET:') continue;
    const p=nm.slice(4).split('~'); if(!p[0]) continue; out.push({alias:p[0], from:p[1], to:p[2], roster:(p[3]||'').split(',').filter(Boolean), rs:L.rotation_start||'00:00:00', sl:L.shift_length||'24:00', skip:L.skip_days||[]}); } return out; };
  const _setLayer=(alias,from,to,roster,o={})=>({ layer:0, layer_name:'SET:'+alias+'~'+from+'~'+to+'~'+(roster||[]).join(','), is_exception:true, valid_start:from, valid_end:_addDays(to,1), rotation_start:o.rotation_start||o.rs||'00:00:00', shift_length:o.shift_length||o.sl||'24:00', rotation_frequency:1, skip_days:o.skip_days||o.skip||[], rotations:[(roster&&roster.length)?roster.slice():['no-one']] });
  const _nextSetAlias=sets=>{ let mx=0; for(const s of sets){ const m=/^set(\d+)$/.exec(s.alias||''); if(m) mx=Math.max(mx,+m[1]); } return 'set'+(mx+1); };
  // --- authoritative-SET interval algebra (band + overnight aware) -------------------------------------------------
  // Two is_exception layers concurrent in the REAL resolver (prepareFinalSchedule) UNION — the engine can't suppress one
  // with another, so the only way to keep a SET authoritative is to never WRITE an exception tile whose real coverage
  // overlaps it. These compute that coverage by wall-clock TIME (not just calendar date), so partial-day bands and
  // overnight tails are carved correctly. ABSOLUTE instant for `date` at `mins` past its midnight (DST-correct; mins≥1440
  // carries into later days):
  const _atWall=(date,mins)=>{ const m=((mins%1440)+1440)%1440, dd=_pd(_addDays(date, Math.floor(mins/1440))); return new Date(dd.getFullYear(),dd.getMonth(),dd.getDate(),Math.floor(m/60),m%60); };
  // Covered [startMs,endMs) intervals of a SET-like band {from..to, rs, sl, skip} (overnight-aware, skip_days honored).
  const _setCover=(from,to,rs,sl,skip)=>{ const out=[], RS=_slmin(String(rs||'00:00:00').slice(0,5)), SL=_slmin(sl||'24:00');
    for(let d=from; d<=to; d=_addDays(d,1)){ if((skip||[]).indexOf(_pywd(d))>=0) continue; out.push([+_atWall(d,RS), +_atWall(d,RS+SL)]); } return out; };
  // [s,e) minus a set of cut intervals → surviving sub-intervals (each [a,b) with b>a).
  const _subIv=(s,e,cuts)=>{ let segs=[[s,e]]; cuts.forEach(c=>{ const ns=[]; segs.forEach(g=>{ if(c[1]<=g[0]||c[0]>=g[1]){ ns.push(g); return; } if(c[0]>g[0]) ns.push([g[0],c[0]]); if(c[1]<g[1]) ns.push([c[1],g[1]]); }); segs=ns; }); return segs.filter(g=>g[1]>g[0]); };
  // Does [s,e) intersect any cut interval?
  const _hitsIv=(s,e,cuts)=>cuts.some(c=>c[0]<e && s<c[1]);
  // Bake one absolute [sMs,eMs) survivor into a single blanket SET tile (its start dates it; length is wall-clock, DST-correct).
  const _bakedSet=(alias,sMs,eMs,roster)=>{ const s=new Date(sMs), e=new Date(eMs), mins=_wm(e)-_wm(s)+1440*_daysBetween(_dstr(s),_dstr(e)); return _setLayer(alias,_dstr(s),_dstr(s),roster,{rotation_start:_hms(s), shift_length:_hhmm(mins)}); };
  const _badSetUser=u=>/[~,]/.test(String(u==null?'':u));
  // Intentional gaps (time-off / coverage holes) are written as TaskCall's "No One" placeholder user, because TaskCall
  // DROPS a truly-empty roster on save (so an empty exception tile wouldn't suppress the base). "No One" must exist as a
  // real (non-paging) user in the account; detect it so we can fail loudly instead of silently not applying. Cache:
  // undefined=unchecked, null=confirmed-absent, string=its username. On a failed/odd read, assume the convention rather
  // than block (don't regress accounts that do have it).
  let _noOneCache;
  const _noOneUser=async()=>{ if(typeof _noOneCache!=='undefined') return _noOneCache;
    try{ const us=await fetch('/configurations/list?param=users',{headers:H()}).then(r=>r.json());
      if(!Array.isArray(us)) return 'no-one';
      const hit=us.find(p=>{ const un=String((Array.isArray(p)?p[1]:p)||''), dn=String((Array.isArray(p)?p[0]:p)||''); return un==='no-one' || /^no[\s_-]?one$/i.test(un) || /^no\s*one$/i.test(dn); });
      return (_noOneCache = hit ? (Array.isArray(hit)?hit[1]:hit) : null);
    }catch(e){ return 'no-one'; } };
  // COVER ("until removed") markers live in a BASE layer's name: '<name> |COV:out>in'. A cover is a phase-preserving
  // name swap in the base rotations (not a dated tile) — indefinite, reversible, no horizon. Parse/format/read:
  // marker grammar: ' |COV:out>in@s.g,s.g' where steps = the [stepIdx.groupIdx] positions cover() rewrote, so
  // uncover restores EXACTLY those positions (not every occurrence of `in` by name). Legacy markers (no @) fall
  // back to name-based restore. '>' and ' |COV:' are reserved in usernames (rejected at cover time).
  const _parseCov=nm=>{ const parts=String(nm||'').split(' |COV:'); return {base:parts[0], covs:parts.slice(1).map(s=>{ const at=s.indexOf('@'); const body=at<0?s:s.slice(0,at); const i=body.indexOf('>');
    const steps=at<0?null:s.slice(at+1).split(',').filter(Boolean).map(p=>{ const q=p.split('.'); return {s:+q[0], g:+q[1]}; });
    return {out:body.slice(0,i), in:body.slice(i+1), steps:steps}; })}; };
  const _covName=(base,covs)=> base + covs.map(c=>' |COV:'+c.out+'>'+c.in+(c.steps&&c.steps.length?'@'+c.steps.map(p=>p.s+'.'+p.g).join(','):'')).join('');
  const _readCovers=layers=>{ const m={}; (layers||[]).forEach(L=>{ if(L.is_exception) return; _parseCov(L.layer_name).covs.forEach(c=>{ m[c.out+'>'+c.in]=c; }); }); return Object.values(m); };
  // clean DISPLAY/slot base name — the layer_name with any cover marker stripped off.
  const _baseOf=nm=>String(nm||'').replace(/ \|COV:[\s\S]*$/,'');
  // Reject only the delimiters that would actually corrupt the relevant marker grammar (so e.g. an email-style
  // username with '@' — harmless in OVR — is still swappable). OVR:alias~out~in~from~to;... uses '~' and ';'.
  const _badOvrUser=u=>/[~;]/.test(String(u==null?'':u));
  // The cover marker ' |COV:out>in@s.g,...' uses '>' and '@' (and the ' |COV:' literal) as delimiters.
  const _badCovUser=u=>{ const s=String(u==null?'':u); return /[>@]/.test(s) || s.indexOf(' |COV:')>=0; };
  const _findRoutine=async nameOrRef=>{ const list=await post('/configurations/routines');
    if(_dead(list) || !Array.isArray(list)) throw new Error('Could not read routines (session expired or server error) — reload the tab and sign in.');
    let hit=list.find(x=>x.routine_ref_id===nameOrRef);
    if(!hit){ const byName=list.filter(x=>String(x.routine_name).toLowerCase()===String(nameOrRef).toLowerCase());
      if(byName.length>1) throw new Error('Ambiguous routine name "'+nameOrRef+'" — pass the ref id'); hit=byName[0]; }
    if(!hit) throw new Error('Routine not found: "'+nameOrRef+'"');
    const full=await post('/configurations/routines/'+hit.routine_ref_id);
    if(_dead(full) || !full.routine_ref_id) throw new Error('Could not load routine "'+(hit.routine_name||nameOrRef)+'" (session expired or server error).');
    return full; };
  const _compile=(routine,directives)=>{ const all=routine.routine_layers||[];
    const base=all.filter(L=>!L.is_exception); const unmanaged=all.filter(L=>L.is_exception && (L.layer_name||'').slice(0,4)!=='OVR:');
    // SET coverage tiles are AUTHORITATIVE for their window — a swap must NOT resolve THROUGH them (else recompile re-applies
    // a directive to the SET roster and re-emits an overlapping OVR tile that unions back in). Resolve swaps against base
    // (+ any non-SET unmanaged exceptions) only; SET tiles still pass through verbatim to the output.
    const sets=unmanaged.filter(L=>(L.layer_name||'').slice(0,4)==='SET:');
    const resolveBase=base.concat(unmanaged.filter(L=>(L.layer_name||'').slice(0,4)!=='SET:'));
    const eff=resolveBase.concat(sets);
    if(!directives.length) return {layers:eff, tiles:[], changes:[]};
    const froms=directives.map(d=>d.from).sort(), tos=directives.map(d=>d.to).sort();
    // Resolve from ONE day BEFORE the first directive through ONE day AFTER the last, so overnight shifts at BOTH
    // edges are dated by their true START and resolve in full. Trailing (+1): a shift STARTING on `to` (e.g. 20:00→08:00)
    // resolves whole, so the substitute holds the cover-the-shift instead of just its pre-midnight portion. Leading (-1):
    // the PRIOR night's shift (started the day before `from`) keeps its real date, so its post-midnight tail bleeding into
    // `from` (e.g. a 17:00→01:30 night's 00:00–01:30 carry-over) is NOT re-dated to `from` and wrongly hit by the directive
    // — removing a night for date D must not remove the night-before's carry-over into D. Directives only apply where
    // iv.date is in [from,to], so the two extra days yield no tiles of their own.
    const ivs=_resolveIvs(resolveBase, _addDays(froms[0], -1), _addDays(tos[tos.length-1], 1));
    const changed=[], changes=[];
    for(const iv of ivs){ let roster=iv.roster.slice(); const applied=[];
      for(const d of directives){ if(iv.date>=d.from && iv.date<=d.to){ const i=roster.indexOf(d.out);
        if(i>=0){ roster.splice(i,1); if(d.in && roster.indexOf(d.in)<0) roster.push(d.in); applied.push(d); } } }
      if(applied.length){ if(!roster.filter(u=>u!=='no-one').length) throw new Error('Override would leave '+iv.date+' '+_hms(iv.start)+' with NOBODY on-call (removed the only real person — only the No One placeholder would remain).');
        changed.push({date:iv.date, start:iv.start, end:iv.end, roster:roster, applied:applied});
        changes.push({date:iv.date, shift:_hms(iv.start), before:iv.roster.slice(), after:roster.slice(), via:applied.map(a=>a.alias)}); } }
    const tiles=_coalesceTiles(changed);
    return {layers:eff.concat(tiles), tiles, changes}; };
  const _save=async(routine,finalLayers)=>{ const r=await post('/configurations/routines/edit',{routine_ref_id:routine.routine_ref_id, routine_name:routine.routine_name, timezone:routine.timezone||'America/New_York', routine_layers:finalLayers.map((L,i)=>{ const c=_cleanLayer(L); c.layer=i+1; return c; })});
    // a logged-out/expired write returns the SPA login HTML or a 4xx sentinel — DON'T report success on a write that didn't land
    if(r==null || (typeof r==='object' && ((r.__status&&r.__status>=400) || (typeof r.__text==='string' && r.__text.indexOf('<')>=0)))) throw new Error('routine save did not land (session expired or server rejected the edit) — nothing was changed');
    return r; };
  // ===== RESOLUTION from a routine OBJECT (shared by whosOnView/whosOnSlots AND the preview helpers) =====
  // Identical logic to the public methods, minus the fetch — so a HYPOTHETICAL routine (e.g. swap()/swapSlot()
  // {dryRun}.previewLayers, before it is saved) resolves EXACTLY like a saved one. r={routine_name,timezone,routine_layers}.
  const _viewFrom=(r,opts={})=>{ const L=r.routine_layers||[];
    const from=opts.from||_dstr(new Date()), to=opts.to||from;
    const dirs=_readDirectives(L), covs=_readCovers(L); const covered={};
    dirs.forEach(d=>{ if(d.in) covered[d.out]=d.in; }); covs.forEach(c=>{ covered[c.out]=c.in; });
    return { routine:r.routine_name, timezone:r.timezone||'America/New_York', from, to,
      shifts:_resolveIvs(L,from,to).map(iv=>({date:iv.date, start:_hms(iv.start), end:_hms(iv.end), on_call:iv.roster})),
      overrides:dirs.map(d=>({out:d.out, in:d.in, from:d.from, to:d.to})), covers:covs.map(c=>({out:c.out, in:c.in})),
      covered:Object.keys(covered).map(o=>({out:o, in:covered[o]})) }; };
  // PER-SLOT view: each BASE layer = a shift-slot lane; resolve per-day occupant(s) and attribute
  // coverage (a COVER shows the substitute via the layer marker; a dated OVERRIDE replaces the slot occupant within its
  // window). Resolve from from-1 so an overnight shift begun the night before `from` contributes its post-midnight tail;
  // split each interval at midnight into per-day SEGMENTS with actual hours (>24h coverage fills each day; overnight
  // shows tail contPrev / head contNext); bar geometry uses RESOLVED times. Each day keeps a distinct-occupant `on` list.
  const _slotsFrom=(r,opts={})=>{ const all=r.routine_layers||[];
    const base=all.filter(L=>!L.is_exception); const dirs=_readDirectives(all);
    const from=opts.from||_dstr(new Date()), to=opts.to||from;
    const start=_pd(_addDays(from,-1)), days=_daysBetween(from,to)+3;
    const slots=base.map(L=>{ const pc=_parseCov(L.layer_name); const covIn={}; pc.covs.forEach(c=>{ covIn[c.in]=c.out; });
      const ivs=_sched()(start,days,[L])[0]||[]; const byDate={};
      ivs.filter(iv=>iv&&iv.on_call&&iv.on_call.length).forEach(iv=>{ const us=iv.on_call.map(p=>Array.isArray(p)?p[1]:p);
        const Sd=new Date(iv.rotation_start), Ed=new Date(iv.rotation_end); const S=+Sd, E=+Ed; if(!(E>S)) return;
        const fs={d:_dstr(Sd),h:_hms(Sd)}, fe={d:_dstr(Ed),h:_hms(Ed)};
        let cur=S; while(cur<E){ const dd=_dstr(new Date(cur)); const segEnd=Math.min(E,+_pd(_addDays(dd,1)));
          const curD=new Date(cur), segEndD=new Date(segEnd);
          (byDate[dd]=byDate[dd]||[]).push({us, s:_wm(curD)/60+24*_daysBetween(dd,_dstr(curD)), e:_wm(segEndD)/60+24*_daysBetween(dd,_dstr(segEndD)), contPrev:cur>S, contNext:segEnd<E, fs, fe});
          cur=segEnd; } });
      const dayCells=[]; for(let dd=from; dd<=to; dd=_addDays(dd,1)){
        const segs=(byDate[dd]||[]).map(g=>{ const people=g.us.map(u=>{ let person=u, covering=null;
            if(covIn[u]) covering=covIn[u];
            const ov=dirs.find(d=>d.out===u && dd>=d.from && dd<=d.to); if(ov){ person=ov.in; covering=u; }
            return {u:person, base:u, covering:covering, ovr:!!ov}; });
          return {on:people, s:g.s, e:g.e, contPrev:g.contPrev, contNext:g.contNext, fs:g.fs, fe:g.fe}; });
        const on=[]; segs.forEach(sg=>sg.on.forEach(p=>{ if(!on.some(x=>x.u===p.u && x.covering===p.covering)) on.push(p); }));
        dayCells.push({date:dd, on:on, segs:segs}); }
      return {slot:_baseOf(L.layer_name).trim(), start:L.rotation_start, shiftLen:L.shift_length, skip:L.skip_days||[], days:dayCells}; });
    return {routine:r.routine_name, timezone:r.timezone||'America/New_York', from, to, slots}; };
  // ===== STRUCTURAL EDITOR helpers (override-safe base editing — see TC.oncall.loadBase/saveBase) =====
  // A base layer ⇄ a simple EDITABLE shape the panel renders. Covers (|COV: markers in the name) are parsed off
  // and preserved verbatim. steps = the rotation step-sequence as plain usernames (each step = a concurrent group).
  const _MAXSHIFT=24*60; // minutes — TaskCall hard-rejects a shift_length > 24:00 (generic error, fails the whole save); 24:00 is the max allowed
  const _slmin=s=>{ const p=String(s||'0').split(':'); return (+p[0])*60+(+p[1]||0); };
  const _editable=L=>{ const pc=_parseCov(L.layer_name);
    return { name:_baseOf(L.layer_name).trim(), covs:pc.covs,
      valid_start:String(L.valid_start).slice(0,10), valid_end:String(L.valid_end||'9999-01-01').slice(0,10),
      rotation_start:L.rotation_start, shift_length:L.shift_length, rotation_frequency:L.rotation_frequency,
      skip_days:(L.skip_days||[]).slice(), steps:(L.rotations||[]).map(st=>st.map(p=>Array.isArray(p)?p[1]:p)) }; };
  const _toStore=eL=>{ const covs=eL.covs||[]; const base=String(eL.name||'').trim();
    return { layer:0, layer_name:covs.length?_covName(base,covs):base, valid_start:String(eL.valid_start).slice(0,10),
      valid_end:String(eL.valid_end||'9999-01-01').slice(0,10), is_exception:false,
      rotation_start:eL.rotation_start||'00:00:00', shift_length:eL.shift_length||'24:00',
      rotation_frequency:eL.rotation_frequency||7, skip_days:(eL.skip_days||[]).slice(),
      rotations:(eL.steps||[]).map(st=>st.slice().filter(Boolean)).filter(st=>st.length) }; };
  const _validateLayer=(eL,i)=>{ const tag='Rotation '+(i!=null?'#'+(i+1)+' ':'')+'"'+(eL&&eL.name||'')+'": ';
    if(!eL||!String(eL.name||'').trim()) return tag+'name is required.';
    if(/[>]/.test(eL.name)||/ \|COV:/.test(eL.name)) return tag+'name can\'t contain ">" or " |COV:".';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(eL.valid_start||''))) return tag+'start date must be YYYY-MM-DD.';
    if(eL.valid_end && String(eL.valid_end).slice(0,4)!=='9999'){ if(!/^\d{4}-\d{2}-\d{2}$/.test(String(eL.valid_end))) return tag+'end date must be YYYY-MM-DD.'; if(String(eL.valid_end)<String(eL.valid_start)) return tag+'end date must be on or after the start date.'; }
    const steps=(eL.steps||[]).map(st=>(st||[]).filter(Boolean)).filter(st=>st.length); if(!steps.length) return tag+'needs at least one participant.';
    var sl=_slmin(eL.shift_length); if(sl<1||sl>_MAXSHIFT) return tag+'shift length must be 00:01–24:00 (split a >24h span into per-day rotations).';
    if(!Array.isArray(eL.skip_days)) return tag+'invalid days.';
    if([...new Set((eL.skip_days||[]).filter(d=>d>=0&&d<=6))].length>=7) return tag+'at least one active day is required (every day is currently skipped).';
    return null; };
  // duplicate rotation-NAME guard shared by saveBase/createRoutine/toStoreLayers (slot ops + lane identity key on the name).
  const _dupNameErr=baseLayers=>{ const names={}; for(const L of (baseLayers||[])){ const k=String(L&&L.name||'').trim().toLowerCase(); if(!k) continue; if(names[k]) return 'Two rotations are both named "'+String(L.name).trim()+'" — names must be unique.'; names[k]=1; } return null; };
  return {
    // pure helpers surfaced for the test suite (tests/run.js); not public API, no behavior change
    _test: { _dstr, _pd, _daysBetween, _addDays, _wm, _hhmm, _slmin, _pywd, _setEq, _MAXSHIFT, _cleanLayer, _coalesceTiles, _atWall, _setCover, _subIv, _hitsIv, _bakedSet, _noOneUser, _noOneReset:()=>{ _noOneCache=undefined; } },
    raw: post, // TC.raw('/any/path', {body}) for endpoints not wrapped below
    routines:{ list:()=>post('/configurations/routines'), // named schedule routines only (NOT per-user personal ones)
      // ALL assignable routines incl per-user PERSONAL routines, as [[displayName, ref],...] — match by name to get a user's ref for policy levels (GET endpoint). param also accepts policies+users, teams, business-services.
      assignables:()=>fetch('/configurations/list?param=routines+users',{headers:H()}).then(r=>r.json()),
      get:(routine_ref_id)=>post('/configurations/routines/'+routine_ref_id), // full incl routine_layers (path-read; needs X-Requested-With)
      create:(routine_name,routine_layers,timezone='America/New_York')=>post('/configurations/routines/create',{routine_name,timezone,routine_layers}),
      edit:(routine_ref_id,routine_name,routine_layers,timezone='America/New_York')=>post('/configurations/routines/edit',{routine_ref_id,routine_name,timezone,routine_layers}),
      del:(routine_ref_id)=>post('/configurations/routines/delete',{routine_ref_id}),
      // build a layer. rotations is the SEQUENCE of steps: rotations[i] = the concurrent group on duty in step i; active step advances every rotation_frequency days.
      //   ROTATE a team weekly:  rotations = TC.routines.rotate(['a','b','c'])  → [['a'],['b'],['c']]  (one per week)
      //   CONCURRENT panel:      rotations = [['a','b','c']]                     (all on every week — does NOT rotate)
      // valid_start/valid_end are DATE-ONLY ('YYYY-MM-DD') — a datetime ('...T00:00:00') 500s the server. valid_start is the cycle epoch.
      rotate:(arr)=>arr.map(x=>[x]), // people[] → rotating sequence of single-person steps
      layer:(rotations,o={})=>({layer:o.layer||1, layer_name:o.layer_name||'Layer 1', valid_start:o.valid_start||'2026-06-01', valid_end:o.valid_end||'9999-01-01', is_exception:!!o.is_exception, rotation_start:o.rotation_start||'00:00:00', shift_length:o.shift_length||'24:00', rotation_frequency:o.rotation_frequency||7, skip_days:o.skip_days||[], rotations}),
      // override: temporary swap. Lays a time-boxed is_exception layer over the routine(s); stops applying at valid_end, base untouched.
      // Note it's blanket: during the window only `people` are on-call and all base coverage is suppressed. So pass the full intended roster (the substitute plus everyone who stays), not just the replacement, or you drop the others. routine_refs can be an array for one override across several routines. valid_start/valid_end are date-only. owner_user is path context only; it does not scope the swap. For a rotation inside the override, pass o.rotations instead of people. The default window is whole days; narrow it with o.rotation_start / o.shift_length.
      override:(routine_refs, owner_user, valid_start, valid_end, people, o={})=>
        post('/configurations/users/on-call-shifts/'+owner_user+'/override',
          { routines:Array.isArray(routine_refs)?routine_refs:[routine_refs], valid_start, valid_end,
            rotation_start:o.rotation_start||'00:00:00', shift_length:o.shift_length||'24:00',
            rotations:o.rotations || [ Array.isArray(people)?people:[people] ] }),
      // Cancel/clear overrides early: drop is_exception layers (ALL, or only the one starting o.win 'YYYY-MM-DD') and re-save the routine. Handles the read-modify-write coercion (dates→date-only, rotations [name,user]→user).
      clearOverrides: async (routine_ref_id, o={})=>{ const r=await post('/configurations/routines/'+routine_ref_id);
        // a failed read must NOT become an edit that blanks the routine to zero layers (would page nobody) — bail loudly.
        if(_dead(r) || !Array.isArray(r.routine_layers)) throw new Error('clearOverrides aborted: could not read routine "'+routine_ref_id+'" (session expired or server error) — nothing was changed.');
        const layers=r.routine_layers.filter(L=> !L.is_exception || (o.win && String(L.valid_start).slice(0,10)!==o.win))
          .map(L=>({layer:L.layer, layer_name:L.layer_name, valid_start:String(L.valid_start).slice(0,10), valid_end:String(L.valid_end||'9999-01-01').slice(0,10), is_exception:!!L.is_exception, rotation_start:L.rotation_start, shift_length:L.shift_length, rotation_frequency:L.rotation_frequency, skip_days:L.skip_days||[], rotations:(L.rotations||[]).map(step=>step.map(p=>Array.isArray(p)?p[1]:p))}));
        const res=await post('/configurations/routines/edit',{routine_ref_id, routine_name:r.routine_name, timezone:r.timezone, routine_layers:layers});
        if(_dead(res)) throw new Error('clearOverrides: the edit did not land (session expired or server rejected it).');
        return res; } },
    users:{ list:(keywords)=>post('/users/list',keywords?{keywords}:{}), details:(u)=>post('/users/details',{preferred_username:u}),
      names:()=>fetch('/configurations/list?param=users',{headers:H()}).then(r=>r.json()), // [[displayName, username],...] — RELIABLE active roster (list()/POST /users/list 405s in config context). Resolve name→username for routine rotations.
      requested:()=>post('/configurations/users/requested'), // pending invites
      // invite users by email. invitees: [{email, user_role, job_title:null}]. user_role ∈ ADMIN|OWNER|MANAGER|RESPONDER|USER|OBSERVER|STAKEHOLDER|LIMITED_STAKEHOLDER|LIMITED_USER|RESTRICTED_ACCESS (uppercased server-side). Sends real registration emails. Invited users are PENDING until they accept — can't be added to routines/policies until active.
      invite:(invitees)=>post('/configurations/users/requested/add',{data:invitees}),
      cancelInvite:(email)=>post('/configurations/users/requested/cancel',{email}),
      resendInvite:(email)=>post('/configurations/users/requested/resend-code',{email}),
      // user-management writes (payloads extracted from user_list.js). user_role enum as in invite().
      editRole:(preferred_username,user_role)=>post('/configurations/users/edit-role',{preferred_username,user_role}),
      unlock:(preferred_username)=>post('/configurations/users/unlock',{preferred_username}), // clear a lockout
      del:(member_name,transfer_to=null)=>post('/configurations/users/delete',transfer_to?{member_name,transfer_to}:{member_name}), // transfer_to = reassign their on-call/incidents to another user
      onCallShifts:(username,body={})=>post('/configurations/users/on-call-shifts/'+username,body) },
    analytics:{ incidents:(start_date,end_date,timezone='America/New_York')=>post('/analytics/incidents',{start_date,end_date,timezone}) },
    // on-call override engine — temporary swaps. routine = name (case-insensitive) or ref id.
    // Dates are 'YYYY-MM-DD'. Users are preferred_usernames (e.g. 'jdoe') — see TC.users.names().
    oncall:{
      // who is on-call. {at:'ISO'} for an instant, or {from,to} for a per-shift breakdown over a date range.
      whosOn: async(routine, opts={})=>{ const r=await _findRoutine(routine); const L=r.routine_layers||[];
        if(opts.at){ const T=new Date(opts.at); const on=new Set();
          _resolveIvs(L,_addDays(_dstr(T),-1),_dstr(T)).filter(iv=>iv.start<=T&&T<iv.end).forEach(iv=>iv.roster.forEach(u=>on.add(u))); // from-1: catch an overnight shift begun the prior evening still covering T
          return {routine:r.routine_name, at:opts.at, on_call:[...on]}; }
        const from=opts.from||_dstr(new Date()), to=opts.to||from;
        return {routine:r.routine_name, from, to, shifts:_resolveIvs(L,from,to).map(iv=>({date:iv.date, start:_hms(iv.start), end:_hms(iv.end), on_call:iv.roster}))}; },
      // list active overrides (dated tiles) AND covers (open-ended base substitutions)
      list: async routine=>{ const r=await _findRoutine(routine); const L=r.routine_layers||[];
        return {routine:r.routine_name,
          overrides:_readDirectives(L).map(d=>({alias:d.alias, out:d.out, in:d.in, from:d.from, to:d.to})),
          sets:_readSets(L).map(s=>({alias:s.alias, from:s.from, to:s.to, roster:s.roster, timeOff:!s.roster.length})),
          covers:_readCovers(L).map(c=>({out:c.out, in:c.in, until:'removed'}))}; },
      // resolved per-shift view for the GUI: shifts + the set of people who are "covering" (override/cover in) and
      // who is "covered" (out → in). Person-level attribution (good enough to colour the timeline + show ghost rows).
      whosOnView: async(routine,opts={})=>{ const r=await _findRoutine(routine); return _viewFrom(r,opts); },
      // who is on per SLOT (per-layer lanes) — resolves a fetched routine via _slotsFrom.
      whosOnSlots: async(routine,opts={})=>{ const r=await _findRoutine(routine); return _slotsFrom(r,opts); },
      // POLICY COVERAGE — the REAL on-call picture for an escalation policy over [from,to]. A policy level can reference
      // SEVERAL routines (e.g. a weekday primary + a weekend routine); this UNIONS all routines on each level (resolving
      // each routine's FINAL schedule — base + its live overrides — by concatenating their layers and resolving once).
      // Returns per-level shifts + first-responder (level-1) coverage GAPS: any time in range with no REAL person on
      // (the No One placeholder does NOT count as covered). Reads escalation-policies + routines (no writes). policy = name or ref.
      policyCoverage: async(policy, opts={})=>{
        const from=opts.from||_dstr(new Date()), to=opts.to||from, fromX=_addDays(from,-1); // -1 day for overnight carry-in
        const pols=await post('/configurations/escalation-policies'); const list=Array.isArray(pols)?pols:[];
        const p=list.find(x=>String(x.policy_name||x.escalation_policy_name||x.name||'')===String(policy)||x.escalation_policy_ref_id===policy||x.policy_ref_id===policy);
        if(!p) return {error:'Escalation policy not found: "'+policy+'".'};
        const lvls=p.levels||p.escalation_levels||[]; const rcache={}; const unreadable={};
        // resolve a routine's FINAL slices (base + its own live overrides), cached by ref. A FAILED read (sentinel/HTML)
        // is recorded as unreadable — NOT silently treated as an empty routine, which would fabricate a coverage gap.
        const ivsOf=async ref=>{ if(rcache[ref]!==undefined) return rcache[ref]; let ivs=[];
          try{ const r=await post('/configurations/routines/'+ref); if(_dead(r)||!Array.isArray(r.routine_layers)) unreadable[ref]=1; else ivs=_resolveIvs(r.routine_layers, fromX, to); }catch(e){ unreadable[ref]=1; } return (rcache[ref]=ivs); };
        const out=[]; let firstBands=null, firstRefs=null;
        for(let i=0;i<lvls.length;i++){ const Lv=lvls[i]; const rs=Lv.routines||Lv.routine_refs||[]; const arr=Array.isArray(rs)?rs:[rs];
          const names=arr.map(x=>Array.isArray(x)?x[0]:(x&&x.routine_name)||String(x));
          const refs=arr.map(x=>Array.isArray(x)?x[1]:(x&&x.routine_ref_id)||x);
          const bands=_unionSlices(await Promise.all(refs.map(ivsOf))); if(i===0){ firstBands=bands; firstRefs=refs; }
          out.push({ level:(Lv.assignee_level!=null?Lv.assignee_level:i+1), minutes:(Lv.level_minutes!=null?Lv.level_minutes:null), routines:names,
            shifts:bands.filter(b=>b.endMs>+_pd(from)).map(b=>({startMs:b.startMs, endMs:b.endMs, date:b.date, start:_hms(b.start), end:_hms(b.end),
              on_call:b.roster.slice(), real:b.roster.filter(u=>u!=='no-one')})) }); }
        // first-responder gaps: span [from 00:00, to+1 00:00) minus the time level-1 has a REAL person on.
        // Sub-resolution slivers are filtered (minGapMinutes, default 2) — TaskCall personal routines default to
        // shift_length 23:59, which would otherwise report a meaningless 60s "gap" at every midnight.
        const minGapMs=(opts.minGapMinutes!=null?opts.minGapMinutes:2)*60000;
        const gaps=[]; if(firstBands){ const spanS=+_pd(from), spanE=+_pd(_addDays(to,1));
          const cov=firstBands.filter(b=>b.roster.some(u=>u!=='no-one')).map(b=>[b.startMs,b.endMs]).sort((a,b)=>a[0]-b[0]);
          const merged=[]; cov.forEach(c=>{ const m=merged[merged.length-1]; if(m&&c[0]<=m[1]){ if(c[1]>m[1]) m[1]=c[1]; } else merged.push([c[0],c[1]]); });
          let cur=spanS; merged.forEach(m=>{ if(m[0]>cur && m[0]<spanE) gaps.push([cur,Math.min(m[0],spanE)]); if(m[1]>cur) cur=m[1]; }); if(cur<spanE) gaps.push([cur,spanE]); }
        // if any LEVEL-1 routine couldn't be read, its real responders are unknown — don't claim gaps we can't verify.
        const l1Unreadable=(firstRefs||[]).some(ref=>unreadable[ref]); const unreadList=Object.keys(unreadable);
        return { policy:(p.policy_name||p.escalation_policy_name||p.name), ref:(p.escalation_policy_ref_id||p.policy_ref_id), timezone:'America/New_York', from, to, levels:out,
          coverageUnknown:l1Unreadable||undefined, unreadable:unreadList.length?unreadList:undefined,
          gaps:l1Unreadable?[]:gaps.filter(x=>x[1]-x[0]>=minGapMs).map(x=>({startMs:x[0], endMs:x[1], date:_dstr(new Date(x[0])), start:_hms(new Date(x[0])), endDate:_dstr(new Date(x[1])), end:_hms(new Date(x[1])), hours:Math.round((_wm(new Date(x[1]))-_wm(new Date(x[0]))+1440*_daysBetween(_dstr(new Date(x[0])),_dstr(new Date(x[1]))))/6)/10})) }; },
      // COMBINED COVERAGE SLOTS — for ONE escalation-policy level, the slot-lanes of ALL its routines stacked into a
      // single timeline source (so a level that pages "Weekend Secondary + Default Routine" shows both routines' lanes
      // together). Each routine resolved independently via _slotsFrom (its own live overrides); lane names prefixed by
      // routine when the level has >1. opts.level = assignee_level to show; default = the first level that unions >1
      // routine (the interesting one), else the first. Read-only. Also returns a `levels` summary for a level picker.
      coverageSlots: async(policy, opts={})=>{
        const from=opts.from||_dstr(new Date()), to=opts.to||from;
        const pols=await post('/configurations/escalation-policies'); const list=Array.isArray(pols)?pols:[];
        const p=list.find(x=>String(x.policy_name||x.escalation_policy_name||x.name||'')===String(policy)||x.escalation_policy_ref_id===policy||x.policy_ref_id===policy);
        if(!p) return {error:'Escalation policy not found: "'+policy+'".'};
        const lvls=p.levels||p.escalation_levels||[]; const rsOf=L=>{ const rs=L.routines||L.routine_refs||[]; return Array.isArray(rs)?rs:[rs]; };
        const lvlNum=(L,i)=>(L.assignee_level!=null?L.assignee_level:i+1); // match + echo must use the SAME numbering
        let idx;
        if(opts.level!=null){ idx=lvls.findIndex((L,i)=>String(lvlNum(L,i))===String(opts.level));
          if(idx<0) return {error:'Level '+opts.level+' not found on "'+(p.policy_name||p.escalation_policy_name||p.name)+'".'}; }
        else { const m=lvls.findIndex(L=>rsOf(L).length>1); idx=m>=0?m:0; }
        const Lv=lvls[idx]||{}; const arr=rsOf(Lv); const slots=[]; let tz; const unreadable=[];
        for(const x of arr){ const name=Array.isArray(x)?x[0]:((x&&x.routine_name)||String(x)); const ref=Array.isArray(x)?x[1]:((x&&x.routine_ref_id)||x);
          let r; try{ r=await post('/configurations/routines/'+ref); }catch(e){ r=null; }
          if(!r || (r.__status&&r.__status>=400) || (typeof r.__text==='string' && r.__text.indexOf('<')>=0)){ unreadable.push(name); continue; } // fetch failed/404 → record as UNREADABLE (not the same as 'no shifts'), so the panel can say "data unavailable" instead of an empty lane
          if(tz==null && r.timezone) tz=r.timezone;
          const sd=_slotsFrom({routine_name:name, timezone:r.timezone||'America/New_York', routine_layers:r.routine_layers||[]}, {from,to});
          // keep the RAW slot name + tag the source routine; the panel groups lanes by routine (a routine header row),
          // so the lane label stays the short slot name instead of a long "<routine> · <slot>" that would truncate.
          (sd&&sd.slots||[]).forEach(sl=>slots.push(Object.assign({}, sl, { routine:name }))); }
        return { policy:(p.policy_name||p.escalation_policy_name||p.name), timezone:tz||'America/New_York', from, to, slots,
          unreadable:unreadable.length?unreadable:undefined, coverageUnknown:unreadable.length?true:undefined,
          level:lvlNum(Lv,idx), routines:arr.map(x=>Array.isArray(x)?x[0]:((x&&x.routine_name)||String(x))) }; },
      // PREVIEW — resolve a HYPOTHETICAL schedule from explicit layers (swap()/swapSlot() {dryRun}.previewLayers) WITHOUT
      // saving, so a UI can show the resulting Slots/People views BEFORE the operator applies. meta={routine_name,timezone}.
      slotsFromLayers:(meta,layers,opts={})=>_slotsFrom({routine_name:(meta&&meta.routine_name)||'', timezone:(meta&&meta.timezone)||'America/New_York', routine_layers:layers||[]},opts),
      viewFromLayers:(meta,layers,opts={})=>_viewFrom({routine_name:(meta&&meta.routine_name)||'', timezone:(meta&&meta.timezone)||'America/New_York', routine_layers:layers||[]},opts),
      // surgical swap: replace `out` with `inUser` wherever `out` is on between from..to (inclusive). Everyone
      // else on those shifts is preserved. {dryRun:true} previews without saving. Pass in='' to REMOVE without a
      // sub (only allowed when others remain on the shift). Time-boxed: overrides are dated tiles that stop applying at valid_end.
      swap: async(routine,out,inUser,from,to,opts={})=>{
        if(_badOvrUser(out) || (inUser && _badOvrUser(inUser))) return {applied:false, warning:'username contains a reserved character ("~" or ";") — overrides can\'t encode it.'};
        const r=await _findRoutine(routine);
        const existing=_readDirectives(r.routine_layers||[]); const f=String(from).slice(0,10), t=String(to||from).slice(0,10);
        const alias=opts.alias||_nextAlias(existing);
        const conflict=existing.find(d=>d.out===out && !(t<d.from||f>d.to));
        const comp=_compile(r, existing.concat([{alias,out,in:inUser==null?'':inUser,from:f,to:t}]));
        const mine=comp.changes.filter(c=>c.via.indexOf(alias)>=0);
        if(!mine.length) return {applied:false, conflictWith:conflict?conflict.alias:null, warning:conflict
          ? '"'+out+'" is already overridden by "'+conflict.alias+'" in that window — cancel it first, or pick a different person to swap.'
          : 'No shifts for "'+out+'" between '+f+' and '+t+' on routine "'+r.routine_name+'" — nothing to swap.'};
        // A SET coverage/time-off tile is AUTHORITATIVE for its window; a surgical swap landing inside it would just UNION
        // back in (the real resolver can't suppress one exception with another). Refuse rather than silently double-staff.
        const sets=_readSets(r.routine_layers||[]); const setCov=[]; sets.forEach(s=>_setCover(s.from,s.to,s.rs,s.sl,s.skip).forEach(iv=>setCov.push(iv)));
        if(setCov.length){ const myTiles=comp.tiles.filter(L=>_readDirectives([L]).some(x=>x.alias===alias));
          if(_resolveIvs(myTiles,_addDays(f,-1),_addDays(t,1)).some(sl=>_hitsIv(+sl.start,+sl.end,setCov)))
            return {applied:false, conflictWith:conflict?conflict.alias:null, warning:'That window is governed by a Set/time-off coverage override — cancel it first, or use Set coverage to change who is on then.'}; }
        if(opts.dryRun) return {applied:false, dryRun:true, alias, conflictWith:conflict?conflict.alias:null, changes:mine, previewLayers:comp.layers};
        await _save(r, comp.layers);
        return {applied:true, alias, routine:r.routine_name, conflictWith:conflict?conflict.alias:null, changes:mine}; },
      // SHIFT-targeted override: replace whoever is on a SLOT (base layer, by its display name) with
      // inUser over [from..to] — FOLLOWS the rotation by resolving the slot's occupant PER DAY via _resolveIvs (so
      // multi-day/weekly runs, and runs already in progress at `from`, are handled — resolves from f-1 for carry-in),
      // then swaps each occupant across their own contiguous run. inUser='' removes (others must remain on the band).
      // Reuses swap()'s recompile/blanket tiles; aims by slot. Errors if the slot name is ambiguous (two layers share
      // it). conflictWith mirrors swap(). (Caveat: substitution matches by roster membership, so a resolved occupant
      // who also sits on another slot the same day is swapped there too — fine for one-slot-per-person routines.) {dryRun}.
      swapSlot: async(routine,slotName,inUser,from,to,opts={})=>{ const r=await _findRoutine(routine); const all=r.routine_layers||[];
        const matches=all.filter(x=>!x.is_exception && String(_baseOf(x.layer_name)).trim()===String(slotName).trim());
        if(!matches.length) return {applied:false, warning:'No slot "'+slotName+'" on routine "'+r.routine_name+'".'};
        if(matches.length>1) return {applied:false, warning:'Slot name "'+slotName+'" matches '+matches.length+' layers — ambiguous; rename one or use a person swap.'};
        const L=matches[0]; const f=String(from).slice(0,10), t=String(to||from).slice(0,10);
        // per-DAY occupants of this slot over [f,t] (resolve from f-1 so a run already in progress at `from` is caught)
        const occDays={}; _resolveIvs([L], _addDays(f,-1), t).forEach(sl=>{ if(sl.date<f||sl.date>t) return;
          sl.roster.forEach(u=>{ if(u!==inUser) (occDays[u]=occDays[u]||{})[sl.date]=1; }); });
        const people=Object.keys(occDays);
        if(!people.length) return {applied:false, warning:'Nobody to replace on slot "'+slotName+'" between '+f+' and '+t+'.'};
        const badU=[inUser].concat(people).filter(u=>u&&_badOvrUser(u));
        if(badU.length) return {applied:false, warning:'username contains a reserved character ("~" or ";") — can\'t encode an override for: '+badU.join(', ')+'.'};
        const existing=_readDirectives(all); let mx=0; existing.forEach(d=>{ const m=/^ovr(\d+)$/.exec(d.alias||''); if(m) mx=Math.max(mx,+m[1]); });
        const newDirs=[], aliases=[];
        people.forEach(u=>{ const ds=Object.keys(occDays[u]).sort(); let i=0; while(i<ds.length){ let j=i; while(j+1<ds.length && _addDays(ds[j],1)===ds[j+1]) j++;
          const alias='ovr'+(++mx); aliases.push(alias); newDirs.push({alias, out:u, in:inUser==null?'':inUser, from:ds[i], to:ds[j]}); i=j+1; } });
        const conflict=existing.filter(d=>people.indexOf(d.out)>=0 && !(t<d.from||f>d.to)).map(d=>d.alias);
        const comp=_compile(r, existing.concat(newDirs));
        const mine=comp.changes.filter(c=>aliases.some(a=>c.via.indexOf(a)>=0));
        if(!mine.length) return {applied:false, warning:'No change for slot "'+slotName+'" in that window (already '+(inUser||'removed')+'?).'};
        const sSets=_readSets(all); const sCov=[]; sSets.forEach(s=>_setCover(s.from,s.to,s.rs,s.sl,s.skip).forEach(iv=>sCov.push(iv)));
        if(sCov.length){ const myTiles=comp.tiles.filter(L=>_readDirectives([L]).some(x=>aliases.indexOf(x.alias)>=0));
          if(_resolveIvs(myTiles,_addDays(f,-1),_addDays(t,1)).some(sl=>_hitsIv(+sl.start,+sl.end,sCov)))
            return {applied:false, warning:'Part of that window is governed by a Set/time-off coverage override — cancel it first, or use Set coverage to change who is on then.'}; }
        if(opts.dryRun) return {applied:false, dryRun:true, slot:slotName, aliases, replaced:people, conflictWith:conflict.length?conflict:null, changes:mine, previewLayers:comp.layers};
        await _save(r, comp.layers);
        return {applied:true, slot:slotName, aliases, replaced:people, conflictWith:conflict.length?conflict:null, routine:r.routine_name, changes:mine}; },
      // SET COVERAGE / TIME-OFF: set the on-call roster for [from,to] to EXACTLY `people`, as one
      // blanket exception tile that suppresses the base for the window — so it works no matter how many base lanes
      // exist (unlike swap, which can only substitute within an existing lane). people=[] with opts.timeOff=true is an
      // intentional no-one gap. The SET becomes the SOLE authority for [from,to]: any OVR swap that overlaps is CLIPPED to
      // exclude the window (its coverage OUTSIDE survives) and any SET tile overlapping is dropped — so nothing unions in.
      // opts.rotation_start/shift_length narrow it to part of a day (default whole day, validated ≤24:00). {dryRun} returns
      // previewLayers. SET tiles survive base edits (the unmanaged path in _compile preserves them, never re-resolves them).
      setRoster: async(routine, people, from, to, opts={})=>{ const r=await _findRoutine(routine); const all=r.routine_layers||[];
        const roster=(people||[]).filter(Boolean);
        if(roster.some(_badSetUser)) return {applied:false, warning:'a username contains a reserved character ("~" or ",") — can\'t encode it in a coverage override.'};
        const f=String(from||'').slice(0,10), t=String(to||from||'').slice(0,10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return {applied:false, warning:'Set valid coverage dates (YYYY-MM-DD).'};
        if(f>t) return {applied:false, warning:'From date is after To.'};
        if(!roster.length && !opts.timeOff) return {applied:false, warning:'Pick at least one person on-call, or turn on Time off for an intentional no-one gap.'};
        if(!roster.length){ const ph=await _noOneUser(); if(ph===null) return {applied:false, warning:'This TaskCall account has no "No One" placeholder user, which time-off / coverage-gap overrides require (TaskCall drops a truly-empty slot on save, so the gap wouldn\'t hold). Create a free service account named "No One" — it never gets paged — then try again.'}; }
        if(opts.shift_length!=null){ const sl=_slmin(opts.shift_length); if(sl<1||sl>_MAXSHIFT) return {applied:false, warning:'Coverage length must be 00:01–24:00 (split a longer span across days).'}; }
        // The new SET is AUTHORITATIVE for the time it ACTUALLY covers (band + overnight aware, NOT just its [f,t] date
        // range): any existing override whose real coverage intersects it is carved so only the parts OUTSIDE survive —
        // nothing unions in. Then recompile the untouched swaps onto base WITHOUT the old OVR/SET tiles.
        const newSetIvs=_setCover(f, t, opts.rotation_start||opts.rs, opts.shift_length||opts.sl, opts.skip_days||opts.skip);
        const dirs=_readDirectives(all); let mx=0; dirs.forEach(d=>{ const m=/^ovr(\d+)$/.exec(d.alias||''); if(m) mx=Math.max(mx,+m[1]); });
        let setCtr=0; _readSets(all).forEach(s=>{ const m=/^set(\d+)$/.exec(s.alias||''); if(m) setCtr=Math.max(setCtr,+m[1]); });
        const freshSet=()=>'set'+(++setCtr);
        const stripped={routine_ref_id:r.routine_ref_id, routine_name:r.routine_name, timezone:r.timezone, routine_layers:all.filter(L=> !(L.is_exception && /^(OVR:|SET:)/.test(L.layer_name||'')))};
        // OVR swaps: split each by DAY. A day whose shift doesn't touch the new SET stays a re-resolving directive (its
        // round-trip onto base edits is preserved); a day it DOES touch is baked to its surviving sub-bands (so the in-band
        // part is dropped — for a whole-day SET the survivor is empty, i.e. the swap simply doesn't apply there, exactly as
        // before; for a partial-day SET the swap survives OUTSIDE the band). _hitsIv tests the shift's real ms-interval, so
        // an overnight tail bleeding into the SET's day is caught even though the swap is dated the day before.
        const clearDirs=[], baked=[], removed=[];
        dirs.forEach(d=>{ const tilesD=_compile(stripped,[d]).tiles, byDate={}, hit={};
          _resolveIvs(tilesD,_addDays(d.from,-1),_addDays(d.to,1)).forEach(sl=>{ if(sl.date<d.from||sl.date>d.to) return; (byDate[sl.date]=byDate[sl.date]||[]).push(sl); if(_hitsIv(+sl.start,+sl.end,newSetIvs)) hit[sl.date]=1; });
          const days=[]; for(let x=d.from; x<=d.to; x=_addDays(x,1)) days.push(x);
          let i=0, first=true;
          while(i<days.length){ if(hit[days[i]]){ removed.push(d.alias);
              (byDate[days[i]]||[]).forEach(sl=>_subIv(+sl.start,+sl.end,newSetIvs).forEach(([a,b])=>baked.push(_bakedSet(freshSet(),a,b,sl.roster)))); i++; }
            else { let j=i; while(j+1<days.length && !hit[days[j+1]]) j++;
              clearDirs.push({alias:first?d.alias:'ovr'+(++mx), out:d.out, in:d.in, from:days[i], to:days[j]}); first=false; i=j+1; } } });
        // SET tiles: kept verbatim if their coverage misses the new band; otherwise baked to their surviving sub-bands.
        const keptSets=[]; _readSets(all).forEach(s=>{ const cov=_setCover(s.from,s.to,s.rs,s.sl,s.skip);
          if(!cov.some(([cs,ce])=>_hitsIv(cs,ce,newSetIvs))){ keptSets.push(_setLayer(s.alias,s.from,s.to,s.roster,s)); return; }
          removed.push(s.alias); cov.forEach(([cs,ce])=>_subIv(cs,ce,newSetIvs).forEach(([a,b])=>keptSets.push(_bakedSet(freshSet(),a,b,s.roster)))); });
        let comp; try{ comp=_compile(stripped, clearDirs); }catch(e){ return {applied:false, warning:e.message}; }
        const alias=opts.alias || freshSet();
        const newTile=_setLayer(alias, f, t, roster, opts);
        const finalLayers=comp.layers.concat(keptSets).concat(baked).concat([newTile]);
        const replaced=[...new Set(removed)].length;
        if(opts.dryRun) return {applied:false, dryRun:true, alias, roster, timeOff:!roster.length, replaced, from:f, to:t, previewLayers:finalLayers};
        await _save(r, finalLayers);
        return {applied:true, alias, routine:r.routine_name, roster, timeOff:!roster.length, replaced, from:f, to:t}; },
      // EXTEND A SHIFT (keep this person on past their normal end): plan a SET for the OVERFLOW
      // window [slot's current end → newEnd] on `date`, carrying the slot's occupant PLUS everyone else already on then
      // (so the extension adds the person, it doesn't blank the concurrent crew). Read-only planner — returns a plan to
      // feed setRoster (which the panel previews/applies). Same-day extensions only; overnight shifts → use Set coverage.
      planExtend: async(routine, slotName, date, newEnd) => {
        const r=await _findRoutine(routine); const all=r.routine_layers||[];
        const d=String(date||'').slice(0,10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return {ok:false, warning:'Pick a valid date (YYYY-MM-DD).'};
        const slot=all.find(L=>!L.is_exception && _baseOf(L.layer_name).trim()===String(slotName).trim());
        if(!slot) return {ok:false, warning:'No rotation named "'+slotName+'".'};
        const mm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
        const oldEndMin=_slmin(slot.rotation_start)+_slmin(slot.shift_length);
        if(oldEndMin>=1440) return {ok:false, warning:'That shift runs overnight — extend it via Set coverage directly.'};
        const newEndMin=_slmin(newEnd);
        if(newEndMin<=oldEndMin) return {ok:false, warning:'New end ('+mm(newEndMin)+') must be after the shift\'s current end ('+mm(oldEndMin)+').'};
        if(newEndMin>_MAXSHIFT) return {ok:false, warning:'New end must be within the same day (≤ 24:00).'};
        const winS=+new Date(d+'T'+mm(oldEndMin)+':00'), winE=+new Date(d+'T'+mm(newEndMin)+':00');
        const occ=[]; _resolveIvs([slot], _addDays(d,-1), d).forEach(s=>{ if(s.date===d) s.roster.forEach(u=>{ if(u!=='no-one'&&occ.indexOf(u)<0)occ.push(u); }); });
        const eff=[]; _resolveIvs(all, _addDays(d,-1), d).forEach(s=>{ if(+s.start<winE && +s.end>winS) s.roster.forEach(u=>{ if(u!=='no-one'&&eff.indexOf(u)<0)eff.push(u); }); });
        const roster=[...new Set(eff.concat(occ))];
        if(!roster.length) return {ok:false, warning:'No real person is on "'+slotName+'" on '+d+' — nothing to extend.'};
        return {ok:true, slot:slotName, occupant:occ, roster, from:d, to:d, rotation_start:mm(oldEndMin)+':00', shift_length:mm(newEndMin-oldEndMin)}; },
      // cancel one override by alias (OVR swap → recompile the rest; SET coverage → drop its tile); clearAll removes all
      cancel: async(routine,alias)=>{ const r=await _findRoutine(routine); const all=r.routine_layers||[];
        if(_readSets(all).some(s=>s.alias===alias)){ const kept=all.filter(L=> !(L.is_exception && (L.layer_name||'').slice(0,4)==='SET:' && (L.layer_name||'').slice(4).split('~')[0]===alias));
          await _save(r, kept); return {cancelled:true, alias, kind:'set'}; }
        const ds=_readDirectives(all);
        const keep=ds.filter(d=>d.alias!==alias); if(keep.length===ds.length) return {cancelled:false, warning:'No override "'+alias+'" on routine "'+r.routine_name+'"'};
        let comp; try{ comp=_compile(r,keep); }catch(e){ return {cancelled:false, error:e.message, warning:e.message}; }
        await _save(r, comp.layers); return {cancelled:true, alias, remaining:keep.map(d=>d.alias)}; },
      clearAll: async routine=>{ const r=await _findRoutine(routine);
        const synthetic={routine_ref_id:r.routine_ref_id, routine_name:r.routine_name, timezone:r.timezone, routine_layers:(r.routine_layers||[]).filter(L=> !(L.is_exception && (L.layer_name||'').slice(0,4)==='SET:'))};
        await _save(r,_compile(synthetic,[]).layers); return {cleared:true, routine:r.routine_name}; },
      // re-emit tiles from the CURRENT directives without changing who's overridden — applies the latest
      // coalescing/engine logic to tidy existing overrides. Resolves identically; only the tile count shrinks.
      recompile: async routine=>{ const r=await _findRoutine(routine); const before=(r.routine_layers||[]).filter(L=>(L.layer_name||'').slice(0,4)==='OVR:').length;
        const ds=_readDirectives(r.routine_layers||[]); let comp; try{ comp=_compile(r,ds); }catch(e){ return {recompiled:false, error:e.message, warning:e.message}; }
        await _save(r,comp.layers);
        return {recompiled:true, routine:r.routine_name, overrides:ds.map(d=>d.alias), tilesBefore:before, tilesAfter:comp.tiles.length}; },
      // COVER X with Y UNTIL REMOVED — phase-preserving name swap in the BASE rotations (everywhere X appears),
      // indefinite (no end date, no tiles, no horizon), reversible via uncover. For unknown-return absences
      // (extended leave). For a bounded/known window use swap instead. Co-on people are untouched automatically.
      cover: async(routine,out,inUser)=>{ if(!inUser) throw new Error('cover needs a replacement person (--in)');
        if(_badCovUser(out)||_badCovUser(inUser)) return {covered:false, warning:'username contains a reserved character (">", "@", or " |COV:") — cover markers can\'t encode it.'};
        const r=await _findRoutine(routine); const layers=r.routine_layers||[];
        const covs=_readCovers(layers), dirs=_readDirectives(layers);
        if(covs.some(c=>c.out===out)) return {covered:false, warning:'"'+out+'" is already covered on this routine — uncover them first.'};
        if(covs.some(c=>c.in===out)) return {covered:false, warning:'"'+out+'" is currently a cover replacement for someone else — uncover that first, or use a dated swap.'};
        // reversal needs the cover person FRESH: not a base participant, an override-in, or an existing cover-in
        const alreadyOn=layers.some(L=>!L.is_exception && (L.rotations||[]).some(st=>st.some(p=>(Array.isArray(p)?p[1]:p)===inUser)));
        if(alreadyOn || dirs.some(d=>d.in===inUser) || covs.some(c=>c.in===inUser)) return {covered:false, warning:'"'+inUser+'" is already on this routine (or an active cover/override) — pick someone not already involved, or use a dated swap.'};
        let changed=0; const nl=layers.map(L=>{ if(L.is_exception) return L; const steps=[];
          const rot=(L.rotations||[]).map(function(st,si){ return st.map(function(p,gi){ const u=Array.isArray(p)?p[1]:p; if(u===out){ steps.push({s:si,g:gi}); return inUser; } return u; }); });
          if(!steps.length) return L; changed++; const pc=_parseCov(L.layer_name); pc.covs.push({out:out,in:inUser,steps:steps});
          return Object.assign({},L,{layer_name:_covName(pc.base,pc.covs), rotations:rot}); });
        if(!changed) return {covered:false, warning:'"'+out+'" is not in any base layer of "'+r.routine_name+'" — nothing to cover.'};
        await _save(r,nl); return {covered:true, routine:r.routine_name, out:out, in:inUser, layersChanged:changed, until:'removed'}; },
      // remove an open-ended cover: restore X at EXACTLY the positions cover() rewrote (legacy markers fall back to
      // name-based). conflict=true if a recorded position no longer holds the cover person (out-of-band edit) — left as-is.
      uncover: async(routine,out)=>{ const r=await _findRoutine(routine); const layers=r.routine_layers||[]; let restored=0, inUser=null, conflict=false;
        const nl=layers.map(L=>{ if(L.is_exception) return L; const pc=_parseCov(L.layer_name); const c=pc.covs.find(x=>x.out===out); if(!c) return L; inUser=c.in; restored++;
          var rot=(L.rotations||[]).map(function(st){ return st.slice(); });
          if(c.steps && c.steps.length){ c.steps.forEach(function(p){ const cell=rot[p.s]&&rot[p.s][p.g]; if(cell===undefined||cell===null) return; const cur=Array.isArray(cell)?cell[1]:cell; if(cur===c.in) rot[p.s][p.g]=out; else conflict=true; }); }
          else { rot=rot.map(function(st){ return st.map(function(p){ const u=Array.isArray(p)?p[1]:p; return u===c.in?out:u; }); }); }
          pc.covs=pc.covs.filter(function(x){ return !(x.out===out && x.in===c.in); });
          return Object.assign({},L,{layer_name:_covName(pc.base,pc.covs), rotations:rot}); });
        if(!restored) return {uncovered:false, warning:'No active cover for "'+out+'" on "'+r.routine_name+'".'};
        await _save(r,nl); var res={uncovered:true, routine:r.routine_name, out:out, restoredFrom:inUser, layersChanged:restored}; if(conflict) res.conflict='some shifts were edited since the cover was applied — restored only the original positions; verify the routine.'; return res; },
      // ===== STRUCTURAL EDIT (override-safe) — edit BASE rotations while dated overrides stay live =====
      // load the routine's BASE layers in the editable shape; OVR tiles are EXCLUDED (managed by swap/cover).
      // directives/covers are returned so the editor can warn before an edit that would drop one.
      loadBase: async routine=>{ const r=await _findRoutine(routine); const all=r.routine_layers||[];
        const base=all.filter(L=>!L.is_exception);
        return { ref:r.routine_ref_id, routine_name:r.routine_name, timezone:r.timezone||'America/New_York',
          layers:base.map(_editable), unmanagedCount:all.filter(L=>L.is_exception&&(L.layer_name||'').slice(0,4)!=='OVR:').length,
          directives:_readDirectives(all).map(d=>({alias:d.alias,out:d.out,in:d.in,from:d.from,to:d.to})),
          covers:_readCovers(all).map(c=>({out:c.out,in:c.in})) }; },
      // override-safe save: rebuild the base from `baseLayers` (editable shape) and RECOMPILE the OVR tiles from
      // the existing directives via _compile, so overrides re-land on the edited rotations atomically. Non-OVR
      // exceptions + cover markers are preserved. {dryRun} returns previewLayers (for the schedule preview) + the
      // set of directives DROPPED by the edit (their `out` no longer lands in-window → no tile). Never del+recreate.
      saveBase: async(routine, baseLayers, opts={})=>{ const r=await _findRoutine(routine); const all=r.routine_layers||[];
        if(!baseLayers||!baseLayers.length) return {applied:false, error:'A routine needs at least one rotation.'};
        const errs=baseLayers.map(_validateLayer).filter(Boolean); if(errs.length) return {applied:false, error:errs[0], errors:errs};
        const dup=_dupNameErr(baseLayers); if(dup) return {applied:false, error:dup};
        const unmanaged=all.filter(L=>L.is_exception&&(L.layer_name||'').slice(0,4)!=='OVR:');
        const newBase=baseLayers.map(_toStore);
        const newName=(opts.newName&&String(opts.newName).trim())||r.routine_name;
        const synthetic={ routine_ref_id:r.routine_ref_id, routine_name:newName, timezone:r.timezone, routine_layers:newBase.concat(unmanaged) };
        const dirs=_readDirectives(all); let comp;
        try{ comp=_compile(synthetic, dirs); }catch(e){ return {applied:false, error:e.message}; }
        const survived=_readDirectives(comp.layers); const dropped=dirs.filter(d=>!survived.some(s=>s.alias===d.alias)).map(d=>({alias:d.alias,out:d.out,in:d.in,from:d.from,to:d.to}));
        if(opts.dryRun) return {applied:false, dryRun:true, routine:newName, previewLayers:comp.layers, dropped, tilesAfter:comp.tiles.length, layerCount:newBase.length};
        await _save(synthetic, comp.layers);
        return {applied:true, routine:newName, dropped, tilesAfter:comp.tiles.length, layerCount:newBase.length}; },
      // create a brand-new named routine from editable base layers. Returns {created, result}.
      createRoutine: async(name, baseLayers, timezone)=>{ if(!String(name||'').trim()) return {created:false, error:'Routine name is required.'};
        if(!baseLayers||!baseLayers.length) return {created:false, error:'A routine needs at least one rotation.'};
        const errs=baseLayers.map(_validateLayer).filter(Boolean); if(errs.length) return {created:false, error:errs[0], errors:errs};
        const dup=_dupNameErr(baseLayers); if(dup) return {created:false, error:dup};
        const layers=baseLayers.map(_toStore).map((L,i)=>{ L.layer=i+1; return L; });
        const res=await post('/configurations/routines/create',{routine_name:String(name).trim(), timezone:timezone||'America/New_York', routine_layers:layers});
        if(res==null||(typeof res==='object'&&((res.__status&&res.__status>=400)||(typeof res.__text==='string'&&res.__text.indexOf('<')>=0)))) return {created:false, error:'create did not land (session expired or server rejected it).'};
        return {created:true, routine_name:String(name).trim(), result:res}; },
      // Export a routine to a portable JSON snapshot — FULL fidelity (base rotations + override tiles + cover
      // markers). Read-only: every bit of state is server-side, so this is just a serialisable copy of routine_layers.
      exportRoutine: async routine=>{ const r=await _findRoutine(routine);
        return { format:'taskcall-oncall-routine', version:1, routine_name:r.routine_name,
          timezone:r.timezone||'America/New_York', routine_layers:(r.routine_layers||[]).map(_cleanLayer) }; },
      // Create a NEW routine from an export snapshot. Recreates the BASE rotations (cover markers ride along in the
      // layer names) AND any deliberate exception layers — SET coverage/time-off tiles and native TaskCall overrides —
      // so a round-trip doesn't silently lose them. ONLY the extension's transient, dated OVR swap tiles are
      // dropped (they're dated to the source's timeline; copying them would resurrect stale swaps). Never edits an existing one.
      importRoutine: async(snap, newName)=>{
        if(!snap || snap.format!=='taskcall-oncall-routine' || !Array.isArray(snap.routine_layers)) return {created:false, error:'Not a valid routine export (missing the taskcall-oncall-routine marker).'};
        const name=String(newName||'').trim(); if(!name) return {created:false, error:'A name is required for the new routine.'};
        const isOvr=L=>L && L.is_exception && (L.layer_name||'').slice(0,4)==='OVR:';
        const keep=snap.routine_layers.filter(L=>L && !isOvr(L));
        const baseCount=keep.filter(L=>!L.is_exception).length;
        if(!baseCount) return {created:false, error:'The export has no base rotations to import.'};
        const setsKept=keep.filter(L=>L.is_exception).length, droppedOvr=snap.routine_layers.filter(isOvr).length;
        const layers=keep.map((L,i)=>{ const c=_cleanLayer(L); c.layer=i+1; return c; });
        const res=await post('/configurations/routines/create',{routine_name:name, timezone:snap.timezone||'America/New_York', routine_layers:layers});
        if(res==null||(typeof res==='object'&&((res.__status&&res.__status>=400)||(typeof res.__text==='string'&&res.__text.indexOf('<')>=0)))) return {created:false, error:'Import did not land (session expired or server rejected it).'};
        return {created:true, routine_name:name, layerCount:layers.length, baseCount, coverageTilesKept:setsKept, droppedOvrTiles:droppedOvr, result:res}; },
      // validate + convert editable base layers → STORE-shaped layers (no save). Used to PREVIEW a brand-new
      // routine via slotsFromLayers (no overrides to recompile). Returns {error} or {layers}.
      toStoreLayers: baseLayers=>{ if(!baseLayers||!baseLayers.length) return {error:'A routine needs at least one rotation.'};
        const errs=baseLayers.map(_validateLayer).filter(Boolean); if(errs.length) return {error:errs[0], errors:errs};
        const dup=_dupNameErr(baseLayers); if(dup) return {error:dup};
        return {layers:baseLayers.map(_toStore).map((L,i)=>{ L.layer=i+1; return L; })}; },
      // delete a whole routine — but FIRST scan escalation policies for the ref (a referenced routine, deleted,
      // orphans those policy levels). Returns {blocked, referencedBy} unless {force}. ref-scan is best-effort:
      // if the policy list can't be read it proceeds (the panel still confirms). Never used to "edit" a routine.
      deleteRoutine: async(routine, opts={})=>{ const r=await _findRoutine(routine); const ref=r.routine_ref_id; let referencedBy=[], checked=false;
        try{ const pols=await post('/configurations/escalation-policies');
          if(Array.isArray(pols)){ checked=true; pols.forEach(p=>{ const lvls=p.levels||p.escalation_levels||[];
            const hit=(Array.isArray(lvls)?lvls:[]).some(L=>{ const rs=L.routines||L.routine_refs||[]; return (Array.isArray(rs)?rs:[rs]).some(x=>{ const id=Array.isArray(x)?x[1]:(x&&x.routine_ref_id)||x; return id===ref; }); });
            if(hit) referencedBy.push(p.policy_name||p.escalation_policy_name||p.name||'(unnamed policy)'); }); }
        }catch(e){}
        if(referencedBy.length&&!opts.force) return {deleted:false, blocked:true, referencedBy, checked, routine:r.routine_name};
        const res=await post('/configurations/routines/delete',{routine_ref_id:ref});
        if(res==null||(typeof res==='object'&&((res.__status&&res.__status>=400)||(typeof res.__text==='string'&&res.__text.indexOf('<')>=0)))) return {deleted:false, error:'delete did not land.'};
        return {deleted:true, routine:r.routine_name, wasReferencedBy:referencedBy, refCheckRan:checked}; }
    }
  };
})();
'TC console loaded — ' + Object.keys(window.TC).filter(k=>k!=='raw').join(', ');

window.TC && (window.TC.__engineHash='77ee7ad5a28ed5e7');

// ---- panel ----
// On-call toolkit panel — the in-tab GUI for TaskCall on-call.
// Mounts a floating panel into a logged-in TaskCall app tab and drives the window.TC.oncall.* engine
// (engine.js, loaded alongside). Runs in the page MAIN world; inherits your session cookie, the page
// csrfToken, and prepareFinalSchedule — no server, no stored credentials. Every action is one TC.oncall.* call.
// Includes: a Week/Day SCHEDULE VIEWER (TC.oncall.whosOnView), surgical SWAP (dated override), COVER
// until removed (open-ended base substitution), and an active overrides+covers list with cancel/uncover.
// Drift guard: build.sh stamps the engine hash on window.TC.__engineHash; panel disables writes on mismatch.
// Styling via an ADOPTED stylesheet (TaskCall CSP blocks injected <style> elements). NO cross-operator lock.
(function () {
  if (window.__tcOncallPanel) return;
  // Run only on a TaskCall *app* host, any region (app.taskcallapp.com, app.us.…, app.eu.…) — not marketing/login subdomains.
  if (!/^app\.([a-z0-9-]+\.)?taskcallapp\.com$/i.test(location.hostname)) return;
  window.__tcOncallPanel = true;

  var ENGINE_HASH = '77ee7ad5a28ed5e7';
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var pad = function (n) { return String(n).padStart(2, '0'); };
  var fmt = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  var mondayOf = function (d) { var x = new Date(d); var wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var MAXDAYS = 186; // hard cap on a rendered day-axis (rangeDays); a longer From/To is truncated with a visible note
  var hNum = function (t) { var p = String(t || '0').split(':'); return (+p[0]) + (+p[1] || 0) / 60; };
  var fmtHM = function (h) { h = ((h % 24) + 24) % 24; var hh = Math.floor(h), mm = Math.round((h - hh) * 60); return pad(hh) + ':' + pad(mm); };
  var todayStr = function () { return fmt(new Date()); };
  var dayLabel = function (ds) { var d = new Date(ds + 'T00:00:00'); return DOW[d.getDay()] + ' ' + (+ds.slice(8, 10)); };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // format an engine {d:'YYYY-MM-DD', h:'HH:MM:SS'} pair → "Mon, Jun 22 · 17:00" for the hover popup
  var fmtDT = function (o) { if (!o || !o.d) return ''; var dt = new Date(o.d + 'T00:00:00'); return DOW[dt.getDay()] + ', ' + MON[dt.getMonth()] + ' ' + dt.getDate() + ' · ' + String(o.h || '').slice(0, 5); };

  // CSP: TaskCall blocks inline style ATTRIBUTES (style-src-attr) as well as <style> elements, so a style="..."
  // set via innerHTML is silently ignored. Dynamic styling is therefore emitted as data-css="..." and applied via
  // the CSSOM (el.style.cssText), which the CSP permits. Call after any innerHTML that may contain data-css.
  function applyCss(scope) { var s = scope || root; if (!s) return; s.querySelectorAll('[data-css]').forEach(function (el) { el.style.cssText = el.getAttribute('data-css'); el.removeAttribute('data-css'); }); }

  function looksDead(v) {
    if (v == null) return true;
    if (typeof v === 'object' && v.__status && v.__status >= 400) return true;
    if (typeof v === 'object' && typeof v.__text === 'string' && v.__text.indexOf('<') !== -1) return true;
    return false;
  }
  function engineReady() {
    return typeof window.TC === 'object' && window.TC && window.TC.oncall && window.TC.oncall.whosOnView &&
      typeof prepareFinalSchedule === 'function' && typeof csrfToken === 'string';
  }

  var state = { routines: [], routine: null, users: [], from: null, to: null, busy: false, drift: false, open: false,
    canPreview: false, schedView: 'slot', overlapSpan: 'day', swapTarget: 'slot', peopleCount: 0, slotCount: 0, schedDay: null, viewData: null, slotData: null, dayCache: null, coverMode: false, expanded: false, previewData: null,
    swapFrom: null, swapTo: null, setRoster: [], setTimeOff: false, setPartial: false,
    mode: 'view', edit: null, structPreview: false, structLayers: null,
    policy: null, policies: [], covFrom: null, covTo: null, covTime: null, covData: null,
    covView: 'ladder', covLevel: null, covSlots: null, covSlotsKey: null, covEpoch: 0, covDataEpoch: 0, viewEpoch: 0 };
  var root, $;

  function mount() {
    if (document.getElementById('tc-toolkit-host')) return;
    var host = document.createElement('div');
    host.id = 'tc-toolkit-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;isolation:isolate;pointer-events:none';
    (document.body || document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = SHELL;
    applyCss(root); // SHELL carries data-css (e.g. covernote display:none) the CSP would otherwise drop
    // CSP blocks injected <style> elements (their .sheet is null) — use an adopted stylesheet instead.
    try { var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch (e) { var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st); }
    $ = function (sel) { return root.querySelector(sel); };
    $('#launch').addEventListener('click', open);
    $('#close').addEventListener('click', function () { $('#panel').style.display = 'none'; state.open = false; });
    $('#expand').addEventListener('click', function () { state.expanded = !state.expanded; $('#panel').classList.toggle('xpand', state.expanded); $('#expand').textContent = state.expanded ? '⤡' : '⤢'; $('#expand').title = state.expanded ? 'Shrink' : 'Expand / full screen'; renderSched(); });
    $('#routine').addEventListener('change', function () {
      if (state.edit && (state.edit.dirty || state.edit.isNew) && !confirm('Discard unsaved changes to this routine?')) { $('#routine').value = state.edit.routine || state.routine; return; }
      state.routine = $('#routine').value; state.schedDay = null; state.edit = null; clearStructPreview(); clearPreview(); if (state.mode === 'edit') enterEdit(); else refreshAll();
    });
    root.querySelectorAll('[data-mode]').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });
    $('#ed-new').addEventListener('click', edNewRoutine);
    $('#ed-rename').addEventListener('click', edRenameRoutine);
    $('#ed-export').addEventListener('click', edExportRoutine);
    $('#ed-import').addEventListener('click', edImportRoutine);
    $('#ed-del').addEventListener('click', edDeleteRoutine);
    $('#ed-add').addEventListener('click', function () { edAddRotation(); });
    root.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { applyPreset(b.getAttribute('data-preset')); }); });
    root.querySelectorAll('[data-sview]').forEach(function (b) { b.addEventListener('click', function () { state.schedView = b.getAttribute('data-sview'); root.querySelectorAll('[data-sview]').forEach(function (x) { x.classList.toggle('on', x === b); }); renderSched(); }); });
    root.querySelectorAll('[data-target]').forEach(function (b) { b.addEventListener('click', function () { state.swapTarget = b.getAttribute('data-target'); root.querySelectorAll('[data-target]').forEach(function (x) { x.classList.toggle('on', x === b); }); syncTarget(); }); });
    $('#from').addEventListener('change', function () { state.from = $('#from').value; state.schedDay = null; if (state.structPreview) { reResolveStruct(); return; } clearPreview(); refreshAll(); });
    $('#to').addEventListener('change', function () { state.to = $('#to').value; state.schedDay = null; if (state.structPreview) { reResolveStruct(); return; } clearPreview(); refreshAll(); });
    $('#swapfrom').addEventListener('change', function () { state.swapFrom = $('#swapfrom').value; dropPreview(); });
    $('#swapto').addEventListener('change', function () { state.swapTo = $('#swapto').value; dropPreview(); });
    // changing who/what to swap must invalidate a shown dry-run preview, else Apply would commit the originally-previewed
    // person (apply binds the captured args). Drop the overlay and re-render the live schedule.
    var dropPreview = function () { if (state.previewData) { clearPreview(); renderSched(); } };
    $('#in').addEventListener('change', dropPreview);
    $('#out').addEventListener('change', dropPreview);
    var ssel0 = $('#slotsel'); if (ssel0) ssel0.addEventListener('change', dropPreview);
    $('#covermode').addEventListener('change', function () { state.coverMode = $('#covermode').checked; syncSwapUi(); });
    $('#set-addbtn').addEventListener('click', function () { var u = $('#set-add').value; if (!u) return; if (state.setRoster.indexOf(u) < 0) state.setRoster.push(u); if (state.setTimeOff) { state.setTimeOff = false; $('#set-timeoff').checked = false; } dropPreview(); renderSetChips(); });
    $('#set-timeoff').addEventListener('change', function () { state.setTimeOff = $('#set-timeoff').checked; if (state.setTimeOff) state.setRoster = []; dropPreview(); renderSetChips(); });
    $('#set-partial').addEventListener('change', function () { state.setPartial = $('#set-partial').checked; $('#set-hours').style.display = state.setPartial ? 'flex' : 'none'; dropPreview(); });
    $('#set-extend').addEventListener('click', edExtendShift);
    $('#set-start').addEventListener('change', dropPreview);
    $('#set-len').addEventListener('change', dropPreview);
    $('#primary').addEventListener('click', function () { state.swapTarget === 'set' ? doSetPreview() : (state.coverMode ? doCover() : doPreview()); });
    // Coverage mode wiring
    $('#covpolicy').addEventListener('change', function () { state.policy = $('#covpolicy').value; state.covLevel = null; renderCoverage(); }); // new policy → reset the timeline level pick to default
    $('#covfrom').addEventListener('change', function () { state.covFrom = $('#covfrom').value; renderCoverage(); });
    $('#covto').addEventListener('change', function () { state.covTo = $('#covto').value; renderCoverage(); });
    $('#covtime').addEventListener('change', function () { state.covTime = $('#covtime').value; if (state.covView === 'ladder') renderCovOut(); }); // ladder instant only — timeline is range-based
    root.querySelectorAll('[data-cpreset]').forEach(function (b) { b.addEventListener('click', function () { applyCovPreset(b.getAttribute('data-cpreset')); }); });
    root.querySelectorAll('[data-covview]').forEach(function (b) { b.addEventListener('click', function () { state.covView = b.getAttribute('data-covview'); root.querySelectorAll('[data-covview]').forEach(function (x) { x.classList.toggle('on', x === b); }); $('#covtimewrap').style.display = state.covView === 'ladder' ? '' : 'none'; renderCovOut(); }); });
    $('#covlevels').addEventListener('click', function (e) { var b = e.target.closest('[data-covlevel]'); if (!b) return; state.covLevel = +b.getAttribute('data-covlevel'); state.covSlots = null; state.covSlotsKey = null; renderCovOut(); });
    // delegated hover popup over any [data-nm] entry (works across re-renders of all three views)
    root.addEventListener('mouseover', function (e) { var t = e.target; var el = t && t.closest ? t.closest('[data-nm]') : null; if (el) showPop(el); else if (!(t && t.closest && t.closest('#tcpop'))) hidePop(); });
    root.addEventListener('mouseout', function (e) { var to = e.relatedTarget; if (!to || !(to.closest && to.closest('[data-nm]'))) hidePop(); });
    $('#eng').textContent = 'engine ' + ENGINE_HASH;
  }

  function open() {
    $('#panel').style.display = 'flex'; state.open = true;
    if (!engineReady()) { banner('Engine not loaded on this page. Open a TaskCall schedule/config page (e.g. /incidents) and reload.', 'err'); return; }
    state.drift = !!(window.TC.__engineHash && window.TC.__engineHash !== ENGINE_HASH);
    if (state.drift) banner('Engine drift: panel ' + ENGINE_HASH + ' vs loaded ' + window.TC.__engineHash + ' — rebuild via ./build.sh. Writes disabled.', 'err');
    if (!state.from) { var m = mondayOf(new Date()); state.from = fmt(m); state.to = fmt(addDays(m, 6)); }
    if (!state.swapFrom) { state.swapFrom = todayStr(); state.swapTo = todayStr(); }
    $('#from').value = state.from; $('#to').value = state.to;
    $('#swapfrom').value = state.swapFrom; $('#swapto').value = state.swapTo;
    bootstrap();
    // After a keep-interval re-mount the fresh SHELL defaults to View; replay a persisted non-view mode so the
    // seg highlight, body visibility, and #routinerow match state (Coverage/Edit re-fetch their own data).
    if (state.mode !== 'view') setMode(state.mode);
  }

  function applyPreset(p) {
    var now = new Date(), m;
    if (p === 'today') { state.from = fmt(now); state.to = fmt(now); }
    else if (p === 'tomorrow') { state.from = fmt(addDays(now, 1)); state.to = fmt(addDays(now, 1)); }
    else if (p === 'thisweek') { m = mondayOf(now); state.from = fmt(m); state.to = fmt(addDays(m, 6)); }
    else if (p === 'nextweek') { m = mondayOf(addDays(now, 7)); state.from = fmt(m); state.to = fmt(addDays(m, 6)); }
    else if (p === '2weeks') { m = mondayOf(now); state.from = fmt(m); state.to = fmt(addDays(m, 13)); }
    $('#from').value = state.from; $('#to').value = state.to; state.schedDay = null; if (state.structPreview) { reResolveStruct(); return; } clearPreview(); refreshAll();
  }

  async function bootstrap() {
    if (!state.drift) banner('', '');
    try {
      var list = await window.TC.routines.list();
      if (looksDead(list) || !Array.isArray(list)) return sessionDead();
      state.routines = list.map(function (r) { return r.routine_name; });
      var sel = $('#routine'); sel.innerHTML = state.routines.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
      if (!state.routine) state.routine = state.routines[0];
      sel.value = state.routine;
      var names = await window.TC.users.names();
      if (looksDead(names) || !Array.isArray(names)) return sessionDead();
      state.users = names;
      refreshAll();
    } catch (e) { sessionDead(e); }
  }

  function nameOf(u) { for (var i = 0; i < state.users.length; i++) if (state.users[i][1] === u) return state.users[i][0]; return u; }
  // one epoch per refreshAll: a routine/range change that fires a newer pass voids any in-flight resolve from this one,
  // so a slow stale fetch can't clobber fresh viewData/slotData or repaint the wrong routine's roster + cancel buttons.
  async function refreshAll() { var tok = ++state.viewEpoch; await Promise.all([refreshSched(tok), refreshActive(tok)]); }

  async function refreshSched(tok) {
    state.dayCache = null; // drop any on-demand out-of-range Day-view fetch; the range below is the fresh source
    var box = $('#sched'); box.innerHTML = '<div class="muted">loading…</div>';
    try {
      var v = await window.TC.oncall.whosOnView(state.routine, { from: state.from, to: state.to });
      if (tok !== state.viewEpoch) return; // superseded by a newer routine/range change — discard
      if (looksDead(v) || !v.shifts) return sessionDead();
      state.viewData = v;
      var sd = await window.TC.oncall.whosOnSlots(state.routine, { from: state.from, to: state.to });
      if (tok !== state.viewEpoch) return;
      state.slotData = (!looksDead(sd) && sd.slots) ? sd : null; // never keep a STALE slot grid on a transient slots-fetch failure
      var on = {}; v.shifts.forEach(function (s) { (s.on_call || []).forEach(function (u) { on[u] = 1; }); });
      var people = Object.keys(on);
      $('#out').innerHTML = people.length ? people.map(function (u) { return '<option value="' + esc(u) + '">' + esc(nameOf(u)) + '</option>'; }).join('') : '<option value="">(nobody on-call in view)</option>';
      $('#in').innerHTML = '<option value="">(remove — no cover)</option>' + state.users.map(function (p) { return '<option value="' + esc(p[1]) + '">' + esc(p[0]) + '</option>'; }).join('');
      var sa = $('#set-add'); if (sa) sa.innerHTML = state.users.filter(function (p) { return p[1] !== 'no-one'; }).map(function (p) { return '<option value="' + esc(p[1]) + '">' + esc(p[0]) + '</option>'; }).join('');
      renderSetChips();
      var slots = (state.slotData && state.slotData.slots) || [];
      var ssel = $('#slotsel'); if (ssel) ssel.innerHTML = slots.length ? slots.map(function (x) { return '<option>' + esc(x.slot) + '</option>'; }).join('') : '<option value="">(no slots)</option>';
      state.peopleCount = people.length; state.slotCount = slots.length;
      state.canPreview = state.swapTarget === 'slot' ? slots.length > 0 : people.length > 0;
      var dates = schedDates(); if (!state.schedDay || dates.indexOf(state.schedDay) < 0) state.schedDay = dates.indexOf(todayStr()) >= 0 ? todayStr() : dates[0];
      renderSched(); updateControls();
    } catch (e) { sessionDead(e); }
  }

  function schedDates() { var v = state.viewData; if (!v) return []; var s = {}; v.shifts.forEach(function (x) { s[x.date] = 1; }); return Object.keys(s).sort(); }

  // %24 on the hour: some Chrome/V8 builds emit hour='24' at local midnight under hour12:false, which would push the
  // now-line a full day right and break the 'on now' match. Minutes are unaffected.
  function nowInTz(tz) { try { var p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; }); return { date: p.year + '-' + p.month + '-' + p.day, h: ((+p.hour) % 24) + (+p.minute) / 60 }; } catch (e) { var d = new Date(); return { date: todayStr(), h: d.getHours() + d.getMinutes() / 60 }; } }
  // per-shift coverage: cover-ins are always covering (they exist only as covers here); override-ins only inside their dated window.
  function coverPred(v) { var ci = {}; (v.covers || []).forEach(function (c) { ci[c.in] = 1; }); var ov = v.overrides || [];
    return function (u, date) { if (ci[u]) return true; for (var i = 0; i < ov.length; i++) if (ov[i].in === u && date >= ov[i].from && date <= ov[i].to) return true; return false; }; }
  function addDayStr(ds, n) { return fmt(addDays(new Date(ds + 'T00:00:00'), n)); }
  function rangeDays(from, to) { var a = []; for (var d = from; d <= to; d = addDayStr(d, 1)) { a.push(d); if (a.length >= MAXDAYS) break; } return a; }
  // visible notice when rangeDays truncated the requested window, so a long From/To isn't silently cut to a blank tail.
  function truncNote(to, days) { return (days.length && days[days.length - 1] < to) ? '<div class="muted" data-css="margin:2px 0 6px">Showing the first ' + days.length + ' days — narrow the From/To range to see the rest.</div>' : ''; }
  function dateRangeLabel(a, b) { var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00'); return M[da.getMonth()] + ' ' + da.getDate() + (a === b ? '' : ' – ' + M[db.getMonth()] + ' ' + db.getDate()); }

  var PAL = [{ bg: '#E6F1FB', bd: '#85B7EB', tx: '#0C447C' }, { bg: '#E1F5EE', bd: '#5DCAA5', tx: '#085041' }, { bg: '#EEEDFE', bd: '#AFA9EC', tx: '#3C3489' }, { bg: '#FAEEDA', bd: '#EF9F27', tx: '#633806' }, { bg: '#FBEAF0', bd: '#ED93B1', tx: '#72243E' }, { bg: '#EAF3DE', bd: '#97C459', tx: '#27500A' }, { bg: '#F1EFE8', bd: '#B4B2A9', tx: '#444441' }];
  function colorOf(u) { var h = 0; for (var i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0; return PAL[h % PAL.length]; }
  function initials(u) { var n = nameOf(u), p = n.split(/\s+/); return ((p[0] ? p[0][0] : '') + (p[1] ? p[1][0] : (p[0] ? (p[0][1] || '') : ''))).toUpperCase(); }

  function renderSched() {
    var sd = effSlot(), vd = effView();
    if (state.schedView === 'slot') { sd ? renderSlots(sd) : ($('#sched').innerHTML = '<div class="muted">no slot data</div>'); }
    else if (state.schedView === 'day') { sd ? renderDay(sd) : ($('#sched').innerHTML = '<div class="muted">no slot data</div>'); }
    else { vd ? renderWeek(vd) : ($('#sched').innerHTML = '<div class="muted">no data</div>'); }
    if (state.previewData) injectPreviewTag();
  }

  // 3-section breakdown (per-slot lanes × per-day chips): ROTATIONS (base schedule, pre dated-override),
  // OVERRIDES (sparse — only the dated swaps, coral, base→in), FINAL (resolved = base + overrides, covers coral). Each
  // section shares the day header; chips carry the hover popup. A who's-on-now strip sits on top.
  function renderSlots(s) {
    var days = rangeDays(s.from, s.to), N = days.length; if (!N) { $('#sched').innerHTML = '<div class="muted">no coverage in range</div>'; return; }
    var nowT = nowInTz(s.timezone || 'America/New_York');
    var nowP = {}, vd = effView();  // "on now" = resolved roster whose shift covers the current instant (not all of today)
    if (vd && vd.shifts) vd.shifts.forEach(function (sh) { if (sh.date !== nowT.date) return; var a = hNum(sh.start), b = hNum(sh.end); if (b <= a) b += 24; if (a <= nowT.h && nowT.h < b) (sh.on_call || []).forEach(function (u) { nowP[u] = 1; }); });
    var nowStrip = '<div class="sl-now"><b>On now</b> (' + dayLabel(nowT.date) + ' ' + fmtHM(nowT.h) + '): ' + (Object.keys(nowP).map(function (u) { return esc(nameOf(u)); }).join(', ') || '—') + '</div>';
    var head = '<div class="tg-axis"><div class="tg-nc"></div><div class="tg-cols">' + days.map(function (ds) { return '<div class="tg-col' + (ds === nowT.date ? ' tg-td' : '') + '">' + dayLabel(ds).replace(' ', '<br>') + '</div>'; }).join('') + '</div></div>';
    var CO = { bg: '#FAECE7', bd: '#D85A30', tx: '#993C1D' };
    function segFor(sl, ds, uname) { var dc = (sl.days || []).find(function (x) { return x.date === ds; }); if (!dc) return {}; return (dc.segs || []).find(function (g) { return g.on.some(function (p) { return p.u === uname; }); }) || {}; }
    function chip(uname, col, slotName, seg, mark, cov, pending) {
      var lbl = state.expanded ? nameOf(uname).split(/\s+/)[0] : initials(uname);
      return '<span class="sl-chip' + (pending ? ' pv-new' : '') + '" data-css="background:' + col.bg + ';border-color:' + col.bd + ';color:' + col.tx + '" data-nm="' + esc(nameOf(uname)) + '" data-cov="' + (cov ? esc(nameOf(cov)) : '') + '" data-slot="' + esc(slotName) + '" data-fs="' + esc(fmtDT(seg && seg.fs)) + '" data-fe="' + esc(fmtDT(seg && seg.fe)) + '">' + (pending ? '✚ ' : '') + (mark || '') + esc(lbl) + '</span>';
    }
    function section(title, hint, mode) {
      var rows = (s.slots || []).map(function (sl) {
        var byd = {}; sl.days.forEach(function (x) { byd[x.date] = x.on; });
        var hasOvr = false;
        var cells = days.map(function (ds) {
          var on = byd[ds] || [], chips = '', seen = {};
          on.forEach(function (c) {
            if (mode === 'base') { var b = c.base || c.u; if (seen[b]) return; seen[b] = 1; chips += chip(b, colorOf(b), sl.slot, segFor(sl, ds, c.u)); }
            else if (mode === 'ovr') { if (!c.ovr || seen[c.u]) return; seen[c.u] = 1; hasOvr = true; chips += chip(c.u, CO, sl.slot, segFor(sl, ds, c.u), '↩ ', c.base); }
            else { var k = c.u + '|' + (c.covering || ''); if (seen[k]) return; seen[k] = 1; chips += chip(c.u, c.covering ? CO : colorOf(c.u), sl.slot, segFor(sl, ds, c.u), c.covering ? '↩ ' : '', c.covering, pvHit(ds, c.u, c.covering)); }
          });
          return '<div class="sl-cell' + (ds === nowT.date ? ' tg-td' : '') + '">' + chips + '</div>';
        }).join('');
        if (mode === 'ovr' && !hasOvr) return ''; // Overrides section shows only slots that actually have a dated override
        return '<div class="sl-row"><div class="tg-nc" title="' + esc(sl.slot) + '">' + esc(sl.slot) + '</div><div class="sl-cells">' + cells + '</div></div>';
      }).filter(Boolean).join('');
      if (mode === 'ovr' && !rows) return '<div class="sl-sec"><div class="sl-sechd">' + title + (hint ? ' <span class="muted">' + hint + '</span>' : '') + '</div><div class="muted" data-css="padding:2px 0 1px">no dated overrides in this range</div></div>';
      return '<div class="sl-sec"><div class="sl-sechd">' + title + (hint ? ' <span class="muted">' + hint + '</span>' : '') + '</div>' + head + rows + '</div>';
    }
    $('#sched').innerHTML = '<div class="tg-tz">' + esc(s.timezone || '') + ' · ' + dateRangeLabel(s.from, s.to) + '</div>' + truncNote(s.to, days) + nowStrip
      + section('Rotations', '· base schedule', 'base')
      + section('Overrides', '· dated overrides only', 'ovr')
      + section('Final', '· resolved (base + overrides)', 'final');
    applyCss($('#sched'));
  }

  // Continuous timeline (Gantt): one lane per person, bars positioned by absolute time across the range so
  // overnight shifts cross midnight; name centered in bar; covers/overrides coral; ghost lane for fully-covered.
  function renderWeek(v) {
    var days = rangeDays(v.from, v.to), N = days.length; if (!N) { $('#sched').innerHTML = '<div class="muted">no coverage in range</div>'; return; }
    var nowT = nowInTz(v.timezone || 'America/New_York'), isCov = coverPred(v);
    var byP = {}; v.shifts.forEach(function (s) { var di = days.indexOf(s.date); if (di < 0) return; var sh = hNum(s.start), eh = hNum(s.end); if (eh <= sh) eh += 24; (s.on_call || []).forEach(function (u) { (byP[u] = byP[u] || []).push({ aS: di * 24 + sh, aE: di * 24 + eh, date: s.date, s: sh, e: eh }); }); });
    // whosOnView slices break at EVERY roster change (someone else joining/leaving mid-shift), so one person's
    // continuous shift arrives as several adjacent fragments — coalesce time-adjacent fragments per person into one bar.
    Object.keys(byP).forEach(function (u) { var arr = byP[u].sort(function (a, b) { return a.aS - b.aS; }), m = [];
      arr.forEach(function (b) { var L = m[m.length - 1];
        if (L && b.aS <= L.aE + 1e-6) { if (b.aE > L.aE) { L.aE = b.aE; L.endDate = b.date; L.endE = b.e; } }
        else m.push({ aS: b.aS, aE: b.aE, startDate: b.date, startS: b.s, endDate: b.date, endE: b.e }); });
      byP[u] = m; });
    var people = Object.keys(byP).sort(function (a, b) { return nameOf(a) < nameOf(b) ? -1 : 1; });
    var gl = ''; for (var i = 1; i < N; i++) gl += '<div class="tg-gl" data-css="left:' + (i / N * 100) + '%"></div>';
    var nseg = ''; if (nowT.date >= v.from && nowT.date <= v.to) { var ni = days.indexOf(nowT.date); nseg = '<div class="tg-nowseg" data-css="left:' + ((ni + nowT.h / 24) / N * 100) + '%"></div>'; }
    var head = '<div class="tg-axis"><div class="tg-nc"></div><div class="tg-cols">' + days.map(function (ds) { return '<div class="tg-col' + (ds === nowT.date ? ' tg-td' : '') + '">' + dayLabel(ds).replace(' ', '<br>') + '</div>'; }).join('') + '</div></div>';
    var rows = people.map(function (u) {
      var bars = (byP[u] || []).map(function (b) { var cov = isCov(u, b.startDate), left = (b.aS / 24) / N * 100, right = Math.min(N, b.aE / 24) / N * 100, w = Math.max(right - left, 0.8);
        var pend = !!(state.previewData && state.previewData.inUser === u && state.previewData.dates[b.startDate]);
        var stl = cov ? 'background:#FAECE7;border-color:#D85A30;color:#993C1D' : 'background:#E6F1FB;border-color:#85B7EB;color:#0C447C';
        var fsO = { d: b.startDate, h: fmtHM(b.startS) }, feO = b.endE >= 24 ? { d: addDayStr(b.endDate, 1), h: fmtHM(b.endE) } : { d: b.endDate, h: fmtHM(b.endE) }; // >=24: a shift ending exactly at midnight (endE===24) ends on the NEXT day
        return '<div class="tg-blk' + (cov ? ' cov' : '') + (pend ? ' pv-new' : '') + '" data-css="left:' + left + '%;width:' + w + '%;' + stl + '" data-nm="' + esc(nameOf(u)) + (cov ? ' (covering)' : '') + '" data-fs="' + esc(fmtDT(fsO)) + '" data-fe="' + esc(fmtDT(feO)) + '">' + (pend ? '✚ ' : (cov ? '↩ ' : '')) + esc(nameOf(u)) + '</div>'; }).join('');
      return '<div class="tg-row"><div class="tg-nc" title="' + esc(nameOf(u)) + '">' + esc(nameOf(u)) + '</div><div class="tg-track">' + gl + bars + nseg + '</div></div>';
    }).join('');
    var ghost = (v.covered || []).filter(function (c) { return !byP[c.out] || !byP[c.out].length; }).map(function (c) { return '<div class="tg-row tg-ghost"><div class="tg-nc">' + esc(nameOf(c.out)) + '</div><div class="tg-track">' + gl + '<div class="tg-gle">covered by ' + esc(nameOf(c.in)) + '</div>' + nseg + '</div></div>'; }).join('');
    $('#sched').innerHTML = '<div class="tg-tz">' + esc(v.timezone || '') + ' · ' + dateRangeLabel(v.from, v.to) + '</div>' + truncNote(v.to, days) + head + rows + ghost;
    applyCss($('#sched'));
  }

  // Per-slot 24h timeline (single-day view): one lane per routine layer, each shift drawn as a
  // time-positioned bar from the engine's per-day SEGMENTS so concurrency is read by vertical alignment. Segments are
  // pre-sliced at midnight: an overnight shift shows a tail today (contPrev → ◂) and continues past midnight
  // (contNext → ▸). Lanes are STABLE across days (idle days render a dimmed empty track). Covers/overrides coral.
  // Rendered as the SAME 3 stacked sections as the Slots view (Rotations base / Overrides dated-only / Final resolved),
  // sharing one tick axis — so the overlap timeline shows the base schedule, the dated swaps, and the resolved result.
  function renderDay(s) {
    var nowT = nowInTz(s.timezone || 'America/New_York');
    if (state.overlapSpan === 'week') { var dates = rangeDays(s.from, s.to);
      if (!dates.length) { $('#sched').innerHTML = '<div class="muted">no coverage in range — check that From is on/before To</div>'; return; }
      return renderOverlapWeek(s, dates, nowT); }
    var NC = state.expanded ? 120 : 96;
    // DAY span: one day at a time, navigable WITHOUT limit — independent of From/To (which still governs the
    // Slots/People/Range views). Days outside the loaded range are fetched on demand into state.dayCache by gotoDay().
    var day = state.schedDay;
    if (!day) { day = (todayStr() >= s.from && todayStr() <= s.to) ? todayStr() : (s.from || todayStr()); state.schedDay = day; }
    var src = (state.dayCache && state.dayCache.day === day) ? state.dayCache.data : s;
    var outRange = !(day >= s.from && day <= s.to);
    var nav = '<div class="tcv-daynav"><button type="button" id="tcv-prev">‹</button><span>' + dayLabel(day) + (day === nowT.date ? ' · today' : (outRange ? ' · outside range' : '')) + '</span><button type="button" id="tcv-next">›</button></div>';
    var ticks = '', gl = '';
    for (var h = 0; h <= 24; h += 3) { ticks += '<span class="tcv-tick" data-css="left:' + (h / 24 * 100) + '%">' + (h % 24) + '</span>'; if (h > 0 && h < 24) gl += '<div class="tg-gl" data-css="left:' + (h / 24 * 100) + '%"></div>'; }
    var nseg = day === nowT.date ? '<div class="tcv-nowseg" data-css="left:' + (nowT.h / 24 * 100) + '%"></div>' : '';
    function segsOf(sl) { var c = (sl.days || []).find(function (x) { return x.date === day; }); return c ? (c.segs || []) : []; }
    // mode: 'base' = base rotation (pre dated-override, never coral); 'ovr' = only dated-override segments (coral, sparse); 'final' = resolved (covers/overrides coral)
    function blk(sg, slotName, mode) {
      var on = sg.on || []; if (!on.length) return '';
      if (mode === 'ovr') { on = on.filter(function (c) { return c.ovr; }); if (!on.length) return ''; }
      var base = mode === 'base';
      var who = function (c) { return base ? (c.base || c.u) : c.u; };
      var cov = !base && on.some(function (c) { return c.covering; });
      var col = (mode === 'ovr' || cov) ? { bg: '#FAECE7', bd: '#D85A30', tx: '#993C1D' } : colorOf(who(on[0]));
      var nm = on.map(function (c) { return (!base && c.covering ? '↩ ' : '') + (state.expanded ? nameOf(who(c)) : nameOf(who(c)).split(/\s+/)[0]); }).join(', ');
      var label = (sg.contPrev ? '◂ ' : '') + nm + (sg.contNext ? ' ▸' : '');
      var left = sg.s / 24 * 100, w = Math.min(Math.max((sg.e - sg.s) / 24 * 100, 3.5), 100 - left);
      var names = on.map(function (c) { return nameOf(who(c)); }).join(', ');
      var covs = base ? '' : on.filter(function (c) { return c.covering; }).map(function (c) { return nameOf(c.covering); }).join(', ');
      var pend = !base && on.some(function (c) { return pvHit(day, c.u, c.covering); });
      return '<div class="tcv-blk' + (pend ? ' pv-new' : '') + '" data-css="left:' + left + '%;width:' + w + '%;background:' + col.bg + ';border-color:' + col.bd + ';color:' + col.tx + '" data-nm="' + esc(names) + '" data-cov="' + esc(covs) + '" data-slot="' + esc(slotName || '') + '" data-fs="' + esc(fmtDT(sg.fs)) + '" data-fe="' + esc(fmtDT(sg.fe)) + '">' + (pend ? '✚ ' : '') + esc(label) + '</div>';
    }
    var slots = src.slots || [];
    function laneRows(mode) {
      if (!slots.length) return '<div class="muted">no slots in this routine</div>';
      var rows = slots.map(function (sl) {
        var bars = segsOf(sl).map(function (sg) { return blk(sg, sl.slot, mode); }).join('');
        if (mode === 'ovr' && !bars) return ''; // Overrides section shows only slots that actually have a dated override
        return '<div class="tcv-row' + (bars ? '' : ' tcv-idle') + '"><div class="tcv-name" data-css="flex:0 0 ' + NC + 'px;width:' + NC + 'px" title="' + esc(sl.slot) + '">' + esc(sl.slot) + '</div><div class="tcv-track">' + gl + bars + nseg + '</div></div>';
      }).filter(Boolean).join('');
      if (mode === 'ovr' && !rows) return '<div class="muted" data-css="padding:2px 0 1px">no dated overrides in this range</div>';
      return rows;
    }
    function sec(title, hint, mode) { return '<div class="sl-sec"><div class="sl-sechd">' + title + ' <span class="muted">' + hint + '</span></div>' + laneRows(mode) + '</div>'; }
    $('#sched').innerHTML = '<div class="tg-tz">' + esc(s.timezone || '') + ' · concurrent lanes = overlap · ◂▸ crosses midnight</div>' + '<div class="ovlbar">' + ovlSpanSeg() + nav + '</div>' + '<div class="tcv-axis" data-css="margin-left:' + NC + 'px">' + ticks + '</div>' + sec('Rotations', '· base schedule', 'base') + sec('Overrides', '· dated overrides only', 'ovr') + sec('Final', '· resolved', 'final');
    applyCss($('#sched')); wireSpan();
    var pv = $('#tcv-prev'), nx = $('#tcv-next');
    if (pv) pv.addEventListener('click', function () { gotoDay(addDayStr(day, -1)); });
    if (nx) nx.addEventListener('click', function () { gotoDay(addDayStr(day, 1)); });
  }

  // Move the Overlap Day view to day d, unbounded by From/To. In-range days (or an already-cached day) render from
  // loaded data; an out-of-range day is fetched once into state.dayCache so the Slots/People/Range views stay put.
  async function gotoDay(d) {
    state.schedDay = d;
    var inRange = state.slotData && d >= state.from && d <= state.to;
    if (inRange || (state.dayCache && state.dayCache.day === d)) { renderSched(); return; }
    try {
      var sd = await window.TC.oncall.whosOnSlots(state.routine, { from: d, to: d });
      if (state.schedDay !== d) return; // user navigated on while this was in flight — discard
      state.dayCache = (!looksDead(sd) && sd.slots) ? { day: d, data: sd } : null;
      renderSched();
    } catch (e) { if (state.schedDay === d) renderSched(); }
  }

  // Day/Range granularity toggle for the Overlap view.
  // span toggle: Day = one day at a time (with ‹ › nav); Range = the whole From/To window as one continuous timeline.
  // (data-span value stays 'week' internally; the label is "Range" because it follows the selected range, not a fixed week.)
  function ovlSpanSeg() { var w = state.overlapSpan === 'week'; return '<div class="tcv-seg"><button type="button" data-span="day" class="' + (w ? '' : 'on') + '">Day</button><button type="button" data-span="week" class="' + (w ? 'on' : '') + '">Range</button></div>'; }
  function wireSpan() { root.querySelectorAll('[data-span]').forEach(function (b) { b.addEventListener('click', function () { if (state.overlapSpan === b.getAttribute('data-span')) return; state.overlapSpan = b.getAttribute('data-span'); renderSched(); }); }); }

  // OVERLAP — RANGE span: per-slot lanes on a CONTINUOUS multi-day axis, each shift a
  // time-positioned bar across [from..to], so overlap is read by vertical alignment over the whole week. Reuses the
  // engine's per-day segments (positioned at day-index + hour/24). Idle slots dimmed; red now-line; same hover popup.
  // Rendered as 3 stacked sections (Rotations base / Overrides dated-only / Final resolved), each repeating the day header.
  function renderOverlapWeek(s, days, nowT) {
    var N = days.length, F = s.from;
    function dayOff(d) { return Math.round((new Date(d + 'T00:00:00') - new Date(F + 'T00:00:00')) / 86400000); }
    var head = '<div class="tg-axis"><div class="tg-nc"></div><div class="tg-cols">' + days.map(function (ds) { return '<div class="tg-col' + (ds === nowT.date ? ' tg-td' : '') + '">' + dayLabel(ds).replace(' ', '<br>') + '</div>'; }).join('') + '</div></div>';
    var gl = ''; for (var i = 1; i < N; i++) gl += '<div class="tg-gl" data-css="left:' + (i / N * 100) + '%"></div>';
    var nseg = ''; var ni = days.indexOf(nowT.date); if (ni >= 0) nseg = '<div class="tg-nowseg" data-css="left:' + ((ni + nowT.h / 24) / N * 100) + '%"></div>';
    var CO = { bg: '#FAECE7', bd: '#D85A30', tx: '#993C1D' };
    // mode: 'base' = base rotation (pre dated-override); 'ovr' = only dated-override shifts (coral, sparse); 'final' = resolved
    function laneRows(mode) {
      var rows = (s.slots || []).map(function (sl) {
        // Collect DISTINCT shifts across the week (the engine's per-day segments split an overnight at midnight; dedupe
        // the head+tail back into one by their full start/end), then draw each as ONE continuous bar positioned by
        // absolute time — so a shift crossing midnight is unbroken, not two boxes with the day-gridline between them.
        var seen = {}, shifts = [];
        (sl.days || []).forEach(function (dc) { (dc.segs || []).forEach(function (sg) {
          if (!sg.on || !sg.on.length || !sg.fs || !sg.fe) return;
          var key = sg.fs.d + '|' + sg.fs.h + '|' + sg.fe.d + '|' + sg.fe.h;
          if (seen[key]) return; seen[key] = 1; shifts.push(sg);
        }); });
        var bars = shifts.map(function (sg) {
          var on = sg.on;
          if (mode === 'ovr') { on = on.filter(function (c) { return c.ovr; }); if (!on.length) return ''; }
          var base = mode === 'base';
          var who = function (c) { return base ? (c.base || c.u) : c.u; };
          var cov = !base && on.some(function (c) { return c.covering; });
          var col = (mode === 'ovr' || cov) ? CO : colorOf(who(on[0]));
          var a = dayOff(sg.fs.d) + hNum(sg.fs.h) / 24, b = dayOff(sg.fe.d) + hNum(sg.fe.h) / 24;
          var left = Math.max(0, a) / N * 100, right = Math.min(N, b) / N * 100, w = Math.max(right - left, 0.6);
          var names = on.map(function (c) { return nameOf(who(c)); }).join(', ');
          var covs = base ? '' : on.filter(function (c) { return c.covering; }).map(function (c) { return nameOf(c.covering); }).join(', ');
          var pend = !base && on.some(function (c) { return pvHit(sg.fs.d, c.u, c.covering); });
          var label = (pend ? '✚' : (!base && on[0].covering ? '↩' : '')) + (state.expanded ? nameOf(who(on[0])).split(/\s+/)[0] : initials(who(on[0])));
          return '<div class="tg-blk' + (cov || mode === 'ovr' ? ' cov' : '') + (pend ? ' pv-new' : '') + '" data-css="left:' + left + '%;width:' + w + '%;background:' + col.bg + ';border-color:' + col.bd + ';color:' + col.tx + '" data-nm="' + esc(names) + '" data-cov="' + esc(covs) + '" data-slot="' + esc(sl.slot) + '" data-fs="' + esc(fmtDT(sg.fs)) + '" data-fe="' + esc(fmtDT(sg.fe)) + '">' + esc(label) + '</div>';
        }).join('');
        if (mode === 'ovr' && !bars) return ''; // Overrides section shows only slots that actually have a dated override
        return '<div class="tg-row' + (bars ? '' : ' tcv-idle') + '"><div class="tg-nc" title="' + esc(sl.slot) + '">' + esc(sl.slot) + '</div><div class="tg-track">' + gl + bars + nseg + '</div></div>';
      }).filter(Boolean).join('');
      if (mode === 'ovr' && !rows) return '<div class="muted" data-css="padding:2px 0 1px">no dated overrides in this range</div>';
      return rows;
    }
    function sec(title, hint, mode) { return '<div class="sl-sec"><div class="sl-sechd">' + title + ' <span class="muted">' + hint + '</span></div>' + head + laneRows(mode) + '</div>'; }
    $('#sched').innerHTML = '<div class="tg-tz">' + esc(s.timezone || '') + ' · ' + dateRangeLabel(s.from, s.to) + ' · concurrent lanes = overlap</div>' + truncNote(s.to, days) + '<div class="ovlbar">' + ovlSpanSeg() + '</div>' + sec('Rotations', '· base schedule', 'base') + sec('Overrides', '· dated overrides only', 'ovr') + sec('Final', '· resolved', 'final');
    applyCss($('#sched')); wireSpan();
  }

  async function refreshActive(tok) {
    var box = $('#ovr');
    try {
      var r = await window.TC.oncall.list(state.routine);
      if (tok !== state.viewEpoch) return; // superseded — don't paint a stale routine's overrides with the new routine's buttons
      if (looksDead(r)) return sessionDead();
      var ov = (r && r.overrides) || [], cv = (r && r.covers) || [], st = (r && r.sets) || [];
      if (!Array.isArray(ov) && !Array.isArray(cv) && !Array.isArray(st)) { box.innerHTML = '<div class="muted">could not load</div>'; return; }
      if (!ov.length && !cv.length && !st.length) { box.innerHTML = '<div class="muted">no active overrides or covers</div>'; return; }
      var html = st.map(function (s) { return '<div class="ovrow"><span><i class="ti ti-calendar" data-css="font-size:11px;vertical-align:-1px" aria-hidden="true"></i> ' + esc(s.alias) + ' · ' + (s.timeOff ? '<span class="warn">time off (no one)</span>' : esc(s.roster.map(nameOf).join(', '))) + ' <span class="muted">' + esc(s.from) + (s.from === s.to ? '' : '…' + esc(s.to)) + '</span></span><button class="btn sm" type="button" data-cancel="' + esc(s.alias) + '">cancel</button></div>'; }).join('');
      html += ov.map(function (o) { return '<div class="ovrow"><span>' + esc(o.alias) + ' · ' + esc(nameOf(o.out)) + ' → ' + esc(o.in ? nameOf(o.in) : '(removed)') + ' <span class="muted">' + esc(o.from) + '…' + esc(o.to) + '</span></span><button class="btn sm" type="button" data-cancel="' + esc(o.alias) + '">cancel</button></div>'; }).join('');
      html += cv.map(function (c) { return '<div class="ovrow"><span><i class="ti ti-infinity" data-css="font-size:11px;vertical-align:-1px" aria-hidden="true"></i> ' + esc(nameOf(c.out)) + ' → ' + esc(nameOf(c.in)) + ' <span class="muted">until removed</span></span><button class="btn sm" type="button" data-uncover="' + esc(c.out) + '">uncover</button></div>'; }).join('');
      if (ov.length || st.length) html += '<button class="btn sm" type="button" id="clearall">clear all overrides</button>';
      box.innerHTML = html; applyCss(box);
      box.querySelectorAll('[data-cancel]').forEach(function (b) { b.addEventListener('click', function () { doCancel(b.getAttribute('data-cancel')); }); });
      box.querySelectorAll('[data-uncover]').forEach(function (b) { b.addEventListener('click', function () { doUncover(b.getAttribute('data-uncover')); }); });
      var ca = $('#clearall'); if (ca) ca.addEventListener('click', doClearAll);
    } catch (e) { box.innerHTML = '<div class="muted">could not load</div>'; }
  }

  function setBusy(b) { state.busy = b; updateControls(); }
  function updateControls() {
    if (!root) return;
    var lock = state.busy || state.drift;
    root.querySelectorAll('#panel button, #panel select, #panel input').forEach(function (el) { if (el.id === 'close') return; el.disabled = lock; });
    if (!lock) { var pv = $('#primary'); if (pv) pv.disabled = !state.canPreview; }
  }
  function syncSwapUi() {
    var cm = state.coverMode;
    $('#primary').textContent = cm ? 'cover until removed →' : 'preview (dry-run)';
    $('#swaprow').style.display = cm ? 'none' : 'flex';
    $('#covernote').style.display = cm ? 'block' : 'none';
    if (state.previewData) { state.previewData = null; renderSched(); }
    $('#previewBox').innerHTML = '';
  }
  function clearPreview() { state.previewData = null; var b = $('#previewBox'); if (b) b.innerHTML = ''; }
  // effective schedule data the views render from: the pending PREVIEW (swap not yet applied) if active, else live.
  function effSlot() { return state.previewData ? state.previewData.slots : state.slotData; }
  function effView() { return state.previewData ? state.previewData.view : state.viewData; }
  // does this resolved Final cell carry the pending swap? (the in-person, covering one of the swapped-out people, on a changed date)
  function pvHit(date, u, covering) { var p = state.previewData; return !!(p && p.inUser && u === p.inUser && p.outs.indexOf(covering) >= 0 && p.dates[date]); }
  function injectPreviewTag() { var s = $('#sched'); if (!s || !state.previewData) return; var t = document.createElement('div'); t.className = 'pv-tag'; t.innerHTML = '⟳ Preview · ' + esc(state.previewData.summary) + ' <span class="muted">— not applied yet</span>'; s.insertBefore(t, s.firstChild); }
  // toggle the swap input between By-person (a person dropdown) and By-shift (a slot dropdown). Cover-until-removed is
  // person-only (it's a base-rotation edit), so it's hidden in shift mode. canPreview is recomputed for the active mode.
  function syncTarget() {
    var slot = state.swapTarget === 'slot', set = state.swapTarget === 'set';
    $('#outrow').style.display = (!slot && !set) ? 'block' : 'none';
    $('#slotrow').style.display = slot ? 'block' : 'none';
    $('#inrow').style.display = set ? 'none' : 'block'; // "Replace with" is meaningless when SETTING the whole roster
    $('#covrow').style.display = (slot || set) ? 'none' : 'flex';
    $('#setrow').style.display = set ? 'block' : 'none';
    if ((slot || set) && state.coverMode) { $('#covermode').checked = false; state.coverMode = false; }
    state.canPreview = set ? true : (slot ? (state.slotCount > 0) : (state.peopleCount > 0));
    if (set) renderSetChips();
    syncSwapUi(); updateControls();
  }

  async function doPreview() {
    if (state.busy || state.drift) return;
    var from = state.swapFrom, to = state.swapTo;
    if (!from || !to) return banner('Set the override dates (Override from / Override to).', 'err');
    if (from > to) return banner('Override-from date is after override-to.', 'err');
    var slotMode = state.swapTarget === 'slot';
    var inp = $('#in').value, out = slotMode ? null : $('#out').value, slot = slotMode ? $('#slotsel').value : null;
    if (slotMode) { if (!slot) return banner('Pick a shift/slot.', 'err'); }
    else { if (!out) return banner('Pick a person to override.', 'err'); if (inp && inp === out) return banner('Replace-with is the same person — nothing would change.', 'warn'); }
    setBusy(true); banner('checking…', 'info');
    try {
      var r = slotMode ? await window.TC.oncall.swapSlot(state.routine, slot, inp, from, to, { dryRun: true })
                       : await window.TC.oncall.swap(state.routine, out, inp, from, to, { dryRun: true });
      if (looksDead(r)) return sessionDead();
      if (r.applied === false && r.warning) { banner(r.warning, 'warn'); $('#previewBox').innerHTML = ''; return; }
      // One row per band: who WE swap out (the person, or the slot's resolved occupant) → in; co-on people summarised
      // as "N others stay on" (muted), full roster on hover (title). ourOut = [out] (person) or r.replaced (slot).
      var ourOut = slotMode ? (r.replaced || []) : [out];
      var inLbl = inp ? esc(nameOf(inp)) : '(removed)';
      // Resolve the hypothetical post-swap schedule and show it in the views until apply/discard.
      state.previewData = null;
      if (r.previewLayers && window.TC.oncall.slotsFromLayers) {
        try {
          var tz = (state.slotData && state.slotData.timezone) || (state.viewData && state.viewData.timezone) || 'America/New_York';
          var meta = { routine_name: state.routine, timezone: tz };
          var pdates = {}; (r.changes || []).forEach(function (c) { pdates[c.date] = 1; });
          state.previewData = {
            slots: window.TC.oncall.slotsFromLayers(meta, r.previewLayers, { from: state.from, to: state.to }),
            view: window.TC.oncall.viewFromLayers(meta, r.previewLayers, { from: state.from, to: state.to }),
            inUser: inp, outs: ourOut.slice(), dates: pdates,
            summary: (slotMode ? slot : nameOf(out)) + ' → ' + (inp ? nameOf(inp) : '(removed)') + ' · ' + from + (from === to ? '' : ' … ' + to)
          };
          renderSched();
        } catch (e) { state.previewData = null; }
      }
      var rows = (r.changes || []).map(function (c) {
        var rem = ourOut.filter(function (u) { return (c.before || []).indexOf(u) >= 0; });
        var remL = (rem.length ? rem : ourOut.slice(0, 1)).map(nameOf).map(esc).join(', ') || '—';
        var others = (c.after || []).filter(function (u) { return (c.before || []).indexOf(u) >= 0 && rem.indexOf(u) < 0; }).length; // true bystanders kept on
        var oth = others > 0 ? ' <span class="muted">· ' + others + ' other' + (others > 1 ? 's' : '') + ' stay on</span>' : '';
        var full = (c.before || []).map(nameOf).join(', ') + '  →  ' + (c.after || []).map(nameOf).join(', ');
        return '<div class="diff" title="' + esc(full) + '"><span class="muted">' + esc(c.date) + ' ' + esc((c.shift || '').slice(0, 5)) + '</span><span><s>' + remL + '</s> → <b>' + inLbl + '</b>' + oth + '</span></div>';
      }).join('');
      var cw = r.conflictWith, cwStr = Array.isArray(cw) ? cw.join(', ') : cw;
      var head = cwStr ? '<span class="warn">⚠ overlaps ' + esc(cwStr) + '</span>'
        : slotMode ? '<span class="ok">✓ ' + esc(slot) + ' → ' + inLbl + ' · ' + (r.replaced || []).length + ' occupant' + ((r.replaced || []).length > 1 ? 's' : '') + ' replaced</span>'
                   : '<span class="ok">✓ no conflict · co-on people preserved</span>';
      $('#previewBox').innerHTML = '<div class="pvhead">' + head + '</div>' + rows + '<div class="acts"><button class="btn pri" type="button" id="apply">apply override</button><button class="btn" type="button" id="discard">discard</button></div>';
      $('#apply').addEventListener('click', function () { doApply(out, inp, slot, from, to); });
      $('#discard').addEventListener('click', function () { state.previewData = null; $('#previewBox').innerHTML = ''; renderSched(); });
      banner('', '');
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doApply(out, inp, slot, from, to) {
    if (state.busy || state.drift) return; setBusy(true); banner('applying…', 'info');
    try {
      var r = slot ? await window.TC.oncall.swapSlot(state.routine, slot, inp, from, to)
                   : await window.TC.oncall.swap(state.routine, out, inp, from, to);
      if (looksDead(r)) return sessionDead();
      if (!r.applied) { banner(r.warning || 'not applied', 'warn'); return; }
      banner('applied · ' + (slot ? slot : nameOf(out)) + ' → ' + (inp ? nameOf(inp) : '(removed)'), 'ok');
      state.previewData = null; $('#previewBox').innerHTML = ''; await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  // ---- Set coverage / time-off (set the roster for a window) ----
  function renderSetChips() {
    var box = $('#set-chips'); if (!box) return;
    if (state.setTimeOff) { box.innerHTML = '<span class="muted">— no one on-call (time off) —</span>'; return; }
    if (!state.setRoster.length) { box.innerHTML = '<span class="muted">pick who is on-call for this window…</span>'; return; }
    box.innerHTML = state.setRoster.map(function (u) { var c = colorOf(u); return '<span class="ed-chip" data-css="background:' + c.bg + ';border-color:' + c.bd + ';color:' + c.tx + '">' + esc(nameOf(u)) + '<button type="button" class="ed-x" data-setdel="' + esc(u) + '" aria-label="remove">×</button></span>'; }).join('');
    applyCss(box);
    box.querySelectorAll('[data-setdel]').forEach(function (b) { b.addEventListener('click', function () { var u = b.getAttribute('data-setdel'); state.setRoster = state.setRoster.filter(function (x) { return x !== u; }); if (state.previewData) { clearPreview(); renderSched(); } renderSetChips(); }); });
  }

  async function doSetPreview() {
    if (state.busy || state.drift) return;
    var from = state.swapFrom, to = state.swapTo;
    if (!from || !to) return banner('Set the coverage dates (Override from / Override to).', 'err');
    if (from > to) return banner('From date is after To.', 'err');
    if (!state.setTimeOff && !state.setRoster.length) return banner('Pick who is on-call, or turn on Time off.', 'err');
    var people = state.setTimeOff ? [] : state.setRoster.slice();
    var opts = { dryRun: true, timeOff: state.setTimeOff };
    if (state.setPartial) {
      var slm = slMin($('#set-len').value);
      if (slm < 1 || slm > 1440) return banner('Coverage length must be 00:01–24:00 (split a longer span across days).', 'err');
      opts.rotation_start = hhmmss($('#set-start').value); opts.shift_length = hhmm($('#set-len').value);
    }
    setBusy(true); banner('checking…', 'info');
    try {
      var r = await window.TC.oncall.setRoster(state.routine, people, from, to, opts);
      if (looksDead(r)) return sessionDead();
      if (r.applied === false && r.warning) { banner(r.warning, 'warn'); $('#previewBox').innerHTML = ''; return; }
      state.previewData = null;
      if (r.previewLayers && window.TC.oncall.slotsFromLayers) {
        try {
          var tz = (state.slotData && state.slotData.timezone) || (state.viewData && state.viewData.timezone) || 'America/New_York';
          var meta = { routine_name: state.routine, timezone: tz };
          state.previewData = {
            slots: window.TC.oncall.slotsFromLayers(meta, r.previewLayers, { from: state.from, to: state.to }),
            view: window.TC.oncall.viewFromLayers(meta, r.previewLayers, { from: state.from, to: state.to }),
            inUser: null, outs: [], dates: {},
            summary: 'Set ' + (r.timeOff ? 'time off (no one)' : people.map(nameOf).join(', ')) + ' · ' + from + (from === to ? '' : ' … ' + to)
          };
          renderSched();
        } catch (e) { state.previewData = null; }
      }
      var rosterLbl = r.timeOff ? '<b>no one</b> (time off)' : '<b>' + people.map(nameOf).map(esc).join(', ') + '</b>';
      var when = state.setPartial ? esc($('#set-start').value) + ' for ' + esc($('#set-len').value) : 'whole day';
      var repl = r.replaced ? ' <span class="muted">· replaces ' + r.replaced + ' existing override' + (r.replaced > 1 ? 's' : '') + ' on these dates</span>' : '';
      var head = '<span class="ok">✓ on-call set to ' + rosterLbl + ' · ' + esc(from) + (from === to ? '' : '…' + esc(to)) + ' · ' + when + '</span>' + repl;
      $('#previewBox').innerHTML = '<div class="pvhead">' + head + '</div>' + (r.timeOff ? '<div class="ed-warn">⚠ Intentional gap — no one is on-call (nobody paged) in this window. Use only for a real holiday/closure.</div>' : '') + '<div class="acts"><button class="btn pri" type="button" id="apply">apply coverage</button><button class="btn" type="button" id="discard">discard</button></div>';
      $('#apply').addEventListener('click', function () { doSetApply(people, from, to, opts); });
      $('#discard').addEventListener('click', function () { state.previewData = null; $('#previewBox').innerHTML = ''; renderSched(); });
      banner('', '');
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  // Extend a shift: pick a slot + new end → plan the overflow window/roster, then pre-fill the Set-coverage form so the
  // user previews & applies through the normal SET path (keeps the occupant on, preserves everyone else on then).
  async function edExtendShift() {
    if (state.busy || state.drift) return;
    if (!window.TC.oncall.planExtend) return banner('Extend needs a newer engine — rebuild via ./build.sh and reload.', 'err');
    var slots = ((state.slotData && state.slotData.slots) || []).map(function (s) { return s.slot; });
    var slot = prompt('Extend which shift on ' + (state.swapFrom || todayStr()) + '?\n\n' + (slots.join('\n') || '(no slots loaded — switch to a date in range)'));
    if (slot == null) return; slot = slot.trim(); if (!slot) return;
    var newEnd = prompt('Keep "' + slot + '" on until what time? (HH:MM, same day — past its normal end)');
    if (newEnd == null) return; newEnd = newEnd.trim(); if (!newEnd) return;
    setBusy(true); banner('planning extension…', 'info');
    try {
      var plan = await window.TC.oncall.planExtend(state.routine, slot, state.swapFrom || todayStr(), newEnd);
      if (looksDead(plan)) return sessionDead();
      if (!plan.ok) { banner(plan.warning || 'cannot extend', 'warn'); return; }
      // pre-fill the Set-coverage form with the overflow window + computed roster
      state.setRoster = plan.roster.filter(function (u) { return u !== 'no-one'; });
      state.setTimeOff = false; var to = $('#set-timeoff'); if (to) to.checked = false;
      state.setPartial = true; var sp = $('#set-partial'); if (sp) sp.checked = true; $('#set-hours').style.display = 'flex';
      $('#set-start').value = plan.rotation_start.slice(0, 5); $('#set-len').value = plan.shift_length;
      state.swapFrom = plan.from; state.swapTo = plan.to; $('#swapfrom').value = plan.from; $('#swapto').value = plan.to;
      renderSetChips();
      banner('Extension ready: ' + (plan.occupant.map(nameOf).join(', ') || slot) + ' + ' + Math.max(0, state.setRoster.length - plan.occupant.length) + ' others on ' + plan.rotation_start.slice(0, 5) + '–' + newEnd + '. Review, then preview.', 'ok');
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doSetApply(people, from, to, opts) {
    if (state.busy || state.drift) return; setBusy(true); banner('applying…', 'info');
    try {
      var o = { timeOff: opts.timeOff }; if (opts.rotation_start) o.rotation_start = opts.rotation_start; if (opts.shift_length) o.shift_length = opts.shift_length;
      var r = await window.TC.oncall.setRoster(state.routine, people, from, to, o);
      if (looksDead(r)) return sessionDead();
      if (!r.applied) { banner(r.warning || 'not applied', 'warn'); return; }
      banner('coverage set · ' + (r.timeOff ? 'time off (no one)' : people.map(nameOf).join(', ')) + ' · ' + from, 'ok');
      state.previewData = null; $('#previewBox').innerHTML = ''; await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doCover() {
    if (state.busy || state.drift) return;
    var out = $('#out').value, inp = $('#in').value;
    if (!out) return banner('Pick a person to cover.', 'err');
    if (!inp) return banner('Cover needs a replacement (pick someone in "Replace with").', 'err');
    if (!confirm('Cover ' + nameOf(out) + ' with ' + nameOf(inp) + ' on "' + state.routine + '" UNTIL REMOVED?\n\nIndefinite — replaces them on every shift in this routine until you uncover.')) return;
    setBusy(true); banner('applying cover…', 'info');
    try {
      var r = await window.TC.oncall.cover(state.routine, out, inp);
      if (looksDead(r)) return sessionDead();
      if (!r.covered) { banner(r.warning || 'not applied', 'warn'); return; }
      banner('covering ' + nameOf(out) + ' → ' + nameOf(inp) + ' until removed', 'ok'); await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doCancel(alias) {
    if (state.busy || state.drift) return;
    if (!confirm('Cancel override ' + alias + ' on ' + state.routine + '?')) return;
    setBusy(true); banner('cancelling ' + alias + '…', 'info');
    try { var r = await window.TC.oncall.cancel(state.routine, alias); if (looksDead(r)) return sessionDead();
      banner(r.cancelled ? 'cancelled ' + alias : (r.warning || 'nothing cancelled'), r.cancelled ? 'ok' : 'warn'); await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doUncover(out) {
    if (state.busy || state.drift) return;
    if (!confirm('Remove the cover for ' + nameOf(out) + ' on ' + state.routine + '?\n\nRestores them to the rotation.')) return;
    setBusy(true); banner('removing cover…', 'info');
    try { var r = await window.TC.oncall.uncover(state.routine, out); if (looksDead(r)) return sessionDead();
      banner(r.uncovered ? 'removed cover for ' + nameOf(out) : (r.warning || 'nothing to remove'), r.uncovered ? 'ok' : 'warn'); await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  async function doClearAll() {
    if (state.busy || state.drift) return;
    if (!confirm('Remove ALL overrides on ' + state.routine + '? (covers are not affected)')) return;
    setBusy(true); banner('clearing…', 'info');
    try { var r = await window.TC.oncall.clearAll(state.routine); if (looksDead(r)) return sessionDead();
      banner('cleared all overrides', 'ok'); await refreshAll();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  // ============================ STRUCTURAL EDITOR (View | Edit) ============================
  // Edit base rotations while dated overrides stay live. Working copy = state.edit.layers (editable shape: a
  // simple {name,covs,valid_start,valid_end,rotation_start,shift_length,rotation_frequency,skip_days,steps}).
  // All edits mutate the working copy IN MEMORY; one Preview (dry-run) shows the resulting schedule, then Apply
  // commits the whole routine via the override-safe TC.oncall.saveBase (recompiles OVR tiles from their
  // directives against the new base) or TC.oncall.createRoutine for a brand-new routine.
  var EDOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index 0=Mon..6=Sun (matches skip_days)
  function edClone(o) { return JSON.parse(JSON.stringify(o)); }
  var i2 = function (v) { return Math.max(0, Math.floor(Math.abs(+v || 0))); }; // clean integer field for HH/MM/SS tokens
  function hhmmss(t) { var p = String(t || '00:00').split(':'); return pad(i2(p[0])) + ':' + pad(i2(p[1])) + ':' + pad(i2(p[2])); }
  function hhmm(t) { var p = String(t || '00:00').split(':'); return pad(i2(p[0])) + ':' + pad(i2(p[1])); }
  // 'weeks' = a clean multiple of 7 (>7): shown as "every N weeks" (friendlier than "14 days" and skip_days stays week-aligned). 'custom' = any other day count.
  function freqType(f) { f = +f; return f === 1 ? 'daily' : f === 7 ? 'weekly' : (f > 7 && f % 7 === 0) ? 'weeks' : 'custom'; }
  function freqLabel(L) { var f = +L.rotation_frequency || 7, t = freqType(f); return t === 'daily' ? 'daily' : t === 'weekly' ? 'weekly' : t === 'weeks' ? 'every ' + (f / 7) + ' wks' : 'every ' + f + ' days'; }
  // The unit of ONE turn in a rotating-off lane, so a daily rotation isn't mislabelled as weekly: each step lasts
  // rotation_frequency days, so daily→'day', weekly→'week', and any other cadence (every-N-days/weeks)→'turn'.
  function rotUnit(L) { var t = freqType(+L.rotation_frequency || 7); return t === 'daily' ? 'day' : t === 'weekly' ? 'week' : 'turn'; }
  var slMin = function (t) { var p = String(t || '0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }; // shift_length in minutes — mirrors engine _slmin for the field-level ≤24:00 guard
  // A "rotating-off" lane = one person repeated + exactly one No One step (the classic 3-of-4 day pattern).
  // Returns {person, offIdx, cycleLen} so it can be edited as person + off-turn (the unit follows the real cadence:
  // day / week / turn, via rotUnit) instead of repeated steps.
  function rotInfo(L) {
    if (!L) return null;
    var steps = L.steps || []; if (steps.length < 2) return null;
    var off = -1, person = null;
    for (var i = 0; i < steps.length; i++) { var st = steps[i] || []; if (st.length !== 1) return null; var u = st[0];
      if (u === 'no-one') { if (off < 0) off = i; else return null; }
      else { if (person == null) person = u; else if (person !== u) return null; } }
    if (off < 0 || person == null) return null;
    return { person: person, offIdx: off, cycleLen: steps.length };
  }
  function rebuildRot(L, person, offIdx, cycleLen) { var s = []; for (var i = 0; i < cycleLen; i++) s.push([i === offIdx ? 'no-one' : person]); L.steps = s; }
  function winSummary(L) {
    var st = hhmm(L.rotation_start), sl = hNum(L.shift_length), startH = hNum(L.rotation_start), end = fmtHM(startH + sl);
    if (sl > 0 && end === fmtHM(startH)) end = end + ' +1d'; // a full-day/×24h shift wraps end back to start — disambiguate from a zero-length '00:00–00:00'
    var on = [0, 1, 2, 3, 4, 5, 6].filter(function (d) { return (L.skip_days || []).indexOf(d) < 0; });
    var dlbl = on.length === 7 ? 'every day' : (on.length === 5 && on.indexOf(5) < 0 && on.indexOf(6) < 0) ? 'Mon–Fri' : (on.length === 2 && on.indexOf(5) >= 0 && on.indexOf(6) >= 0) ? 'weekends' : on.map(function (d) { return EDOW[d]; }).join(' ') || '(no days)';
    var ro = rotInfo(L);
    if (ro) return st + '–' + end + ' · ' + dlbl + ' · ' + nameOf(ro.person) + ' (off ' + rotUnit(L) + ' ' + (ro.offIdx + 1) + '/' + ro.cycleLen + ')';
    var np = (L.steps || []).reduce(function (a, s) { return a + (s ? s.length : 0); }, 0);
    var cad = (L.steps || []).length > 1 ? freqLabel(L) + ' · ' : ''; // cadence only matters once the lane actually rotates (>1 turn)
    return st + '–' + end + ' · ' + dlbl + ' · ' + cad + np + 'p';
  }
  function setMode(m) {
    state.mode = m;
    root.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); });
    clearStructPreview(); clearPreview(); // drop any pending preview (structural OR swap dry-run) when switching modes
    if (m === 'edit') {
      $('#viewbody').style.display = 'none'; $('#covbody').style.display = 'none'; $('#editbody').style.display = 'block'; $('#routinerow').style.display = '';
      if (!state.edit) enterEdit(); else if (!state.edit.isNew && state.edit.routine !== state.routine) enterEdit(); else renderEditor();
    } else if (m === 'coverage') {
      $('#viewbody').style.display = 'none'; $('#editbody').style.display = 'none'; $('#covbody').style.display = 'block'; $('#routinerow').style.display = 'none';
      enterCoverage();
    } else {
      $('#editbody').style.display = 'none'; $('#covbody').style.display = 'none'; $('#viewbody').style.display = 'block'; $('#routinerow').style.display = '';
      refreshAll();
    }
  }

  // ---- Coverage mode: resolve an escalation policy's full ladder (read-only) ----
  async function enterCoverage() {
    if (!engineReady()) { banner('Engine not loaded — open a TaskCall page and reload.', 'err'); return; }
    if (!window.TC.oncall.policyCoverage) { banner('Coverage needs a newer engine — rebuild via ./build.sh and reload the extension.', 'err'); return; }
    if (!state.covFrom) { state.covFrom = todayStr(); state.covTo = todayStr(); }
    if (state.covTime == null) { var n = new Date(); state.covTime = pad(n.getHours()) + ':' + pad(n.getMinutes()); }
    $('#covfrom').value = state.covFrom; $('#covto').value = state.covTo; $('#covtime').value = state.covTime;
    root.querySelectorAll('[data-covview]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-covview') === state.covView); }); // sync toggle to persisted view
    $('#covtimewrap').style.display = state.covView === 'ladder' ? '' : 'none';
    if (!state.users.length) { try { var nm = await window.TC.users.names(); if (!looksDead(nm) && Array.isArray(nm)) state.users = nm; } catch (e) {} } // for display names + chip colors
    await loadPolicies();
    renderCoverage();
  }

  async function loadPolicies() {
    // Always re-fetch on Coverage entry (no caching) so added/renamed/deleted policies show up — mirrors how
    // bootstrap() re-lists routines on every open(). loadPolicies preserves the current selection if it still exists.
    try {
      var pols = await window.TC.raw('/configurations/escalation-policies');
      if (looksDead(pols) || !Array.isArray(pols)) return sessionDead();
      state.policies = pols.map(function (p) { return p.policy_name || p.escalation_policy_name || p.name; }).filter(Boolean);
      var sel = $('#covpolicy'); sel.innerHTML = state.policies.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
      if (!state.policy || state.policies.indexOf(state.policy) < 0) state.policy = state.policies[0] || null;
      sel.value = state.policy || '';
    } catch (e) { sessionDead(e); }
  }

  function applyCovPreset(p) {
    var now = new Date(), m;
    if (p === 'now') { state.covFrom = todayStr(); state.covTo = todayStr(); state.covTime = pad(now.getHours()) + ':' + pad(now.getMinutes()); }
    else if (p === 'today') { state.covFrom = todayStr(); state.covTo = todayStr(); }
    else if (p === 'thisweek') { m = mondayOf(now); state.covFrom = fmt(m); state.covTo = fmt(addDays(m, 6)); }
    else if (p === 'nextweek') { m = mondayOf(addDays(now, 7)); state.covFrom = fmt(m); state.covTo = fmt(addDays(m, 6)); }
    else if (p === '2weeks') { m = mondayOf(now); state.covFrom = fmt(m); state.covTo = fmt(addDays(m, 13)); }
    $('#covfrom').value = state.covFrom; $('#covto').value = state.covTo; $('#covtime').value = state.covTime;
    renderCoverage();
  }

  async function renderCoverage() {
    if (!state.policy) { $('#covout').innerHTML = '<div class="muted">No escalation policies found.</div>'; return; }
    if (!window.TC.oncall.policyCoverage) return;
    state.covSlots = null; state.covSlotsKey = null; // policy/range changed → timeline slot data is stale
    var tok = ++state.covDataEpoch; // discard an out-of-order policyCoverage resolve (rapid From→To change)
    var box = $('#covout'); box.innerHTML = '<div class="muted">resolving…</div>';
    try {
      var r = await window.TC.oncall.policyCoverage(state.policy, { from: state.covFrom, to: state.covTo });
      if (tok !== state.covDataEpoch) return; // superseded by a newer policy/range change
      if (looksDead(r)) return sessionDead();
      if (r && r.error) { box.innerHTML = '<div class="muted">' + esc(r.error) + '</div>'; return; }
      state.covData = r;
      renderCovOut();
    } catch (e) { sessionDead(e); }
  }

  function covChip(u) { var c = colorOf(u); return '<span class="cov-chip" data-css="background:' + c.bg + ';border-color:' + c.bd + ';color:' + c.tx + '">' + esc(nameOf(u)) + '</span>'; }
  function covDayHM(d, hms) { var dt = new Date(d + 'T00:00:00'); return DOW[dt.getDay()] + ' ' + MON[dt.getMonth()] + ' ' + dt.getDate() + ' ' + String(hms || '').slice(0, 5); }
  function gapLabel(g) { var a = covDayHM(g.date, g.start), b = (g.endDate !== g.date) ? covDayHM(g.endDate, g.end) : String(g.end).slice(0, 5); return a + ' → ' + b + ' · ' + g.hours + 'h'; }

  function covGapHtml(r) {
    if (r.coverageUnknown) return '<div class="cov-gapbanner warn"><b>⚠ Coverage incomplete</b> — couldn\'t read ' + ((r.unreadable && r.unreadable.length) || 'one or more') + ' L1 routine(s); gaps not computed for ' + esc(dateRangeLabel(r.from, r.to)) + '. Reload and retry.</div>';
    var gaps = r.gaps || [];
    return gaps.length
      ? '<div class="cov-gapbanner warn"><b>⚠ First-responder (L1) coverage gap' + (gaps.length > 1 ? 's' : '') + '</b> in ' + esc(dateRangeLabel(r.from, r.to)) + ':<ul>' + gaps.map(function (g) { return '<li>' + esc(gapLabel(g)) + '</li>'; }).join('') + '</ul></div>'
      : '<div class="cov-gapbanner ok"><b>✓ L1 first responder is covered</b> across ' + esc(dateRangeLabel(r.from, r.to)) + '</div>';
  }
  // default level for the timeline = the first level that unions >1 routine (the interesting one), else level 1
  function effCovLevel(r) { if (state.covLevel != null) return state.covLevel; var m = (r.levels || []).find(function (l) { return (l.routines || []).length > 1; }); return m ? m.level : ((r.levels || [])[0] || {}).level; }
  function covLevelChips(r) { var eff = effCovLevel(r); return '<div class="presets cov-levelpick">' + (r.levels || []).map(function (l) { return '<button class="chip' + (l.level === eff ? ' on' : '') + '" type="button" data-covlevel="' + l.level + '" title="' + esc((l.routines || []).join(' + ')) + '">L' + l.level + ((l.routines || []).length > 1 ? ' ·' + l.routines.length : '') + '</button>'; }).join('') + '</div>'; }

  function renderCovOut() {
    var r = state.covData, box = $('#covout'), lv = $('#covlevels'); if (!r || !box) { return; } // no-op if no data — never wipe an in-flight 'resolving…'/error message
    var gapHtml = covGapHtml(r);
    if (state.covView === 'timeline') {
      if (lv) { lv.innerHTML = covLevelChips(r); applyCss(lv); }
      box.innerHTML = gapHtml + '<div id="covtl"><div class="muted">resolving…</div></div>';
      applyCss(box);
      ensureCovSlots();
      return;
    }
    if (lv) lv.innerHTML = '';
    var t = +new Date(state.covFrom + 'T' + (state.covTime || '00:00') + ':00'); // ladder instant; local == routine TZ in the operator's browser
    var ladder = (r.levels || []).map(function (L, i) {
      var band = (L.shifts || []).find(function (s) { return s.startMs <= t && t < s.endMs; });
      var real = band ? band.real : [];
      var on = real.length ? real.map(covChip).join('') : '<span class="cov-none">— no one on call</span>';
      var cls = 'cov-lvl' + (i === 0 ? ' first' : '') + (real.length ? '' : ' gap');
      return '<div class="' + cls + '"><span class="cov-lbl">L' + L.level + '</span><div class="cov-mid">' +
        '<div class="cov-rt">' + esc((L.routines || []).join(' + ')) + (L.minutes != null ? '<span class="esc">↳ ' + L.minutes + ' min</span>' : '') + '</div>' +
        '<div class="cov-on">' + on + '</div></div></div>';
    }).join('');
    box.innerHTML = gapHtml +
      '<div class="cov-when">Ladder at <b>' + esc(covDayHM(state.covFrom, state.covTime)) + '</b> · ' + esc(r.timezone || '') + ' · who is paged, in escalation order</div>' +
      ladder;
    applyCss(box);
  }

  // Timeline view: fetch the combined slot-lanes for the selected level (cached by policy|range|level), then draw them.
  async function ensureCovSlots() {
    var r = state.covData; if (!r) return; var eff = effCovLevel(r);
    var key = state.policy + '|' + state.covFrom + '|' + state.covTo + '|' + eff;
    if (state.covSlots && state.covSlotsKey === key) { renderCovTimeline(); return; }
    var tok = ++state.covEpoch; // latest request wins; older in-flight resolves are discarded
    try {
      var sd = await window.TC.oncall.coverageSlots(state.policy, { from: state.covFrom, to: state.covTo, level: eff });
      if (tok !== state.covEpoch || state.covView !== 'timeline') return; // superseded by a newer fetch, or user switched away
      if (looksDead(sd)) return sessionDead();
      if (sd && sd.error) { var e1 = $('#covtl'); if (e1) e1.innerHTML = '<div class="muted">' + esc(sd.error) + '</div>'; return; }
      state.covSlots = sd; state.covSlotsKey = key;
      renderCovTimeline();
    } catch (e) { sessionDead(e); }
  }

  function renderCovTimeline() {
    var s = state.covSlots, tl = $('#covtl'); if (!s || !tl) return;
    var days = rangeDays(s.from, s.to);
    if (!days.length || !(s.slots || []).length) { tl.innerHTML = '<div class="muted">no routines resolve on this level for the selected range</div>'; return; }
    tl.innerHTML = covTimelineHTML(s, days);
    applyCss(tl);
  }

  // Combined Overlap timeline (read-only): per-slot lanes on a CONTINUOUS multi-day axis, each shift a time-positioned
  // bar across [from..to] so the routines that page together (e.g. a weekend routine + the default) read by vertical
  // alignment. The No One placeholder is filtered, so an uncovered window shows as empty track. Mirrors renderOverlapWeek
  // (Final section) but single-section + person-coloured; reuses the .tg-* CSS and the delegated #tcpop hover popup.
  // Draws the same red now-line as the routine Overlap views when today falls inside the range.
  function covTimelineHTML(s, days) {
    var N = days.length, F = s.from;
    var nowT = nowInTz(s.timezone || 'America/New_York');
    var dayOff = function (d) { return Math.round((new Date(d + 'T00:00:00') - new Date(F + 'T00:00:00')) / 86400000); };
    var head = '<div class="tg-axis"><div class="tg-nc"></div><div class="tg-cols">' + days.map(function (ds) { return '<div class="tg-col' + (ds === nowT.date ? ' tg-td' : '') + '">' + dayLabel(ds).replace(' ', '<br>') + '</div>'; }).join('') + '</div></div>';
    var gl = ''; for (var i = 1; i < N; i++) gl += '<div class="tg-gl" data-css="left:' + (i / N * 100) + '%"></div>';
    var nseg = ''; var ni = days.indexOf(nowT.date); if (ni >= 0) nseg = '<div class="tg-nowseg" data-css="left:' + ((ni + nowT.h / 24) / N * 100) + '%"></div>';
    var multi = (s.routines || []).length > 1, lastRt = null, rows = '';
    (s.slots || []).forEach(function (sl) {
      if (multi && sl.routine !== lastRt) { rows += '<div class="tg-grp">' + esc(sl.routine) + '</div>'; lastRt = sl.routine; } // group lanes under a routine header
      var seen = {}, shifts = [];
      (sl.days || []).forEach(function (dc) { (dc.segs || []).forEach(function (sg) {
        if (!sg.on || !sg.on.length || !sg.fs || !sg.fe) return;
        var k = sg.fs.d + '|' + sg.fs.h + '|' + sg.fe.d + '|' + sg.fe.h; if (seen[k]) return; seen[k] = 1; shifts.push(sg);
      }); });
      var bars = shifts.map(function (sg) {
        var on = sg.on.filter(function (c) { return c.u !== 'no-one'; }); if (!on.length) return ''; // real coverage only — gaps show as empty track
        var col = colorOf(on[0].u);
        var a = dayOff(sg.fs.d) + hNum(sg.fs.h) / 24, b = dayOff(sg.fe.d) + hNum(sg.fe.h) / 24;
        var left = Math.max(0, a) / N * 100, right = Math.min(N, b) / N * 100, w = Math.max(right - left, 0.6);
        var names = on.map(function (c) { return nameOf(c.u); }).join(', ');
        var label = state.expanded ? nameOf(on[0].u).split(/\s+/)[0] : initials(on[0].u);
        return '<div class="tg-blk" data-css="left:' + left + '%;width:' + w + '%;background:' + col.bg + ';border-color:' + col.bd + ';color:' + col.tx + '" data-nm="' + esc(names) + '" data-slot="' + esc((multi ? sl.routine + ' · ' : '') + sl.slot) + '" data-fs="' + esc(fmtDT(sg.fs)) + '" data-fe="' + esc(fmtDT(sg.fe)) + '">' + esc(label) + '</div>';
      }).join('');
      rows += '<div class="tg-row' + (bars ? '' : ' tcv-idle') + '"><div class="tg-nc" title="' + esc(sl.slot) + '">' + esc(sl.slot) + '</div><div class="tg-track">' + gl + bars + nseg + '</div></div>';
    });
    return '<div class="tg-tz">' + esc(s.timezone || '') + ' · ' + esc(dateRangeLabel(s.from, s.to)) + ' · <b>L' + s.level + '</b> ' + esc((s.routines || []).join(' + ')) + ' · concurrent lanes = paged together</div>' + truncNote(s.to, days) + head + rows;
  }

  async function enterEdit() {
    if (!engineReady()) { banner('Engine not loaded — open a TaskCall page and reload.', 'err'); return; }
    if (!window.TC.oncall.loadBase) { banner('Editor needs a newer engine — rebuild via ./build.sh and reload the extension.', 'err'); return; }
    $('#editlist').innerHTML = '<div class="muted">loading…</div>'; $('#editform').innerHTML = ''; $('#ed-bar').innerHTML = '';
    try {
      var b = await window.TC.oncall.loadBase(state.routine);
      if (looksDead(b) || !b.layers) return sessionDead();
      state.edit = { routine: state.routine, ref: b.ref, name: b.routine_name, origName: b.routine_name, tz: b.timezone,
        isNew: false, layers: b.layers.map(edClone), formIdx: null, dirty: false, directives: b.directives || [], covers: b.covers || [] };
      renderEditor();
    } catch (e) { sessionDead(e); }
  }

  function edTemplateLayer() {
    return { name: 'New rotation', covs: [], valid_start: fmt(mondayOf(new Date())), valid_end: '9999-01-01',
      rotation_start: '09:00:00', shift_length: '08:30', rotation_frequency: 7, skip_days: [5, 6], steps: [] };
  }

  function edNewRoutine() {
    if (state.busy || state.drift) return;
    var nm = prompt('New routine name:'); if (nm == null) return; nm = nm.trim(); if (!nm) return banner('Name required.', 'warn');
    if (state.routines.indexOf(nm) >= 0) return banner('A routine named "' + nm + '" already exists.', 'warn');
    state.edit = { routine: null, ref: null, name: nm, origName: nm, tz: 'America/New_York', isNew: true,
      layers: [edTemplateLayer()], formIdx: 0, dirty: true, directives: [], covers: [] };
    if (state.mode !== 'edit') { setMode('edit'); } else { renderEditor(); }
  }

  function edRenameRoutine() {
    if (state.busy || state.drift || !state.edit) return;
    var nm = prompt('Rename routine:', state.edit.name); if (nm == null) return; nm = nm.trim(); if (!nm) return banner('Name required.', 'warn');
    state.edit.name = nm; state.edit.dirty = true; renderEditor();
  }

  async function edDeleteRoutine() {
    if (state.busy || state.drift || !state.edit) return;
    if (state.edit.isNew) { state.edit = null; setMode('view'); return; }
    if (!confirm('Delete the entire routine "' + state.edit.name + '"?\n\nRemoves the schedule and all its overrides. Any escalation policy pointing at it loses this assignee.')) return;
    setBusy(true); banner('checking references…', 'info');
    try {
      var r = await window.TC.oncall.deleteRoutine(state.routine);
      if (looksDead(r)) return sessionDead();
      if (r.blocked) {
        if (confirm('Routine "' + state.edit.name + '" is referenced by escalation policy: ' + (r.referencedBy || []).join(', ') + '.\n\nForce-delete anyway? Those policy levels will lose this assignee.')) {
          var f = await window.TC.oncall.deleteRoutine(state.routine, { force: true });
          if (looksDead(f)) return sessionDead();
          if (!f.deleted) { banner(f.error || 'not deleted', 'warn'); return; }
          banner('Force-deleted "' + state.edit.name + '".', 'ok'); afterRoutineGone();
        } else { banner('Delete cancelled — detach it in TaskCall first.', 'info'); }
        return;
      }
      if (!r.deleted) { banner(r.error || 'not deleted', 'warn'); return; }
      banner('Deleted routine "' + state.edit.name + '".', 'ok'); afterRoutineGone();
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }
  function afterRoutineGone() {
    state.edit = null; state.routine = null; clearStructPreview(); clearPreview();
    state.mode = 'view';
    root.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === 'view'); });
    $('#editbody').style.display = 'none'; $('#viewbody').style.display = 'block';
    bootstrap();
  }

  // ---- Export / Import routines (JSON backup + clone-as-new) ----
  // Everything lives server-side, so "export" is just a download of the routine's full config (base + override tiles
  // + cover markers) and "import" recreates a brand-new routine from the base rotations PLUS deliberate exception layers
  // (SET coverage/time-off + native overrides), dropping only the extension's transient OVR swap tiles. No local state involved.
  function slugify(s) { return (String(s || 'routine').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)) || 'routine'; }

  async function edExportRoutine() {
    if (state.busy) return;
    if (!state.routine) return banner('No routine selected.', 'warn');
    if (!window.TC.oncall.exportRoutine) return banner('Export needs a newer engine — rebuild via ./build.sh and reload the extension.', 'err');
    setBusy(true); banner('exporting…', 'info');
    try {
      var snap = await window.TC.oncall.exportRoutine(state.routine);
      if (looksDead(snap)) return sessionDead();
      var blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'routine-' + slugify(snap.routine_name) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      banner('exported "' + snap.routine_name + '" (saved state · ' + (snap.routine_layers || []).length + ' layers)', 'ok');
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  function edImportRoutine() {
    if (state.busy) return;
    if (state.drift) return banner('Import is disabled while the engine is out of date — rebuild via ./build.sh and reload.', 'err');
    if (!window.TC.oncall.importRoutine) return banner('Import needs a newer engine — rebuild via ./build.sh and reload the extension.', 'err');
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var snap;
        try { snap = JSON.parse(String(fr.result)); } catch (e) { banner('That file isn\'t valid JSON.', 'err'); return; }
        if (!snap || snap.format !== 'taskcall-oncall-routine' || !Array.isArray(snap.routine_layers)) { banner('Not a TaskCall routine export file.', 'err'); return; }
        var base = snap.routine_layers.filter(function (L) { return L && !L.is_exception; }).length;
        var tiles = snap.routine_layers.length - base;
        if (!base) { banner('That export has no base rotations to import.', 'err'); return; }
        var note = base + ' rotation' + (base === 1 ? '' : 's') + (tiles ? ' · ' + tiles + ' dated override' + (tiles === 1 ? '' : 's') + ' will NOT be copied into the new routine' : '');
        var name = prompt('Import as a NEW routine named:\n(' + note + ')', (snap.routine_name || 'Imported routine') + ' (copy)');
        if (name == null) return; name = name.trim();
        if (!name) { banner('Name required.', 'warn'); return; }
        if (state.routines.indexOf(name) >= 0) { banner('A routine named "' + name + '" already exists.', 'warn'); return; }
        doImport(snap, name);
      };
      fr.readAsText(f);
    });
    inp.click();
  }

  async function doImport(snap, name) {
    setBusy(true); banner('importing…', 'info');
    try {
      var r = await window.TC.oncall.importRoutine(snap, name);
      if (looksDead(r)) return sessionDead();
      if (!r.created) { banner(r.error || 'import failed', 'warn'); return; }
      await refreshRoutineList();
      banner('imported as "' + r.routine_name + '" (' + r.layerCount + ' rotation' + (r.layerCount === 1 ? '' : 's') + ') — pick it in the Routine dropdown', 'ok');
    } catch (e) { sessionDead(e); } finally { setBusy(false); }
  }

  // refresh just the routine dropdown options (after an import) without disturbing the current selection or mode
  async function refreshRoutineList() {
    try {
      var list = await window.TC.routines.list();
      if (looksDead(list) || !Array.isArray(list)) return;
      state.routines = list.map(function (r) { return r.routine_name; });
      var sel = $('#routine'); if (!sel) return; var cur = sel.value;
      sel.innerHTML = state.routines.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
      sel.value = cur;
    } catch (e) { }
  }

  // ---- rotation list + bottom bar ----
  function renderEditor() {
    if (!state.edit) { $('#editlist').innerHTML = ''; $('#editform').innerHTML = ''; $('#ed-bar').innerHTML = ''; return; }
    var e = state.edit;
    $('#ed-rtnote').textContent = (e.isNew ? 'New routine: ' : 'Editing: ') + e.name + (e.dirty && !e.isNew ? ' · unsaved' : '');
    $('#ed-del').textContent = e.isNew ? 'Cancel' : 'Delete routine';
    var rows = e.layers.map(function (L, i) {
      var tag = (L.covs && L.covs.length) ? ' <span class="ed-cov">cover</span>' : '';
      var sub = winSummary(L);
      return '<div class="ed-row' + (e.formIdx === i ? ' on' : '') + '"><div class="ed-rowmain" data-edit="' + i + '">' +
        '<div class="ed-rowname">' + esc(L.name || '(unnamed)') + tag + '</div>' +
        '<div class="ed-rowsub">' + esc(sub) + '</div></div>' +
        '<div class="ed-rowbtns"><button type="button" class="ed-ic" data-up="' + i + '"' + (i === 0 ? ' disabled' : '') + ' title="move up">↑</button>' +
        '<button type="button" class="ed-ic" data-down="' + i + '"' + (i === e.layers.length - 1 ? ' disabled' : '') + ' title="move down">↓</button>' +
        '<button type="button" class="ed-ic" data-edit="' + i + '" title="edit">✎</button>' +
        '<button type="button" class="ed-ic ed-danger" data-delrow="' + i + '" title="delete">✕</button></div></div>';
    }).join('');
    $('#editlist').innerHTML = rows || '<div class="muted">no rotations, click "+ Add rotation".</div>';
    $('#editlist').querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { edOpenForm(+b.getAttribute('data-edit')); }); });
    $('#editlist').querySelectorAll('[data-up]').forEach(function (b) { b.addEventListener('click', function () { edMove(+b.getAttribute('data-up'), -1); }); });
    $('#editlist').querySelectorAll('[data-down]').forEach(function (b) { b.addEventListener('click', function () { edMove(+b.getAttribute('data-down'), 1); }); });
    $('#editlist').querySelectorAll('[data-delrow]').forEach(function (b) { b.addEventListener('click', function () { edDeleteRotation(+b.getAttribute('data-delrow')); }); });
    if (e.formIdx != null && e.layers[e.formIdx]) renderForm(); else $('#editform').innerHTML = '';
    renderEdBar();
    updateControls();
  }

  function renderEdBar() {
    var e = state.edit; if (!e) { $('#ed-bar').innerHTML = ''; return; }
    var can = e.dirty || e.isNew;
    $('#ed-bar').innerHTML = can
      ? '<div class="ed-baract"><button class="btn pri" type="button" id="ed-preview">preview changes</button>' +
        (e.isNew ? '<button class="btn" type="button" id="ed-cancelnew">cancel</button>' : '<button class="btn" type="button" id="ed-discard">discard changes</button>') + '</div>'
      : '<div class="muted" data-css="margin-top:10px">No unsaved changes. Edit a rotation, add, remove, or reorder — then preview &amp; apply.</div>';
    applyCss($('#ed-bar'));
    var pv = $('#ed-preview'); if (pv) pv.addEventListener('click', edPreview);
    var ds = $('#ed-discard'); if (ds) ds.addEventListener('click', function () { if (confirm('Discard all unsaved changes to this routine?')) enterEdit(); });
    var cn = $('#ed-cancelnew'); if (cn) cn.addEventListener('click', function () { state.edit = null; setMode('view'); });
  }

  function edMarkDirty() { if (state.edit) { state.edit.dirty = true; renderEdBar(); } } // keep the preview/discard bar in sync after ANY form mutation
  function edAddRotation() { if (!state.edit) return; state.edit.layers.push(edTemplateLayer()); state.edit.formIdx = state.edit.layers.length - 1; edMarkDirty(); renderEditor(); }
  function edDeleteRotation(i) {
    if (!state.edit) return;
    if (state.edit.layers.length <= 1) return banner('A routine needs at least one rotation.', 'warn');
    if (!confirm('Delete rotation "' + (state.edit.layers[i].name || '') + '"?')) return;
    state.edit.layers.splice(i, 1);
    if (state.edit.formIdx === i) state.edit.formIdx = null; else if (state.edit.formIdx > i) state.edit.formIdx--;
    edMarkDirty(); renderEditor();
  }
  function edMove(i, dir) {
    if (!state.edit) return; var L = state.edit.layers, j = i + dir; if (j < 0 || j >= L.length) return;
    var t = L[i]; L[i] = L[j]; L[j] = t;
    if (state.edit.formIdx === i) state.edit.formIdx = j; else if (state.edit.formIdx === j) state.edit.formIdx = i;
    edMarkDirty(); renderEditor();
  }
  function edOpenForm(i) { if (!state.edit) return; var opening = state.edit.formIdx !== i; state.edit.formIdx = opening ? i : null; if (opening && state.edit.layers[i]) state.edit.layers[i]._raw = false; renderEditor(); }

  // ---- PERSON + ROTATING-OFF form (one person, off one turn in N — the off-unit follows the real cadence: day / week / turn — no repeats, no No One to type) ----
  function renderRotForm(L, ro) {
    var unit = rotUnit(L);
    var userOpts = state.users.filter(function (p) { return p[1] !== 'no-one'; }).map(function (p) { return '<option value="' + esc(p[1]) + '"' + (p[1] === ro.person ? ' selected' : '') + '>' + esc(p[0]) + '</option>'; }).join('');
    var dayBoxes = EDOW.map(function (lbl, d) { var onv = (L.skip_days || []).indexOf(d) < 0; return '<label class="ed-day' + (onv ? ' on' : '') + '"><input type="checkbox" data-day="' + d + '"' + (onv ? ' checked' : '') + '>' + lbl + '</label>'; }).join('');
    var hasEnd = L.valid_end && String(L.valid_end).slice(0, 4) !== '9999';
    $('#editform').innerHTML =
      '<div class="ed-form">' +
      '<div class="ed-fhd">Edit shift</div>' +
      '<label for="ef-name">Name</label><input type="text" id="ef-name" value="' + esc(L.name || '') + '">' +
      '<label for="ef-person">Person</label><select id="ef-person">' + userOpts + '</select>' +
      '<div class="row"><div><label for="ef-offwk">Off in ' + unit + '</label><input type="number" id="ef-offwk" min="1" max="' + ro.cycleLen + '" value="' + (ro.offIdx + 1) + '"></div>' +
      '<div><label for="ef-cyclen">of a … ' + unit + ' rotation</label><input type="number" id="ef-cyclen" min="2" max="52" value="' + ro.cycleLen + '"></div></div>' +
      '<div class="ed-readout">' + esc(nameOf(ro.person)) + ' works ' + (ro.cycleLen - 1) + ' of every ' + ro.cycleLen + ' ' + unit + 's · off ' + unit + ' ' + (ro.offIdx + 1) + '</div>' +
      '<div class="row"><div><label for="ef-start">Shift starts</label><input type="time" id="ef-start" value="' + hhmm(L.rotation_start) + '"></div>' +
      '<div><label for="ef-len">Length (HH:MM, ≤ 24:00)</label><input type="text" id="ef-len" value="' + hhmm(L.shift_length) + '" placeholder="08:30"><span id="ef-len-err" class="ed-fielderr"></span></div></div>' +
      '<label>Active days <span class="muted">· days the shift STARTS</span></label><div class="ed-days">' + dayBoxes + '</div>' +
      '<div class="ed-daypresets"><button type="button" class="ed-preset" data-dpreset="all">Every day</button><button type="button" class="ed-preset" data-dpreset="wd">Mon–Fri</button><button type="button" class="ed-preset" data-dpreset="we">Weekends</button><span id="ef-days-err" class="ed-fielderr"></span></div>' +
      '<div class="row"><div><label for="ef-vstart">Rotation start date <span class="muted">· cycle anchor</span></label><input type="date" id="ef-vstart" value="' + esc(L.valid_start) + '"></div>' +
      '<div><label class="ed-inline"><input type="checkbox" id="ef-hasend"' + (hasEnd ? ' checked' : '') + '> Ends on</label><input type="date" id="ef-vend"' + (hasEnd ? '' : ' data-css="display:none"') + ' value="' + esc(hasEnd ? L.valid_end : '') + '"></div></div>' +
      '<div class="ed-formacts"><button type="button" class="btn sm ed-rawlink" id="ef-raw">edit as steps (advanced)</button><button type="button" class="btn sm" id="ef-done">done</button></div>' +
      '</div>';
    applyCss($('#editform'));
    wireRotForm(L);
  }
  function wireRotForm(L) {
    function apply() { var person = $('#ef-person').value; var M = Math.max(2, Math.min(52, +$('#ef-cyclen').value || 2)); var N = Math.max(1, Math.min(M, +$('#ef-offwk').value || 1)); rebuildRot(L, person, N - 1, M); edMarkDirty(); }
    $('#ef-name').addEventListener('change', function () { L.name = $('#ef-name').value; edMarkDirty(); softRefresh(); });
    $('#ef-person').addEventListener('change', function () { apply(); softRefresh(); });
    $('#ef-offwk').addEventListener('change', function () { apply(); softRefresh(); });
    $('#ef-cyclen').addEventListener('change', function () { apply(); renderForm(); });
    $('#ef-start').addEventListener('change', function () { L.rotation_start = hhmmss($('#ef-start').value); edMarkDirty(); softRefresh(); });
    $('#ef-len').addEventListener('change', function () { L.shift_length = hhmm($('#ef-len').value); edCheckLen(); edMarkDirty(); softRefresh(); });
    $('#ef-vstart').addEventListener('change', function () { L.valid_start = $('#ef-vstart').value; edMarkDirty(); });
    $('#ef-hasend').addEventListener('change', function () { L.valid_end = $('#ef-hasend').checked ? (($('#ef-vend') && $('#ef-vend').value) || fmt(addDays(new Date(), 30))) : '9999-01-01'; edMarkDirty(); renderForm(); });
    var ve = $('#ef-vend'); if (ve) ve.addEventListener('change', function () { L.valid_end = ve.value || '9999-01-01'; edMarkDirty(); });
    root.querySelectorAll('[data-day]').forEach(function (b) { b.addEventListener('change', function () {
      var d = +b.getAttribute('data-day'); var sk = L.skip_days || (L.skip_days = []); var idx = sk.indexOf(d);
      if (b.checked) { if (idx >= 0) sk.splice(idx, 1); }
      else { if (sk.length >= 6 && idx < 0) { b.checked = true; edFlashDays('At least one active day is required.'); return; } if (idx < 0) sk.push(d); } // never skip all 7
      sk.sort(function (a, c) { return a - c; }); edFlashDays(''); edMarkDirty(); softRefresh(); if (b.parentNode) b.parentNode.classList.toggle('on', b.checked);
    }); });
    $('#ef-raw').addEventListener('click', function () { L._raw = true; renderForm(); });
    $('#ef-done').addEventListener('click', function () { state.edit.formIdx = null; renderEditor(); });
    wireDayPresets(L); edCheckLen();
    updateControls();
  }

  // Field-level guards shared by BOTH rotation forms — immediate feedback only; the engine's _validateLayer stays the hard gate at Preview.
  function edCheckLen() { var inp = $('#ef-len'), el = $('#ef-len-err'); if (!inp || !el) return true; var m = slMin(inp.value), ok = m >= 1 && m <= 1440; inp.classList.toggle('bad', !ok); el.textContent = ok ? '' : 'Length must be 00:01–24:00 — split a >24h span into per-day rotations.'; return ok; }
  function edFlashDays(msg) { var el = $('#ef-days-err'); if (el) el.textContent = msg || ''; }
  // Active-day quick presets (every day / Mon–Fri / weekends). renderForm() re-dispatches to the rotating-off form when appropriate, so this rewires correctly from either.
  function wireDayPresets(L) {
    root.querySelectorAll('[data-dpreset]').forEach(function (b) { b.addEventListener('click', function () {
      var p = b.getAttribute('data-dpreset');
      L.skip_days = p === 'all' ? [] : p === 'wd' ? [5, 6] : [0, 1, 2, 3, 4]; // active days = every day / Mon–Fri / Sat+Sun
      edMarkDirty(); renderForm(); softRefresh();
    }); });
  }

  // ---- the rotation form (TaskCall-faithful) ----
  function renderForm() {
    var e = state.edit, L = e.layers[e.formIdx]; if (!L) { $('#editform').innerHTML = ''; return; }
    var ro = (!L._raw) ? rotInfo(L) : null;
    if (ro) return renderRotForm(L, ro);
    var freq = +L.rotation_frequency || 7, ft = freqType(freq);
    var isWeeks = ft === 'weeks', showN = isWeeks || ft === 'custom'; // 'Every N weeks' and 'Every N days' both reveal the count input
    var nLabel = isWeeks ? 'Weeks per step' : 'Days per step', nVal = isWeeks ? (freq / 7) : freq, nMin = isWeeks ? 2 : 1, nMax = isWeeks ? 52 : 365, nUnit = isWeeks ? 'weeks' : 'days';
    var stepHtml = (L.steps || []).map(function (st, si) {
      var chips = st.map(function (u, gi) { var c = colorOf(u); return '<span class="ed-chip" data-css="background:' + c.bg + ';border-color:' + c.bd + ';color:' + c.tx + '">' + esc(nameOf(u)) + '<button type="button" class="ed-x" data-delp="' + si + '.' + gi + '" aria-label="remove">×</button></span>'; }).join('');
      return '<div class="ed-step"><span class="ed-stepn">' + (si + 1) + '</span><div class="ed-chips">' + chips + '</div>' +
        '<button type="button" class="ed-ic" data-addp="' + si + '" title="add the picked person to this step">+</button>' +
        '<button type="button" class="ed-ic" data-stepup="' + si + '"' + (si === 0 ? ' disabled' : '') + ' title="move up">↑</button>' +
        '<button type="button" class="ed-ic" data-stepdown="' + si + '"' + (si === L.steps.length - 1 ? ' disabled' : '') + ' title="move down">↓</button>' +
        '<button type="button" class="ed-ic ed-danger" data-delstep="' + si + '" title="remove step">✕</button></div>';
    }).join('');
    var userOpts = state.users.map(function (p) { return '<option value="' + esc(p[1]) + '">' + esc(p[0]) + '</option>'; }).join('');
    var dayBoxes = EDOW.map(function (lbl, d) { var onv = (L.skip_days || []).indexOf(d) < 0; return '<label class="ed-day' + (onv ? ' on' : '') + '"><input type="checkbox" data-day="' + d + '"' + (onv ? ' checked' : '') + '>' + lbl + '</label>'; }).join('');
    var hasEnd = L.valid_end && String(L.valid_end).slice(0, 4) !== '9999';
    $('#editform').innerHTML =
      '<div class="ed-form">' +
      '<div class="ed-fhd">Edit shift <span class="muted">· advanced (multi-person rotation)</span></div>' +
      '<label for="ef-name">Name</label><input type="text" id="ef-name" value="' + esc(L.name || '') + '">' +
      '<label>Participants <span class="muted">· rotation order (top → bottom); each step = one turn in the cycle</span></label>' +
      '<div id="ef-steps">' + (stepHtml || '<div class="muted">no participants yet — add one below.</div>') + '</div>' +
      '<div class="ed-addrow"><select id="ef-pick">' + userOpts + '</select><button type="button" class="btn sm" id="ef-addstep">+ add as new step</button></div>' +
      '<div class="row"><div><label for="ef-ftype">Rotation type</label><select id="ef-ftype">' +
        '<option value="weekly"' + (ft === 'weekly' ? ' selected' : '') + '>Weekly</option>' +
        '<option value="weeks"' + (ft === 'weeks' ? ' selected' : '') + '>Every N weeks</option>' +
        '<option value="daily"' + (ft === 'daily' ? ' selected' : '') + '>Daily</option>' +
        '<option value="custom"' + (ft === 'custom' ? ' selected' : '') + '>Every N days</option></select></div>' +
      '<div id="ef-nwrap"' + (showN ? '' : ' data-css="display:none"') + '><label for="ef-ndays">' + nLabel + '</label><input type="number" id="ef-ndays" min="' + nMin + '" max="' + nMax + '" value="' + nVal + '" data-unit="' + nUnit + '"></div></div>' +
      '<div class="row"><div><label for="ef-start">Shift starts</label><input type="time" id="ef-start" value="' + hhmm(L.rotation_start) + '"></div>' +
      '<div><label for="ef-len">Length (HH:MM, ≤ 24:00)</label><input type="text" id="ef-len" value="' + hhmm(L.shift_length) + '" placeholder="08:30"><span id="ef-len-err" class="ed-fielderr"></span></div></div>' +
      '<label>Active days <span class="muted">· days the shift STARTS</span></label><div class="ed-days">' + dayBoxes + '</div>' +
      '<div class="ed-daypresets"><button type="button" class="ed-preset" data-dpreset="all">Every day</button><button type="button" class="ed-preset" data-dpreset="wd">Mon–Fri</button><button type="button" class="ed-preset" data-dpreset="we">Weekends</button><span id="ef-days-err" class="ed-fielderr"></span></div>' +
      '<div class="row"><div><label for="ef-vstart">Rotation start date <span class="muted">· cycle anchor</span></label><input type="date" id="ef-vstart" value="' + esc(L.valid_start) + '"></div>' +
      '<div><label class="ed-inline"><input type="checkbox" id="ef-hasend"' + (hasEnd ? ' checked' : '') + '> Ends on</label><input type="date" id="ef-vend"' + (hasEnd ? '' : ' data-css="display:none"') + ' value="' + esc(hasEnd ? L.valid_end : '') + '"></div></div>' +
      (L.covs && L.covs.length ? '<div class="ed-warn">⚠ Active cover on this rotation (' + L.covs.map(function (c) { return esc(nameOf(c.out)) + '→' + esc(nameOf(c.in)); }).join(', ') + '). The editor preserves it; for cover changes use the overrides panel.</div>' : '') +
      '<div class="ed-formacts"><button type="button" class="btn sm" id="ef-done">done</button></div>' +
      '</div>';
    applyCss($('#editform'));
    wireForm();
  }

  function wireForm() {
    var e = state.edit, L = e.layers[e.formIdx]; if (!L) return;
    $('#ef-name').addEventListener('change', function () { L.name = $('#ef-name').value; edMarkDirty(); softRefresh(); });
    $('#ef-start').addEventListener('change', function () { L.rotation_start = hhmmss($('#ef-start').value); edMarkDirty(); softRefresh(); });
    $('#ef-len').addEventListener('change', function () { L.shift_length = hhmm($('#ef-len').value); edCheckLen(); edMarkDirty(); softRefresh(); });
    $('#ef-vstart').addEventListener('change', function () { L.valid_start = $('#ef-vstart').value; edMarkDirty(); });
    $('#ef-ftype').addEventListener('change', function () {
      var v = $('#ef-ftype').value, cur = +L.rotation_frequency;
      L.rotation_frequency = v === 'daily' ? 1 : v === 'weekly' ? 7
        : v === 'weeks' ? (freqType(cur) === 'weeks' ? cur : 14)   // keep the current week-count, else default 2 weeks
        : (freqType(cur) === 'custom' ? cur : 3);                  // 'Every N days': keep a non-week count, else default 3
      edMarkDirty(); renderForm();
    });
    var nd = $('#ef-ndays'); if (nd) nd.addEventListener('change', function () {
      var weeks = nd.getAttribute('data-unit') === 'weeks';
      L.rotation_frequency = weeks ? Math.max(2, Math.min(52, +nd.value || 2)) * 7 : Math.max(1, Math.min(365, +nd.value || 1));
      edMarkDirty(); softRefresh(); // reflect the new cadence in the row summary
    });
    $('#ef-hasend').addEventListener('change', function () { L.valid_end = $('#ef-hasend').checked ? (($('#ef-vend') && $('#ef-vend').value) || fmt(addDays(new Date(), 30))) : '9999-01-01'; edMarkDirty(); renderForm(); });
    var ve = $('#ef-vend'); if (ve) ve.addEventListener('change', function () { L.valid_end = ve.value || '9999-01-01'; edMarkDirty(); });
    root.querySelectorAll('[data-day]').forEach(function (b) { b.addEventListener('change', function () {
      var d = +b.getAttribute('data-day'); var sk = L.skip_days || (L.skip_days = []); var idx = sk.indexOf(d);
      if (b.checked) { if (idx >= 0) sk.splice(idx, 1); }
      else { if (sk.length >= 6 && idx < 0) { b.checked = true; edFlashDays('At least one active day is required.'); return; } if (idx < 0) sk.push(d); } // never skip all 7
      sk.sort(function (a, c) { return a - c; }); edFlashDays(''); edMarkDirty(); softRefresh(); if (b.parentNode) b.parentNode.classList.toggle('on', b.checked);
    }); });
    $('#ef-addstep').addEventListener('click', function () { var u = $('#ef-pick').value; if (!u) return; L.steps.push([u]); edMarkDirty(); renderForm(); softRefresh(); });
    root.querySelectorAll('[data-addp]').forEach(function (b) { b.addEventListener('click', function () { var si = +b.getAttribute('data-addp'), u = $('#ef-pick').value; if (!u) return; if (L.steps[si].indexOf(u) < 0) L.steps[si].push(u); edMarkDirty(); renderForm(); softRefresh(); }); });
    root.querySelectorAll('[data-delp]').forEach(function (b) { b.addEventListener('click', function () { var p = b.getAttribute('data-delp').split('.'), si = +p[0], gi = +p[1]; L.steps[si].splice(gi, 1); if (!L.steps[si].length) L.steps.splice(si, 1); edMarkDirty(); renderForm(); softRefresh(); }); });
    root.querySelectorAll('[data-delstep]').forEach(function (b) { b.addEventListener('click', function () { L.steps.splice(+b.getAttribute('data-delstep'), 1); edMarkDirty(); renderForm(); softRefresh(); }); });
    root.querySelectorAll('[data-stepup]').forEach(function (b) { b.addEventListener('click', function () { var si = +b.getAttribute('data-stepup'); if (si > 0) { var t = L.steps[si]; L.steps[si] = L.steps[si - 1]; L.steps[si - 1] = t; edMarkDirty(); renderForm(); } }); });
    root.querySelectorAll('[data-stepdown]').forEach(function (b) { b.addEventListener('click', function () { var si = +b.getAttribute('data-stepdown'); if (si < L.steps.length - 1) { var t = L.steps[si]; L.steps[si] = L.steps[si + 1]; L.steps[si + 1] = t; edMarkDirty(); renderForm(); } }); });
    $('#ef-done').addEventListener('click', function () { state.edit.formIdx = null; renderEditor(); });
    wireDayPresets(L); edCheckLen();
    updateControls();
  }

  // light update of the row list + bar without rebuilding the open form (keeps input focus)
  function softRefresh() {
    var e = state.edit; if (!e) return;
    $('#ed-rtnote').textContent = (e.isNew ? 'New routine: ' : 'Editing: ') + e.name + (e.dirty && !e.isNew ? ' · unsaved' : '');
    var rowMains = $('#editlist').querySelectorAll('.ed-row');
    if (rowMains && rowMains[e.formIdx]) { var L = e.layers[e.formIdx]; var nm = rowMains[e.formIdx].querySelector('.ed-rowname'); var sb = rowMains[e.formIdx].querySelector('.ed-rowsub');
      var tag = (L.covs && L.covs.length) ? ' <span class="ed-cov">cover</span>' : '';
      if (nm) nm.innerHTML = esc(L.name || '(unnamed)') + tag; if (sb) sb.textContent = winSummary(L); }
    renderEdBar();
  }

  // ---- preview (dry-run) → switch to View mode showing the RESULTING schedule, with Apply / Back ----
  async function edPreview() {
    if (state.busy || state.drift || !state.edit) return;
    var e = state.edit;
    setBusy(true); banner('checking…', 'info');
    try {
      var previewLayers, dropped = [];
      if (e.isNew) {
        var c = window.TC.oncall.toStoreLayers(e.layers);
        if (looksDead(c)) return sessionDead();
        if (c.error) { banner(c.error, 'warn'); return; }
        previewLayers = c.layers;
      } else {
        var r = await window.TC.oncall.saveBase(state.routine, e.layers, { dryRun: true });
        if (looksDead(r)) return sessionDead();
        if (r.error) { banner(r.error, 'warn'); return; }
        previewLayers = r.previewLayers; dropped = r.dropped || [];
      }
      var meta = { routine_name: e.name, timezone: e.tz };
      state.structLayers = previewLayers;
      state.previewData = {
        slots: window.TC.oncall.slotsFromLayers(meta, previewLayers, { from: state.from, to: state.to }),
        view: window.TC.oncall.viewFromLayers(meta, previewLayers, { from: state.from, to: state.to }),
        inUser: null, outs: [], dates: {}, structural: true,
        summary: (e.isNew ? 'new routine "' + e.name + '"' : 'edited rotations') + (dropped.length ? ' · ' + dropped.length + ' override' + (dropped.length > 1 ? 's' : '') + ' dropped' : '')
      };
      state.structPreview = true;
      state.mode = 'view';
      root.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === 'view'); });
      $('#editbody').style.display = 'none'; $('#viewbody').style.display = 'block';
      $('#swapSec').style.display = 'none'; $('#activeSec').style.display = 'none';
      renderStructBar(dropped); renderSched(); banner('', '');
    } catch (e2) { sessionDead(e2); } finally { setBusy(false); }
  }

  function renderStructBar(dropped) {
    var e = state.edit;
    var warn = (dropped && dropped.length) ? '<div class="ed-warn">⚠ Drops ' + dropped.length + ' override' + (dropped.length > 1 ? 's' : '') + ': ' + dropped.map(function (d) { return esc(nameOf(d.out)) + '→' + esc(d.in ? nameOf(d.in) : '(removed)') + ' (' + esc(d.from) + ')'; }).join(', ') + ' — that person no longer lands in the override window after this edit.</div>' : '';
    $('#structBar').innerHTML = '<div class="ed-prev"><b>⟳ Preview' + (e && e.isNew ? ' — new routine' : '') + '</b> <span class="muted">resulting schedule below — not applied yet. Change the date range to inspect.</span>' + warn +
      '<div class="ed-baract"><button class="btn pri" type="button" id="sb-apply">' + (e && e.isNew ? 'create routine' : 'apply changes') + '</button><button class="btn" type="button" id="sb-back">back to editor</button></div></div>';
    $('#structBar').style.display = 'block'; applyCss($('#structBar'));
    $('#sb-apply').addEventListener('click', edApply);
    $('#sb-back').addEventListener('click', edBackToEditor);
    updateControls();
  }

  function clearStructPreview() {
    state.structPreview = false; state.structLayers = null;
    if (state.previewData && state.previewData.structural) state.previewData = null;
    var sb = $('#structBar'); if (sb) { sb.style.display = 'none'; sb.innerHTML = ''; }
    var ss = $('#swapSec'); if (ss) ss.style.display = '';
    var as = $('#activeSec'); if (as) as.style.display = '';
  }
  function reResolveStruct() {
    if (!state.structLayers) return;
    var meta = { routine_name: (state.edit && state.edit.name) || state.routine, timezone: (state.edit && state.edit.tz) || 'America/New_York' };
    state.previewData.slots = window.TC.oncall.slotsFromLayers(meta, state.structLayers, { from: state.from, to: state.to });
    state.previewData.view = window.TC.oncall.viewFromLayers(meta, state.structLayers, { from: state.from, to: state.to });
    renderSched();
  }
  function edBackToEditor() { clearStructPreview(); setMode('edit'); }

  async function edApply() {
    if (state.busy || state.drift || !state.edit) return;
    var e = state.edit;
    setBusy(true); banner(e.isNew ? 'creating…' : 'applying…', 'info');
    try {
      var r;
      if (e.isNew) {
        r = await window.TC.oncall.createRoutine(e.name, e.layers, e.tz);
        if (looksDead(r)) return sessionDead();
        if (!r.created) { banner(r.error || 'not created', 'warn'); return; }
        banner('Created routine "' + e.name + '".', 'ok');
      } else {
        r = await window.TC.oncall.saveBase(state.routine, e.layers, { newName: e.name !== e.origName ? e.name : null });
        if (looksDead(r)) return sessionDead();
        if (!r.applied) { banner(r.error || 'not applied', 'warn'); return; }
        banner('Applied changes to "' + r.routine + '"' + (r.dropped && r.dropped.length ? ' · ' + r.dropped.length + ' override(s) dropped' : '') + '.', 'ok');
      }
      var newName = e.isNew ? e.name : (r.routine || e.name);
      state.edit = null; state.routine = newName; state.mode = 'view';
      root.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === 'view'); });
      $('#editbody').style.display = 'none'; $('#viewbody').style.display = 'block';
      clearStructPreview();
      await bootstrap();
    } catch (e2) { sessionDead(e2); } finally { setBusy(false); }
  }

  // Rich hover popup: full name + who they cover + slot + the whole shift's Starts/Ends datetime.
  // Driven by data-nm/data-cov/data-slot/data-fs/data-fe on each bar/chip. Positioned via the CSSOM (CSP-safe).
  function showPop(el) {
    var nm = el.getAttribute('data-nm'); if (!nm) return;
    var cov = el.getAttribute('data-cov'), slot = el.getAttribute('data-slot'), fs = el.getAttribute('data-fs'), fe = el.getAttribute('data-fe');
    var pop = $('#tcpop'); if (!pop) return;
    pop.innerHTML = '<div class="pn">' + esc(nm) + '</div>' +
      (cov ? '<div class="pr">↩ covering <b>' + esc(cov) + '</b></div>' : '') +
      (slot ? '<div class="pslot">' + esc(slot) + '</div>' : '') +
      (fs ? '<div class="pr">Starts&nbsp;&nbsp;<b>' + esc(fs) + '</b></div>' : '') +
      (fe ? '<div class="pr">Ends&nbsp;&nbsp;&nbsp;<b>' + esc(fe) + '</b></div>' : '');
    pop.style.display = 'block';
    var r = el.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    var top = r.top - pr.height - 7; if (top < 6) top = r.bottom + 7;
    var left = r.left; if (left + pr.width > window.innerWidth - 6) left = window.innerWidth - pr.width - 6; if (left < 6) left = 6;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function hidePop() { var p = $('#tcpop'); if (p) p.style.display = 'none'; }
  function banner(msg, kind) { var b = $('#banner'); if (!msg) { b.style.display = 'none'; b.textContent = ''; return; } b.style.display = 'block'; b.className = 'banner ' + (kind || ''); b.textContent = msg; }
  function sessionDead(e) { var m = e && e.message; banner(m ? m : 'TaskCall session expired or engine unavailable — reload the tab and sign in, then reopen.', 'err'); return null; }

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}' +
    '#launch,#panel{pointer-events:auto}' +
    '#launch{position:fixed;right:18px;bottom:18px;background:#1d9e75;color:#fff;border:none;border-radius:24px;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}' +
    '#panel{display:none;position:fixed;right:18px;bottom:70px;width:440px;max-height:84vh;flex-direction:column;background:#fff;color:#1a1a1a;border:1px solid #d8d8d2;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden}' +
    '.hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eee}' +
    '.hd b{font-size:15px;font-weight:600}' +
    '#expand{margin-left:auto;background:none;border:none;font-size:16px;cursor:pointer;color:#888;line-height:1}#close{background:none;border:none;font-size:18px;cursor:pointer;color:#888;line-height:1;margin-left:4px}' +
    '#panel.xpand{width:96vw;height:92vh;max-height:92vh;right:2vw;bottom:2vh}' +
    '#panel.xpand .sl-cell{min-height:30px}#panel.xpand .sl-chip{font-size:11px;padding:2px 7px}#panel.xpand .sl-row{min-height:30px}#panel.xpand .tg-row,#panel.xpand .tcv-row{height:30px}#panel.xpand .tg-nc{flex-basis:120px;width:120px}#panel.xpand .tg-blk,#panel.xpand .tcv-blk{font-size:11px}' +
    '.body{padding:12px 14px;overflow:auto}' +
    'label{font-size:12px;color:#666;display:block;margin:10px 0 3px}' +
    'select,input[type=date]{width:100%;padding:7px 9px;font-size:13px;border:1px solid #ccc;border-radius:7px;background:#fff;color:#1a1a1a}' +
    '.row{display:flex;gap:8px}.row>div{flex:1}' +
    '.presets{display:flex;gap:6px;margin:8px 0 2px;flex-wrap:wrap}' +
    '.btn{font-size:13px;padding:7px 12px;border:1px solid #ccc;border-radius:7px;background:#fff;color:#1a1a1a;cursor:pointer}' +
    '.btn:hover{background:#f4f4f0}.btn.sm{padding:4px 9px;font-size:12px}.btn.pri{background:#1d9e75;border-color:#1d9e75;color:#fff}.btn:disabled{opacity:.5;cursor:default}' +
    '.chip{font-size:11px;padding:4px 9px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#1a1a1a;cursor:pointer}.chip:hover{background:#f4f4f0}.chip:disabled{opacity:.5}' +
    '.sec{margin-top:14px;border-top:1px solid #eee;padding-top:10px}.sec h4{margin:0;font-size:12px;color:#888;font-weight:600}' +
    '.sechead{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
    '.muted{color:#999;font-size:12px}' +
    '.banner{display:none;margin:8px 0;padding:8px 10px;border-radius:7px;font-size:12px}' +
    '.banner.err{background:#fcebeb;color:#a32d2d}.banner.warn{background:#faeeda;color:#854f0b}.banner.ok{background:#e1f5ee;color:#0f6e56}.banner.info{background:#eef;color:#333}' +
    '.diff{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:4px 0;border-top:1px solid #f1f1f1}.diff b{color:#0f6e56}.diff s{color:#aaa}' +
    '.pvhead{font-size:12px;margin:6px 0}.pvhead .ok{color:#0f6e56}.pvhead .warn{color:#854f0b}' +
    '.acts{display:flex;gap:8px;margin-top:10px}' +
    '.ovrow{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;padding:5px 0;border-top:1px solid #f1f1f1}' +
    '.cov{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;color:#666}' +
    '.ft{padding:8px 14px;border-top:1px solid #eee;font-size:11px;color:#aaa;display:flex;justify-content:space-between}' +
    '.tcv-seg{display:inline-flex;border:1px solid #ccc;border-radius:6px;overflow:hidden}' +
    '.tcv-seg button{border:none;background:#fff;padding:3px 12px;font-size:12px;cursor:pointer;color:#666}.tcv-seg button.on{background:#eef;color:#1a1a1a;font-weight:500}' +
    '.tcv-name{font-size:11px;padding:3px 6px 3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.ovlbar{display:flex;align-items:center;gap:12px;justify-content:center;margin:6px 0 10px}.ovlbar .tcv-daynav{margin:0}' +
    '.tcv-daynav{display:flex;align-items:center;gap:8px;justify-content:center;margin:4px 0 12px;font-size:12px}.tcv-daynav button{border:0.5px solid #ccc;background:#fff;border-radius:5px;padding:1px 9px;cursor:pointer}.tcv-daynav button:disabled{opacity:.4}' +
    '.tcv-axis{position:relative;height:13px;margin-left:92px;margin-bottom:3px}.tcv-tick{position:absolute;font-size:9px;color:#aaa;transform:translateX(-50%)}' +
    '.tcv-row{display:flex;align-items:center;height:26px}.tcv-track{position:relative;flex:1;height:20px;background:#fafafa;border-radius:3px;overflow:hidden}' +
    '.tcv-row.tcv-idle{opacity:.4}' +
    '.tcv-blk{position:absolute;top:1px;height:18px;line-height:18px;font-size:10px;border-radius:3px;border:0.5px solid;padding:0 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
    '.tcv-nowseg{position:absolute;top:-3px;bottom:-3px;width:0;border-left:1.5px solid #a32d2d;z-index:2}' +
    '.tg-tz{font-size:10px;color:#999;margin-bottom:4px}' +
    '.tg-axis{display:flex;border-bottom:0.5px solid #eee;margin-bottom:2px}' +
    '.tg-nc{flex:0 0 84px;width:84px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:6px}' +
    '.tg-cols{display:flex;flex:1}.tg-col{flex:1;text-align:center;font-size:10px;color:#888;line-height:1.15;border-left:0.5px solid #eee;padding:2px 0}.tg-col.tg-td{color:#1a1a1a;background:#eef6ff}' +
    '.tg-row{display:flex;align-items:center;height:26px}.tg-track{position:relative;flex:1;height:22px;background:#fafafa;border-radius:3px;overflow:hidden}' +
    '.tg-gl{position:absolute;top:0;bottom:0;border-left:0.5px solid #eee}' +
    '.tg-blk{position:absolute;top:2px;height:18px;line-height:18px;font-size:10px;border-radius:3px;border:0.5px solid;padding:0 5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.tg-blk.cov{border-width:1.5px;font-weight:500}' +
    '.tg-nowseg{position:absolute;top:-2px;bottom:-2px;width:0;border-left:1.5px solid #a32d2d;z-index:3}' +
    '.tg-gle{position:absolute;left:6px;top:4px;font-size:10px;color:#999}.tg-ghost .tg-nc{opacity:.55;text-decoration:line-through}' +
    '.sl-now{font-size:11px;color:#666;margin:2px 0 8px}.sl-now b{color:#1a1a1a;font-weight:500}' +
    '.sl-sec{margin-top:10px}.sl-sechd{font-size:11px;font-weight:600;color:#444;border-top:1px solid #eee;padding-top:7px;margin-bottom:3px}.sl-sechd .muted{font-weight:400}' +
    '.sl-row{display:flex;align-items:stretch;min-height:24px;border-top:0.5px solid #f1f1f1}' +
    '.sl-cells{display:flex;flex:1}' +
    '.sl-cell{flex:1;border-left:0.5px solid #eee;display:flex;flex-wrap:wrap;gap:2px;align-items:center;justify-content:center;padding:2px 1px;min-height:24px}.sl-cell.tg-td{background:#eef6ff}' +
    '.sl-chip{font-size:9px;font-weight:500;padding:1px 4px;border-radius:4px;border:0.5px solid;min-width:18px;text-align:center;cursor:default}' +
    '.pv-tag{background:#e1f5ee;color:#0f6e56;border:1px solid #1d9e75;border-radius:7px;padding:6px 10px;font-size:12px;font-weight:500;margin:0 0 9px}.pv-tag .muted{color:#0f6e56;opacity:.6;font-weight:400}' +
    '.sl-chip.pv-new,.tcv-blk.pv-new,.tg-blk.pv-new{outline:2px solid #1d9e75;outline-offset:0;z-index:4}' +
    '#tcpop{position:fixed;display:none;pointer-events:none;z-index:2147483647;max-width:250px;background:#1f2023;color:#fff;border-radius:8px;padding:8px 11px;font-size:11px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.32)}' +
    '#tcpop .pn{font-weight:600;font-size:12px;margin-bottom:2px}' +
    '#tcpop .pr{color:#b9bcc2}#tcpop .pr b{color:#fff;font-weight:500}' +
    '#tcpop .pslot{color:#8b8f97;margin:1px 0 4px}' +
    '.ed-rtrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 2px}#ed-rtnote{flex:1 1 100%;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.ed-danger{color:#a32d2d}.btn.ed-danger{border-color:#e3b4b4}' +
    '.ed-row{display:flex;align-items:center;gap:6px;border:1px solid #eee;border-radius:8px;padding:6px 8px;margin:5px 0;background:#fff}.ed-row.on{border-color:#1d9e75;background:#f3fbf8}' +
    '.ed-rowmain{flex:1;min-width:0;cursor:pointer}.ed-rowname{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ed-rowsub{font-size:11px;color:#888}' +
    '.ed-cov{font-size:9px;color:#993c1d;background:#faece7;border:0.5px solid #d85a30;border-radius:4px;padding:0 4px;vertical-align:1px}' +
    '.ed-rowbtns{display:flex;gap:2px;flex:0 0 auto}' +
    '.ed-ic{border:1px solid #ddd;background:#fff;border-radius:5px;width:24px;height:24px;font-size:12px;line-height:1;cursor:pointer;color:#555;padding:0}.ed-ic:hover{background:#f4f4f0}.ed-ic:disabled{opacity:.35;cursor:default}.ed-ic.ed-danger{color:#a32d2d}' +
    '.ed-form{border:1px solid #e3e3df;border-radius:10px;padding:10px 12px;margin:6px 0 2px;background:#fcfcfb}.ed-fhd{font-size:12px;font-weight:600;color:#444;margin-bottom:4px}' +
    '.ed-form input:not([type=checkbox]),.ed-form select{width:100%;padding:7px 9px;font-size:13px;border:1px solid #ccc;border-radius:7px;background:#fff;color:#1a1a1a}' +
    '.ed-step{display:flex;align-items:center;gap:5px;margin:4px 0}.ed-stepn{font-size:10px;color:#999;width:14px;text-align:right;flex:0 0 14px}.ed-chips{flex:1;display:flex;flex-wrap:wrap;gap:4px;min-width:0}' +
    '.ed-chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:500;padding:2px 4px 2px 7px;border:0.5px solid;border-radius:11px}.ed-x{border:none;background:none;cursor:pointer;font-size:12px;line-height:1;color:inherit;opacity:.6;padding:0 1px}.ed-x:hover{opacity:1}' +
    '.ed-addrow{display:flex;gap:6px;margin:6px 0}.ed-addrow select{flex:1}.ed-addrow .btn{flex:0 0 auto;white-space:nowrap}' +
    '.ed-days{display:flex;gap:3px;flex-wrap:wrap}.ed-day{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#666;border:1px solid #ddd;border-radius:6px;padding:3px 6px;cursor:pointer;margin:0}.ed-day.on{background:#eef6ff;border-color:#85b7eb;color:#0c447c}.ed-day input{width:auto;margin:0}' +
    '.ed-daypresets{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:5px 0 2px}.ed-preset{font-size:10px;color:#0c447c;background:#eef6ff;border:1px solid #cfe0f3;border-radius:5px;padding:2px 7px;cursor:pointer}.ed-preset:hover{background:#dcebfb}' +
    '.ed-fielderr{font-size:10px;color:#a32d2d;margin-left:4px}input.bad{border-color:#d85a30;background:#fef6f3}' +
    '.ed-inline{display:flex;align-items:center;gap:5px;color:#1a1a1a;margin:10px 0 3px}.ed-inline input{width:auto;margin:0}' +
    '.ed-warn{font-size:11px;color:#854f0b;background:#faeeda;border-radius:6px;padding:6px 8px;margin:7px 0 2px}' +
    '.ed-readout{font-size:12px;color:#0f6e56;background:#e1f5ee;border-radius:6px;padding:5px 8px;margin:7px 0}.ed-readout b{font-weight:500}' +
    '.btn.ed-rawlink{border:none;background:none;color:#888;text-decoration:underline;padding:4px 0;font-size:11px;margin-right:auto}.btn.ed-rawlink:hover{background:none;color:#555}' +
    '.ed-formacts{display:flex;justify-content:flex-end;margin-top:8px}.ed-baract{display:flex;gap:8px;margin-top:10px}' +
    '#structBar .ed-prev{background:#e1f5ee;border:1px solid #1d9e75;border-radius:8px;padding:8px 10px;margin:0 0 9px}#structBar .ed-prev b{color:#0f6e56}#structBar .ed-warn{margin-top:6px}' +
    // --- Coverage mode ---
    '.cov-gapbanner{border-radius:8px;padding:8px 11px;margin:4px 0 12px;font-size:12px}' +
    '.cov-gapbanner.ok{background:#e1f5ee;border:1px solid #1d9e75;color:#0f6e56}' +
    '.cov-gapbanner.warn{background:#faeeda;border:1px solid #ef9f27;color:#633806}.cov-gapbanner b{font-weight:600}' +
    '.cov-gapbanner ul{margin:5px 0 0;padding-left:18px}.cov-gapbanner li{margin:2px 0}' +
    '.cov-when{font-size:11px;color:#888;margin:0 0 6px}' +
    '.cov-lvl{display:flex;align-items:flex-start;gap:8px;padding:7px 2px;border-bottom:1px solid #eee}.cov-lvl:last-child{border-bottom:none}' +
    '.cov-lvl.first{background:#f7fbff;border-radius:7px;padding:8px;border-bottom:none;margin-bottom:2px}' +
    '.cov-lvl.gap{background:#fdf3f6}' +
    '.cov-lbl{flex:0 0 30px;font-weight:600;font-size:12px;color:#444;padding-top:3px}' +
    '.cov-mid{flex:1;min-width:0}' +
    '.cov-rt{font-size:11px;color:#777;margin-bottom:3px}.cov-rt .esc{margin-left:6px;color:#aaa}' +
    '.cov-on{display:flex;flex-wrap:wrap;gap:4px}' +
    '.cov-chip{font-size:11px;padding:3px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#1a1a1a;white-space:nowrap}' +
    '.cov-none{font-size:11px;color:#b23b5e;font-weight:600}' +
    '.cov-levelpick{margin:2px 0 8px}.cov-levelpick .chip{padding:3px 9px}.chip.on{background:#1a1a1a;border-color:#1a1a1a;color:#fff}' +
    '#covtl{margin-top:4px}#covtl .tg-row .tg-nc{font-size:10px}' +
    '#covtl .tg-grp{font-size:10px;font-weight:600;color:#0c447c;background:#eef4fb;padding:3px 7px;margin:5px 0 1px;border-radius:5px}';

  // Coverage body (hidden until Coverage mode). Picks an escalation POLICY (the unit that's actually paged) and
  // resolves its full ladder — every level, unioning all routines on it (so a weekend routine appears at L2/L3
  // only on weekends). Shows the ladder AT a chosen instant + first-responder (L1) coverage gaps over the range.
  var COVBODY =
    '<div id="covbody" data-css="display:none">' +
    '<label for="covpolicy">Escalation policy</label><select id="covpolicy"></select>' +
    '<div class="presets"><button class="chip" type="button" data-cpreset="now">now</button><button class="chip" type="button" data-cpreset="today">today</button><button class="chip" type="button" data-cpreset="thisweek">this week</button><button class="chip" type="button" data-cpreset="nextweek">next week</button><button class="chip" type="button" data-cpreset="2weeks">2 weeks</button></div>' +
    '<div class="row" id="covdaterow"><div><label for="covfrom">From</label><input id="covfrom" type="date"></div><div><label for="covto">To</label><input id="covto" type="date"></div></div>' +
    '<div class="sechead"><div class="tcv-seg" id="covviewseg"><button type="button" data-covview="ladder" class="on">Ladder</button><button type="button" data-covview="timeline">Timeline</button></div>' +
    '<div id="covtimewrap" data-css="margin-left:auto"><label for="covtime" data-css="display:inline;margin:0 6px 0 0;font-size:11px;color:#666">at time</label><input id="covtime" type="time" data-css="width:auto;display:inline-block"></div></div>' +
    '<div id="covlevels"></div>' +
    '<div id="covout"></div>' +
    '</div>';

  // Editor body (hidden until Edit mode). The rotation list, form, and bottom bar are rendered dynamically.
  var EDITBODY =
    '<div id="editbody" data-css="display:none">' +
    '<div class="ed-rtrow"><span class="muted" id="ed-rtnote"></span>' +
      '<button class="btn sm" type="button" id="ed-new">+ New routine</button>' +
      '<button class="btn sm" type="button" id="ed-rename">Rename</button>' +
      '<button class="btn sm" type="button" id="ed-export" title="Download this routine as a JSON backup">Export</button>' +
      '<button class="btn sm" type="button" id="ed-import" title="Create a new routine from a JSON export">Import</button>' +
      '<button class="btn sm ed-danger" type="button" id="ed-del">Delete routine</button>' +
    '</div>' +
    '<div class="sec"><div class="sechead"><h4>Rotations</h4><button class="btn sm" type="button" id="ed-add" data-css="margin-left:auto">+ Add rotation</button></div><div id="editlist"></div></div>' +
    '<div id="editform"></div>' +
    '<div id="ed-bar"></div>' +
    '</div>';

  var SHELL =
    '<button id="launch" type="button">On-call toolkit</button>' +
    '<div id="panel">' +
    '<div class="hd"><b>On-call</b><div class="tcv-seg" id="modeseg" data-css="margin-left:auto"><button type="button" data-mode="view" class="on">View</button><button type="button" data-mode="edit">Edit</button><button type="button" data-mode="coverage">Coverage</button></div><button id="expand" type="button" aria-label="expand" title="Expand / full screen">⤢</button><button id="close" type="button" aria-label="close">×</button></div>' +
    '<div class="body">' +
    '<div id="banner" class="banner" role="status"></div>' +
    '<div id="routinerow"><label for="routine">Routine</label><select id="routine"></select></div>' +
    '<div id="viewbody">' +
    '<div id="structBar" data-css="display:none"></div>' +
    '<div class="presets"><button class="chip" type="button" data-preset="today">today</button><button class="chip" type="button" data-preset="tomorrow">tomorrow</button><button class="chip" type="button" data-preset="thisweek">this week</button><button class="chip" type="button" data-preset="nextweek">next week</button><button class="chip" type="button" data-preset="2weeks">2 weeks</button></div>' +
    '<div class="row" id="daterow"><div><label for="from">From</label><input id="from" type="date"></div><div><label for="to">To</label><input id="to" type="date"></div></div>' +
    '<div class="sec"><div class="sechead"><h4>Schedule</h4><div class="tcv-seg" data-css="margin-left:auto"><button type="button" data-sview="slot" class="on">Slots</button><button type="button" data-sview="person">People</button><button type="button" data-sview="day">Overlap</button></div></div><div id="sched"></div></div>' +
    '<div class="sec" id="swapSec"><h4>Schedule override</h4><div class="muted" data-css="margin:0 0 6px">Someone out for a few dates? Apply a temporary, dated override on this routine: swap one person for a stand-in (the rest stay on), or set who covers. It previews first and expires on its own; the routine isn\'t changed.</div>' +
    '<div class="tcv-seg" data-css="margin:2px 0 6px"><button type="button" data-target="slot" class="on">By shift</button><button type="button" data-target="person">By person</button><button type="button" data-target="set">Set coverage</button></div>' +
    '<div id="slotrow"><label for="slotsel">Shift / slot</label><select id="slotsel"></select></div>' +
    '<div id="outrow" data-css="display:none"><label for="out">Person</label><select id="out"></select></div>' +
    '<div class="row" id="swaprow"><div><label for="swapfrom">Override from</label><input id="swapfrom" type="date"></div><div><label for="swapto">Override to</label><input id="swapto" type="date"></div></div>' +
    '<div class="muted" data-css="margin:3px 0 0">Dates the override applies to — independent of the view range above.</div>' +
    '<div id="setrow" data-css="display:none">' +
      '<label>On-call for this window <span class="muted">· the full roster (time off / coverage)</span></label>' +
      '<div id="set-chips" class="ed-chips" data-css="margin:2px 0 4px"></div>' +
      '<div class="ed-addrow"><select id="set-add"></select><button class="btn sm" type="button" id="set-addbtn">+ add</button></div>' +
      '<div data-css="margin:2px 0 4px"><button class="btn sm" type="button" id="set-extend" title="Keep someone on past their normal shift end (shift extension)">⤢ extend a shift...</button></div>' +
      '<label class="ed-inline"><input type="checkbox" id="set-timeoff" data-css="width:auto;margin:0"> Time off — no one on-call (intentional gap)</label>' +
      '<label class="ed-inline"><input type="checkbox" id="set-partial" data-css="width:auto;margin:0"> Specific hours (default: whole day)</label>' +
      '<div class="row" id="set-hours" data-css="display:none"><div><label for="set-start">Starts</label><input type="time" id="set-start" value="00:00"></div><div><label for="set-len">Length (HH:MM, ≤ 24:00)</label><input type="text" id="set-len" value="24:00" placeholder="24:00"></div></div>' +
    '</div>' +
    '<div id="inrow"><label for="in">Replace with</label><select id="in"></select></div>' +
    '<div class="cov" id="covrow" data-css="display:none"><input type="checkbox" id="covermode" data-css="width:auto;margin:0"><label for="covermode" data-css="margin:0;color:#1a1a1a">Cover until removed (indefinite)</label></div>' +
    '<div id="covernote" data-css="display:none;font-size:11px;color:#854f0b;margin-top:4px">Indefinite base substitution — replaces them on every shift until you uncover. For a bounded window, leave unchecked.</div>' +
    '<div data-css="margin-top:10px"><button class="btn pri" type="button" id="primary">preview (dry-run)</button></div>' +
    '<div id="previewBox"></div></div>' +
    '<div class="sec" id="activeSec"><h4>Active overrides &amp; covers</h4><div id="ovr"></div></div>' +
    '</div>' +
    COVBODY +
    EDITBODY +
    '</div>' +
    '<div class="ft"><span id="eng"></span><span>On-Call Toolkit</span></div>' +
    '</div>' +
    '<div id="tcpop" role="tooltip"></div>';

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  // A SPA re-render can remove our host; re-mount it. Drop any pending swap/structural preview first — its Apply/Discard
  // buttons lived in the destroyed DOM and aren't rebuilt on remount, so a surviving preview would strand with no control.
  var keep = setInterval(function () { if (!document.getElementById('tc-toolkit-host')) { state.previewData = null; state.structPreview = false; state.structLayers = null; mount(); if (state.open) open(); } }, 2000);
  window.addEventListener('beforeunload', function () { clearInterval(keep); });
})();
