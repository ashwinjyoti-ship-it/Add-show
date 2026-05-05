import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB_SOUND: D1Database
  DB_CREW: D1Database
}

// Crew roster — mirrors ncpa-sound-manager's VALID_CREW_MEMBERS
const VALID_CREW = [
  'Naren', 'Sandeep', 'Coni', 'Nikhil', 'NS', 'Aditya',
  'Viraj', 'Shridhar', 'Nazar', 'Omkar', 'Akshay',
  'OC1', 'OC2', 'OC3'
]

const VENUES = ['JBT', 'TET', 'GDT', 'LT', 'TT', 'SVR', 'DP Art Gallery']

const TEAMS = [
  'Bruce/Team', 'Dr.Rao/Team', 'Dr.Swapno/Team', 'Farrahnaz/Team',
  'Bianca/Team', 'Dr.Sujata/Team', 'Nooshin/Team', 'DPAG', 'DP', 'Others'
]

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors())

// ─── SVG icon served from worker (for PWA) ───────────────────────────────────
app.get('/icon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#98A2D7"/>
      <stop offset="100%" stop-color="#3D4675"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="40" fill="url(#g)"/>
  <text x="96" y="140" font-family="-apple-system,sans-serif" font-size="110"
        font-weight="700" text-anchor="middle" fill="white">+</text>
</svg>`
  )
})

// ─── GET /api/crew-availability?dates=YYYY-MM-DD,YYYY-MM-DD ──────────────────
app.get('/api/crew-availability', async (c) => {
  const datesParam = c.req.query('dates')
  if (!datesParam) return c.json({ success: false, error: 'dates param required' }, 400)

  const dates = datesParam.split(',').map(d => d.trim()).filter(Boolean)
  if (!dates.length) return c.json({ success: false, error: 'no valid dates' }, 400)

  const ph = dates.map(() => '?').join(',')

  try {
    // 1. Crew already assigned in ncpa-sound-manager on these dates
    const soundRows = await c.env.DB_SOUND.prepare(
      `SELECT crew, foh_crew, stage_crew, program, venue, event_date
       FROM events WHERE event_date IN (${ph})`
    ).bind(...dates).all()

    const assignedSet = new Set<string>()
    const parseCSV = (s: string | null) => {
      if (!s) return
      s.split(',').map(m => m.trim()).filter(Boolean).forEach(m => assignedSet.add(m))
    }
    for (const row of soundRows.results as any[]) {
      parseCSV(row.crew)
      parseCSV(row.foh_crew)
      parseCSV(row.stage_crew)
    }

    // 2. Crew blocked in crew-assignment-automation on these dates
    const crewRows = await c.env.DB_CREW.prepare(
      `SELECT DISTINCT c.name
       FROM crew_unavailability cu
       JOIN crew c ON c.id = cu.crew_id
       WHERE cu.unavailable_date IN (${ph})`
    ).bind(...dates).all()

    const unavailSet = new Set<string>(crewRows.results.map((r: any) => r.name as string))

    // 3. Categorise against the known crew roster
    const available   = VALID_CREW.filter(m => !assignedSet.has(m) && !unavailSet.has(m))
    const assigned    = VALID_CREW.filter(m => assignedSet.has(m))
    const unavailable = VALID_CREW.filter(m => unavailSet.has(m) && !assignedSet.has(m))

    return c.json({
      success: true, available, assigned, unavailable,
      conflicts: soundRows.results, dates
    })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ─── POST /api/events ─────────────────────────────────────────────────────────
app.post('/api/events', async (c) => {
  try {
    const body = await c.req.json()
    const {
      date_type, event_date, start_date, end_date,
      program, venue, team, sound_requirements, call_time,
      foh_crew, stage_crew
    } = body

    if (!program?.trim() || !venue?.trim())
      return c.json({ success: false, error: 'Program and venue are required' }, 400)

    const stageCrew = Array.isArray(stage_crew)
      ? stage_crew.filter(Boolean).join(', ')
      : (stage_crew || '')
    const allCrew = [foh_crew, stageCrew].filter(Boolean).join(', ')

    // Build date list — one event per calendar day
    const dates: string[] = []
    if (date_type === 'range' && start_date && end_date) {
      const s = new Date(start_date + 'T00:00:00Z')
      const e = new Date(end_date + 'T00:00:00Z')
      for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1))
        dates.push(d.toISOString().split('T')[0])
    } else if (event_date) {
      dates.push(event_date)
    } else {
      return c.json({ success: false, error: 'Date is required' }, 400)
    }

    if (!dates.length) return c.json({ success: false, error: 'No valid dates produced' }, 400)

    const insertedIds: number[] = []
    for (const date of dates) {
      const result = await c.env.DB_SOUND.prepare(`
        INSERT INTO events
          (event_date, program, venue, team, sound_requirements, call_time,
           crew, foh_crew, stage_crew, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        date, program.trim(), venue.trim(), team || null,
        sound_requirements || null, call_time || null,
        allCrew || null, foh_crew || null, stageCrew || null
      ).run()
      if (result.meta.last_row_id) insertedIds.push(result.meta.last_row_id as number)
    }

    return c.json({ success: true, ids: insertedIds, count: insertedIds.length })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ─── Main HTML page ───────────────────────────────────────────────────────────
app.get('/', (c) => {
  const venueOpts = VENUES.map(v => `<option value="${v}">${v}</option>`).join('\n')
  const teamOpts  = TEAMS.map(t => `<option value="${t}">${t}</option>`).join('\n')
  return c.html(buildPage(venueOpts, teamOpts))
})

function buildPage(venueOpts: string, teamOpts: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#6B77C0">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Add Show">
  <link rel="apple-touch-icon" href="/icon.svg">
  <link rel="manifest" href="/manifest.json">
  <title>Add Show — NCPA</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

    :root{
      --primary:#6B77C0;
      --primary-dark:#3D4675;
      --primary-light:#98A2D7;
      --accent:#A8C3A0;
      --accent-dark:#6E9966;
      --bg:#eef0f8;
      --surface:rgba(255,255,255,0.88);
      --border:rgba(107,119,192,0.18);
      --text:#1e2545;
      --muted:#7280a8;
      --danger:#c04040;
      --warn-bg:rgba(192,100,60,0.07);
      --warn-border:rgba(192,100,60,0.20);
      --warn-text:#8b3b1a;
      --radius:18px;
      --radius-sm:12px;
      --shadow:0 2px 18px rgba(60,70,128,0.10);
      --safe-top:env(safe-area-inset-top,0px);
      --safe-bottom:env(safe-area-inset-bottom,0px);
    }

    html{height:100%;-webkit-text-size-adjust:100%}

    body{
      min-height:100%;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
      background:linear-gradient(155deg,#e8eaf6 0%,#eef4eb 55%,#e8eaf6 100%);
      color:var(--text);
      padding-bottom:calc(32px + var(--safe-bottom));
    }

    /* App bar */
    .app-bar{
      position:sticky;top:0;z-index:50;
      background:linear-gradient(135deg,var(--primary) 0%,var(--primary-dark) 100%);
      padding:calc(14px + var(--safe-top)) 20px 16px;
      color:#fff;box-shadow:0 2px 20px rgba(60,70,128,0.28);text-align:center;
    }
    .app-bar h1{font-size:20px;font-weight:700;letter-spacing:-.2px}
    .app-bar p{font-size:12px;opacity:.75;margin-top:2px}

    .page{max-width:600px;margin:0 auto;padding:18px 16px 0}

    /* Card */
    .card{
      background:var(--surface);
      backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border:1px solid var(--border);border-radius:var(--radius);
      box-shadow:var(--shadow);padding:20px;margin-bottom:14px;
    }
    .card-hdr{display:flex;align-items:center;gap:10px;margin-bottom:18px}
    .card-icon{
      width:32px;height:32px;border-radius:10px;flex-shrink:0;
      background:linear-gradient(135deg,var(--primary-light),var(--primary));
      display:flex;align-items:center;justify-content:center;font-size:15px;
    }
    .card-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--primary-dark)}

    /* Fields */
    .field{margin-bottom:13px}
    .field:last-child{margin-bottom:0}
    .lbl{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:5px}
    .lbl .r{color:var(--danger)}

    .inp,select,textarea{
      display:block;width:100%;padding:11px 13px;
      background:rgba(255,255,255,.70);border:1.5px solid var(--border);
      border-radius:var(--radius-sm);font-size:15px;color:var(--text);
      outline:none;transition:border-color .2s,box-shadow .2s,background .2s;
      -webkit-appearance:none;appearance:none;font-family:inherit;
    }
    .inp:focus,select:focus,textarea:focus{
      border-color:var(--primary-light);
      box-shadow:0 0 0 3px rgba(152,162,215,.22);
      background:#fff;
    }
    textarea{resize:vertical;min-height:72px;line-height:1.5}
    select{
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%237280a8' d='M8 11L2 5h12z'/%3E%3C/svg%3E");
      background-repeat:no-repeat;background-position:right 11px center;
      background-size:14px;padding-right:34px;
    }

    /* Segmented control */
    .seg{display:flex;background:rgba(107,119,192,.10);border-radius:var(--radius-sm);padding:3px;gap:3px;margin-bottom:14px}
    .seg-btn{
      flex:1;padding:9px 8px;text-align:center;border-radius:9px;cursor:pointer;
      font-size:13px;font-weight:600;color:var(--muted);transition:all .2s;
      user-select:none;border:none;background:transparent;font-family:inherit;
    }
    .seg-btn.on{background:#fff;color:var(--primary-dark);box-shadow:0 1px 8px rgba(60,70,128,.12)}

    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px}

    /* Loading */
    .loading{display:flex;align-items:center;gap:10px;padding:8px 0;color:var(--muted);font-size:14px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .65s linear infinite;flex-shrink:0}

    /* Conflict box */
    .cbox{background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:var(--radius-sm);padding:10px 13px;margin-bottom:14px;font-size:12.5px;color:var(--warn-text);line-height:1.5}
    .cbox strong{font-weight:700;display:block;margin-bottom:4px}
    .citem{padding-left:12px;margin-top:3px}

    /* Role headers */
    .role-hdr{display:flex;align-items:center;gap:8px;margin-bottom:9px;margin-top:4px}
    .role-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--primary-dark)}
    .role-badge{font-size:10.5px;padding:2px 8px;border-radius:20px;font-weight:600}
    .badge-foh{background:rgba(107,119,192,.13);color:var(--primary-dark)}
    .badge-stage{background:rgba(168,195,160,.25);color:var(--accent-dark)}
    .role-hint{font-size:11.5px;color:var(--muted);margin-bottom:9px}

    /* Crew pills */
    .pill-grid{display:flex;flex-wrap:wrap;gap:7px}
    .cpill{position:relative}
    .cpill input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
    .cpill label{
      display:inline-flex;align-items:center;padding:7px 13px;border-radius:24px;
      border:1.5px solid var(--border);background:rgba(255,255,255,.75);
      cursor:pointer;font-size:13px;font-weight:500;color:var(--text);
      transition:all .14s;user-select:none;line-height:1;
    }
    .cpill label:hover{border-color:var(--primary-light);background:rgba(152,162,215,.12)}
    .foh-pill input:checked+label{background:var(--primary);border-color:var(--primary-dark);color:#fff;box-shadow:0 3px 10px rgba(107,119,192,.35)}
    .stage-pill input:checked+label{background:var(--accent);border-color:var(--accent-dark);color:#253a1f;box-shadow:0 3px 10px rgba(110,153,102,.30)}
    .none-pill label{color:var(--muted);font-style:italic}
    .none-pill input:checked+label{background:rgba(160,160,170,.12);border-color:rgba(160,160,170,.35);color:var(--muted);box-shadow:none}

    .divider{height:1px;background:var(--border);margin:16px 0}

    /* Excluded crew */
    .excl-hdr{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px}
    .excl-grid{display:flex;flex-wrap:wrap;gap:6px}
    .etag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}
    .etag-a{background:rgba(192,80,60,.08);color:#8b3020;border:1px solid rgba(192,80,60,.15)}
    .etag-b{background:rgba(140,140,155,.10);color:#777;border:1px solid rgba(140,140,155,.20)}

    .no-crew{text-align:center;padding:20px 0 8px;color:var(--muted);font-size:14px}

    /* Submit */
    .btn-submit{
      width:100%;padding:16px;
      background:linear-gradient(135deg,var(--primary-light) 0%,var(--primary-dark) 100%);
      border:none;border-radius:var(--radius-sm);color:#fff;
      font-size:16px;font-weight:700;letter-spacing:.2px;cursor:pointer;
      box-shadow:0 4px 18px rgba(60,70,128,.28);transition:opacity .2s,transform .12s;
      font-family:inherit;margin-top:4px;
    }
    .btn-submit:active{transform:scale(.985);opacity:.9}
    .btn-submit:disabled{opacity:.45;cursor:not-allowed;transform:none}

    /* Success */
    .sw{text-align:center;padding:12px 4px}
    .sring{
      width:68px;height:68px;border-radius:50%;
      background:linear-gradient(135deg,var(--accent),var(--accent-dark));
      display:flex;align-items:center;justify-content:center;
      font-size:30px;margin:0 auto 16px;
      box-shadow:0 4px 22px rgba(110,153,102,.35);
    }
    .stitle{font-size:22px;font-weight:700;margin-bottom:6px}
    .ssub{font-size:14px;color:var(--muted);margin-bottom:20px}
    .sdl{text-align:left;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;margin-bottom:20px}
    .srow{display:flex;padding:9px 14px;font-size:13px;border-bottom:1px solid var(--border);gap:10px}
    .srow:last-child{border-bottom:none}
    .srow dt{width:90px;flex-shrink:0;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding-top:1px}
    .srow dd{font-weight:500;flex:1;word-break:break-word}
    .btn-reset{padding:12px 28px;background:var(--surface);border:1.5px solid var(--primary-light);border-radius:var(--radius-sm);color:var(--primary-dark);font-size:15px;font-weight:600;cursor:pointer;transition:background .18s;font-family:inherit}
    .btn-reset:hover{background:rgba(152,162,215,.12)}

    [hidden]{display:none!important}
    .mt{margin-top:12px}
    @media(max-width:380px){.page{padding:12px 12px 0}.card{padding:16px}}
  </style>
</head>
<body>

<header class="app-bar">
  <h1>Add Show</h1>
  <p>NCPA Sound Manager</p>
</header>

<div class="page">

  <!-- FORM -->
  <div id="form-view">

    <div class="card">
      <div class="card-hdr">
        <div class="card-icon">\u{1F4C5}</div>
        <div class="card-title">Show Details</div>
      </div>

      <div class="seg" role="group">
        <button class="seg-btn on" id="btn-single" onclick="setDateType('single')">Single Date</button>
        <button class="seg-btn"    id="btn-range"  onclick="setDateType('range')">Date Range</button>
      </div>

      <div class="field" id="f-single">
        <label class="lbl" for="event_date">Date <span class="r">*</span></label>
        <input class="inp" type="date" id="event_date">
      </div>

      <div id="f-range" hidden>
        <div class="two-col">
          <div class="field">
            <label class="lbl" for="start_date">From <span class="r">*</span></label>
            <input class="inp" type="date" id="start_date">
          </div>
          <div class="field">
            <label class="lbl" for="end_date">To <span class="r">*</span></label>
            <input class="inp" type="date" id="end_date">
          </div>
        </div>
      </div>

      <div class="field mt">
        <label class="lbl" for="program">Program Name <span class="r">*</span></label>
        <input class="inp" type="text" id="program" placeholder="e.g. Beethoven Symphony No. 9" autocomplete="off">
      </div>

      <div class="field">
        <label class="lbl" for="venue">Venue <span class="r">*</span></label>
        <select id="venue">
          <option value="">Select venue…</option>
          ${venueOpts}
        </select>
      </div>

      <div class="field">
        <label class="lbl" for="team">Team / Director</label>
        <select id="team">
          <option value="">Select team…</option>
          ${teamOpts}
        </select>
      </div>

      <div class="field">
        <label class="lbl" for="call_time">Call Time</label>
        <input class="inp" type="text" id="call_time" placeholder="e.g. 5:30pm">
      </div>

      <div class="field">
        <label class="lbl" for="sound_req">Sound Requirements</label>
        <textarea class="inp" id="sound_req" placeholder="e.g. Full PA rig, piano mic, 2× wireless…"></textarea>
      </div>
    </div>

    <!-- Crew card (shown after dates are picked) -->
    <div class="card" id="avail-card" hidden>
      <div class="card-hdr">
        <div class="card-icon">\u{1F465}</div>
        <div class="card-title">Crew Assignment</div>
      </div>
      <div id="avail-body">
        <div class="loading"><div class="spinner"></div>Checking availability…</div>
      </div>
    </div>

    <button class="btn-submit" id="submit-btn" onclick="submitShow()">Add Show &amp; Assign Crew</button>
  </div>

  <!-- SUCCESS -->
  <div id="success-view" hidden>
    <div class="card sw">
      <div class="sring">✓</div>
      <div class="stitle">Show Added!</div>
      <div class="ssub" id="s-sub"></div>
      <dl class="sdl" id="s-dl"></dl>
      <button class="btn-reset" onclick="resetForm()">Add Another Show</button>
    </div>
  </div>

</div>

<script>
'use strict'
var _dt='single',_avail=null,_timer=null

function setDateType(t){
  _dt=t
  var s=t==='single'
  document.getElementById('btn-single').className='seg-btn'+(s?' on':'')
  document.getElementById('btn-range').className='seg-btn'+(s?'':' on')
  document.getElementById('f-single').hidden=!s
  document.getElementById('f-range').hidden=s
  sched()
}

;['event_date','start_date','end_date'].forEach(function(id){
  document.getElementById(id).addEventListener('change',sched)
})

function sched(){clearTimeout(_timer);_timer=setTimeout(doCheck,280)}

function getDates(){
  if(_dt==='single'){var v=document.getElementById('event_date').value;return v?[v]:[]}
  var s=document.getElementById('start_date').value
  var e=document.getElementById('end_date').value
  if(!s||!e)return[]
  var out=[],cur=new Date(s+'T00:00:00Z'),end=new Date(e+'T00:00:00Z')
  while(cur<=end){out.push(cur.toISOString().slice(0,10));cur.setUTCDate(cur.getUTCDate()+1)}
  return out
}

async function doCheck(){
  var dates=getDates()
  var card=document.getElementById('avail-card')
  if(!dates.length){card.hidden=true;return}
  card.hidden=false
  document.getElementById('avail-body').innerHTML='<div class="loading"><div class="spinner"></div>Checking '+dates.length+' date'+(dates.length>1?'s':'')+'…</div>'
  try{
    var r=await fetch('/api/crew-availability?dates='+dates.join(','))
    var d=await r.json()
    if(!d.success)throw new Error(d.error)
    _avail=d;renderAvail(d)
  }catch(e){
    document.getElementById('avail-body').innerHTML='<div style="color:var(--danger);font-size:13px;padding:4px 0">⚠ '+esc(e.message)+'</div>'
  }
}

function renderAvail(d){
  var h=''
  if(d.conflicts&&d.conflicts.length){
    h+='<div class="cbox"><strong>⚠ Existing shows on '+(d.dates.length>1?'these dates':'this date')+':</strong>'
    d.conflicts.forEach(function(c){
      var crew=[c.foh_crew,c.stage_crew,c.crew].filter(Boolean).join(', ')||'no crew yet'
      h+='<div class="citem">• '+esc(c.event_date)+': <strong>'+esc(c.program)+'</strong> @ '+esc(c.venue)+' ('+esc(crew)+')</div>'
    })
    h+='</div>'
  }
  if(!d.available.length){
    h+='<div class="no-crew">😔 No crew available for the selected date(s).</div>'
  }else{
    h+='<div class="role-hdr"><span class="role-label">FOH Engineer</span><span class="role-badge badge-foh">Single select</span></div>'
    h+='<p class="role-hint">Select one crew member as Front-of-House engineer.</p>'
    h+='<div class="pill-grid">'
    d.available.forEach(function(name){
      var id='foh_'+sid(name)
      h+='<div class="cpill foh-pill"><input type="radio" name="foh_crew" id="'+id+'" value="'+esc(name)+'" onchange="onFoh(this)"><label for="'+id+'">'+esc(name)+'</label></div>'
    })
    h+='<div class="cpill foh-pill none-pill"><input type="radio" name="foh_crew" id="foh_none" value="" checked><label for="foh_none">None / TBD</label></div>'
    h+='</div>'
    h+='<div class="divider"></div>'
    h+='<div class="role-hdr"><span class="role-label">Stage Crew</span><span class="role-badge badge-stage">Multi select</span></div>'
    h+='<p class="role-hint">Select one or more stage crew members.</p>'
    h+='<div class="pill-grid">'
    d.available.forEach(function(name){
      var id='stage_'+sid(name)
      h+='<div class="cpill stage-pill"><input type="checkbox" name="stage_crew" id="'+id+'" value="'+esc(name)+'" onchange="onStage(this)"><label for="'+id+'">'+esc(name)+'</label></div>'
    })
    h+='</div>'
  }
  if(d.assigned.length||d.unavailable.length){
    h+='<div class="divider"></div>'
    h+='<div class="excl-hdr">Excluded from selection</div>'
    h+='<div class="excl-grid">'
    d.assigned.forEach(function(n){h+='<span class="etag etag-a">🔒 '+esc(n)+' (assigned)</span>'})
    d.unavailable.forEach(function(n){h+='<span class="etag etag-b">⛔ '+esc(n)+' (blocked)</span>'})
    h+='</div>'
  }
  document.getElementById('avail-body').innerHTML=h
}

function onFoh(radio){
  if(!radio.value)return
  var cb=document.getElementById('stage_'+sid(radio.value))
  if(cb)cb.checked=false
}
function onStage(cb){
  if(!cb.checked)return
  var radio=document.querySelector('input[name="foh_crew"]:checked')
  if(radio&&radio.value===cb.value){var none=document.getElementById('foh_none');if(none)none.checked=true}
}

async function submitShow(){
  var dates=getDates()
  var program=document.getElementById('program').value.trim()
  var venue=document.getElementById('venue').value
  if(!dates.length){alert('Please select a date.');return}
  if(!program){alert('Please enter the program name.');return}
  if(!venue){alert('Please select a venue.');return}
  var fohEl=document.querySelector('input[name="foh_crew"]:checked')
  var foh=fohEl?fohEl.value:''
  var stage=Array.from(document.querySelectorAll('input[name="stage_crew"]:checked')).map(function(i){return i.value}).filter(Boolean)
  var btn=document.getElementById('submit-btn')
  btn.disabled=true;btn.textContent='Saving…'
  var body={
    date_type:_dt,
    event_date:_dt==='single'?document.getElementById('event_date').value:null,
    start_date:_dt==='range'?document.getElementById('start_date').value:null,
    end_date:_dt==='range'?document.getElementById('end_date').value:null,
    program:program,venue:venue,
    team:document.getElementById('team').value,
    call_time:document.getElementById('call_time').value,
    sound_requirements:document.getElementById('sound_req').value,
    foh_crew:foh,stage_crew:stage
  }
  try{
    var r=await fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    var data=await r.json()
    if(!data.success)throw new Error(data.error)
    showSuccess(body,data,dates)
  }catch(e){
    alert('Error: '+e.message)
    btn.disabled=false;btn.textContent='Add Show & Assign Crew'
  }
}

function showSuccess(body,data,dates){
  document.getElementById('form-view').hidden=true
  document.getElementById('success-view').hidden=false
  document.getElementById('s-sub').textContent=data.count+' event'+(data.count!==1?'s':'')+' added to NCPA Sound Manager.'
  document.getElementById('s-dl').innerHTML=
    row('Program',body.program)+
    row('Venue',body.venue)+
    row('Date(s)',dates.join(', '))+
    (body.call_time?row('Call Time',body.call_time):'')+
    row('FOH Eng.',body.foh_crew||'—')+
    row('Stage',body.stage_crew.join(', ')||'—')
}
function row(k,v){return '<div class="srow"><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>'}

function resetForm(){
  document.getElementById('form-view').hidden=false
  document.getElementById('success-view').hidden=true
  ;['program','call_time','sound_req'].forEach(function(id){document.getElementById(id).value=''})
  ;['venue','team'].forEach(function(id){document.getElementById(id).selectedIndex=0})
  ;['event_date','start_date','end_date'].forEach(function(id){document.getElementById(id).value=''})
  setDateType('single')
  document.getElementById('avail-card').hidden=true
  _avail=null
  var btn=document.getElementById('submit-btn')
  btn.disabled=false;btn.textContent='Add Show & Assign Crew'
}

function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function sid(s){return String(s).replace(/[^a-zA-Z0-9]/g,'_')}

if('serviceWorker' in navigator){
  window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})
}
<\/script>
</body>
</html>`
}

export default app
