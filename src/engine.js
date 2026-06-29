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
