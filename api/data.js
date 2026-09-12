/**
 * api/data.js — Vercel Serverless Function
 *
 * Ersetzt sync.js + GitHub Actions: läuft nicht mehr nach einem festen
 * Zeitplan, sondern bei jedem Seitenaufruf — mit kurzer Zwischenspeicherung
 * (Cache-Control-Header unten), damit nicht jeder einzelne Besuch eine neue
 * Anfrage an die echten Datenquellen auslöst. In der Praxis heißt das: die
 * Daten sind nie älter als ~90 Sekunden, egal wann jemand die App öffnet.
 *
 * Spielplan + Ergebnisse : OpenLigaDB   (kostenlos, ohne Schlüssel)
 * Quoten                 : The Odds API (Schlüssel als Vercel-Umgebungsvariable
 *                           ODDS_API_KEY — landet NIE im Browser, nur hier
 *                           auf dem Server)
 * UFC-Ergebnisse         : ESPN Scoreboard (kostenlos, ohne Schlüssel)
 *
 * WICHTIGER UNTERSCHIED zu sync.js: Serverless-Funktionen haben keine eigene
 * Festplatte, die zwischen Aufrufen erhalten bleibt — "die letzte data.json
 * lesen, um alte Kämpfe zu übernehmen" geht hier nicht mehr. Stattdessen wird
 * ESPN für ein deutlich breiteres Zeitfenster abgefragt (21 Tage zurück statt
 * 3), sodass sich die Historie bei jedem Aufruf von selbst wieder zusammensetzt
 * — kein gespeicherter Zustand nötig, und damit auch keine Möglichkeit, dass
 * dieser Zustand jemals veraltet oder falsch wird.
 */

const KEY = process.env.ODDS_API_KEY;
const SEASON = process.env.SEASON || '2026';

/**
 * ESPN-Anbindung — direkt in dieser Datei statt als Import, damit kein
 * externes Modul beim Start fehlen kann (das hat auf Vercel eine Weile lang
 * die ganze Funktion mit FUNCTION_INVOCATION_FAILED zum Absturz gebracht)
 *
 * WARUM ESPN UND NICHT OpenLigaDB:
 * Für die Bundesligen ist OpenLigaDB zuverlässig — dort seit Jahren gepflegt.
 * Für die Champions League ist sie es NICHT: der Eintrag für 2026/27 enthält
 * nur ein Platzhalter-Gerüst (alle Spiele mit identischem Anstoß, identischen
 * Quoten, falsche Paarungen wie "RB Leipzig gegen Real Madrid UND Manchester
 * City am selben Tag"). ESPN liefert dagegen die echte Auslosung, dazu
 * Live-Zwischenstände MIT Spielminute und sogar Quoten — kostenlos und ohne
 * Schlüssel. Damit kostet die Champions League auch kein Odds-API-Guthaben.
 *
 * */

/* Amerikanische Quoten (-150 / +350) in dezimale umrechnen (1,67 / 4,50). */
function americanToDecimal(v){
  const n = Number(String(v).replace('+',''));
  if(!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? n/100 + 1 : 100/Math.abs(n) + 1;
}

/* YYYYMMDD in UTC — das Format, das ESPN im dates-Parameter erwartet. */
const espnDay = ts => {
  const d = new Date(ts);
  return d.getUTCFullYear()
    + String(d.getUTCMonth()+1).padStart(2,'0')
    + String(d.getUTCDate()).padStart(2,'0');
};

/* Ein einzelnes ESPN-Spiel in unser Format übersetzen.
   ESPN kennt drei Zustände: "pre" (noch nicht angepfiffen), "in" (läuft
   gerade) und "post" (abgepfiffen). Daraus ergibt sich direkt, ob wir ein
   endgültiges Ergebnis oder einen vorläufigen Zwischenstand vor uns haben. */
function parseEvent(ev){
  const comp = ev.competitions?.[0];
  if(!comp) return null;
  const cs = comp.competitors || [];
  const home = cs.find(c => c.homeAway === 'home');
  const away = cs.find(c => c.homeAway === 'away');
  if(!home?.team?.displayName || !away?.team?.displayName) return null;

  const state = comp.status?.type?.state;          // pre | in | post
  const h = Number(home.score), a = Number(away.score);
  const gueltig = Number.isFinite(h) && Number.isFinite(a);

  /* Spielminute nur bei laufendem Spiel — ESPN liefert sie als "23'". */
  let minute = null;
  if(state === 'in'){
    const m = String(comp.status?.displayClock || '').match(/\d+/);
    if(m) minute = Number(m[0]);
  }

  const out = {
    id: 'es' + ev.id,
    start: comp.date || ev.date,
    home: home.team.displayName,
    away: away.team.displayName,
    finished: state === 'post' && gueltig
  };
  if(out.finished) out.score = {h, a};
  else if(state === 'in' && gueltig){
    out.live = true;
    out.liveScore = {h, a};
    out.minute = minute;
  }

  /* Quoten: ESPN gibt amerikanische Moneyline-Quoten von DraftKings mit.
     "close" ist der aktuelle Stand, "open" der Eröffnungskurs. */
  const ml = comp.odds?.[0]?.moneyline;
  if(ml){
    const q1 = americanToDecimal(ml.home?.close?.odds ?? ml.home?.open?.odds);
    const qx = americanToDecimal(ml.draw?.close?.odds ?? ml.draw?.open?.odds);
    const q2 = americanToDecimal(ml.away?.close?.odds ?? ml.away?.open?.odds);
    if(q1 && qx && q2) out.marktQuoten = {q1, qx, q2};
  }
  return out;
}

/**
 * Spiele eines ESPN-Wettbewerbs für mehrere Tage holen.
 *
 * ESPN akzeptiert im dates-Parameter KEINE Zeitspanne (ein Bereich liefert
 * trotzdem nur einen Tag zurück) — deshalb wird pro Tag einzeln abgefragt und
 * anschließend zusammengeführt. Die Abfragen laufen parallel, damit die
 * Funktion nicht in ihr Zeitlimit läuft. Doppelte Spiele (ein Tag kann in
 * zwei Zeitzonen fallen) werden über die ESPN-Id entfernt.
 */
async function loadEspnSoccer(slug, dateStrs){
  const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`;
  const urls = dateStrs.length ? dateStrs.map(d => `${base}?dates=${d}`) : [base];

  const listen = await Promise.all(urls.map(async u => {
    try{
      const r = await fetch(u);
      if(!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d.events) ? d.events : [];
    }catch(e){ return []; }   // ein ausgefallener Tag kippt die anderen nicht
  }));

  const proId = new Map();
  for(const evs of listen)
    for(const ev of evs){
      const m = parseEvent(ev);
      if(m) proId.set(m.id, m);
    }
  return [...proId.values()].sort((x,y) => new Date(x.start) - new Date(y.start));
}

/**
 * Die Tage rund um den aktuellen Champions-League-Spieltag.
 *
 * Ein CL-Spieltag verteilt sich auf Dienstag bis Donnerstag, gelegentlich
 * auch Montag. Ein Fenster von 4 Tagen zurück und 4 nach vorn deckt den
 * laufenden Spieltag samt frisch beendeter Spiele sicher ab, ohne dass für
 * jeden einzelnen Tag der Saison eine Abfrage nötig wäre.
 */
function fensterTage(zurueck = 4, vor = 4){
  const tage = [];
  for(let i = -zurueck; i <= vor; i++)
    tage.push(espnDay(Date.now() + i*864e5));
  return tage;
}


/* Wettbewerbe aus OpenLigaDB — dort seit Jahren zuverlässig gepflegt. */
const LEAGUES = [
  {id:'bl1', name:'Bundesliga',    ol:'bl1', odds:'soccer_germany_bundesliga'},
  {id:'bl2', name:'2. Bundesliga', ol:'bl2', odds:'soccer_germany_bundesliga2'},
  {id:'bl3', name:'3. Liga',       ol:'bl3', odds:'soccer_germany_liga3'}
];
/* Die Champions League kommt NICHT aus OpenLigaDB: der dortige Eintrag für
   2026/27 ist nur ein Platzhalter-Gerüst (identische Anstoßzeiten, identische
   Quoten, falsche Paarungen). ESPN liefert die echte Auslosung samt
   Live-Ständen und Quoten — kostenlos und ohne Odds-API-Guthaben. */
const ESPN_LEAGUES = [
  {id:'ucl', name:'Champions League', slug:'uefa.champions'}
];
const UFC = {id:'ufc', name:'UFC', odds:'mma_mixed_martial_arts'};

const PRIOR = [1.40, 1.40];
const SHRINK = 6;
const VIG_1X2   = 0.06;
const VIG_EXACT = 0.16;

const poisson = (k,l) => { let f=1; for(let i=2;i<=k;i++) f*=i;
  return Math.exp(-l)*Math.pow(l,k)/f; };

function scoreMatrix(lh,la,max=6){
  const m=[];
  for(let i=0;i<=max;i++){ m[i]=[];
    for(let j=0;j<=max;j++) m[i][j]=poisson(i,lh)*poisson(j,la); }
  return m;
}
function probs1X2(m){
  let h=0,d=0,a=0;
  m.forEach((row,i)=>row.forEach((p,j)=>{ i>j?h+=p : i<j?a+=p : d+=p; }));
  const s=h+d+a; return {h:h/s, d:d/s, a:a/s};
}
function devig(qs){
  const raw=qs.map(q=>1/q), s=raw.reduce((a,b)=>a+b,0);
  return raw.map(r=>r/s);
}
function fitLambdas(pH,pD,pA){
  let best=[1.40,1.10], err=Infinity;
  for(let lh=0.30; lh<=3.60; lh+=0.05)
    for(let la=0.25; la<=3.20; la+=0.05){
      const p=probs1X2(scoreMatrix(lh,la,6));
      const e=(p.h-pH)**2+(p.d-pD)**2+(p.a-pA)**2;
      if(e<err){ err=e; best=[lh,la]; }
    }
  return best;
}
const price = (p,vig) => Math.max(1.01, Math.round((1-vig)/Math.max(p,1e-6)*100)/100);

async function loadRatings(league){
  const out = {};
  try{
    const r = await fetch(`https://api.openligadb.de/getbltable/${league}/${SEASON}`);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    if(!Array.isArray(rows) || !rows.length) throw new Error('leere Tabelle');
    let tore=0, spiele=0;
    rows.forEach(t => { tore += Number(t.goals)||0; spiele += Number(t.matches)||0; });
    const schnitt = spiele>0 ? tore/spiele : PRIOR[0];
    rows.forEach(t => {
      const n  = Number(t.matches)||0;
      const gf = Number(t.goals)||0;
      const ga = Number(t.opponentGoals)||0;
      out[t.teamName] = [
        (gf + schnitt*SHRINK) / (n + SHRINK),
        (ga + schnitt*SHRINK) / (n + SHRINK)
      ];
    });
  }catch(e){ /* Startwerte gelten weiter */ }
  return out;
}
const ratingOf = (team, table) => table[team] || PRIOR;
function modelLambdas(home, away, table){
  const [ah,dh] = ratingOf(home, table);
  const [aa,da] = ratingOf(away, table);
  return [ah*da*0.95/PRIOR[1], aa*dh*0.80/PRIOR[1]];
}

function endResult(m){
  if(!m.matchIsFinished) return null;
  const rs = m.matchResults || [];
  const r = rs.find(x => x.resultTypeID === 2) || rs[rs.length-1];
  if(!r) return null;
  const h = Number(r.pointsTeam1), a = Number(r.pointsTeam2);
  if(!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return {h, a};
}
/* Zwischenstand eines gerade laufenden Spiels.
   OpenLigaDB trägt Tore während des Spiels einzeln ein — der aktuelle Stand ist
   also der Stand nach dem zuletzt gefallenen Tor. Steht noch kein Tor drin, das
   Spiel ist aber angepfiffen, heißt das schlicht 0:0.
   Das Zeitfenster (angepfiffen, aber höchstens 3,5 Std. her) verhindert, dass ein
   Spiel ewig als "läuft gerade" gilt, falls jemand vergisst, es abzuschließen. */
function liveInfo(m){
  if(m.matchIsFinished) return null;
  const start = new Date(m.matchDateTime).getTime();
  const now = Date.now();
  if(!Number.isFinite(start)) return null;
  if(start > now || now - start > 3.5*3600e3) return null;
  const goals = Array.isArray(m.goals) ? m.goals : [];
  let h = 0, a = 0, minute = null;
  if(goals.length){
    /* Nicht auf die Reihenfolge im Array verlassen — das Tor mit der höchsten
       Gesamt-Torzahl ist das zuletzt gefallene. */
    let best = null, bestSum = -1;
    for(const g of goals){
      const gh = Number(g.scoreTeam1), ga = Number(g.scoreTeam2);
      if(!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
      if(gh + ga > bestSum){ bestSum = gh + ga; best = g; }
    }
    if(best){
      h = Number(best.scoreTeam1); a = Number(best.scoreTeam2);
      minute = Number(best.matchMinute) || null;
    }
  }
  return {score:{h, a}, minute};
}
async function loadSchedule(league){
  const r = await fetch(`https://api.openligadb.de/getmatchdata/${league}/${SEASON}`);
  if(!r.ok) throw new Error(`OpenLigaDB ${league}: HTTP ${r.status}`);
  const rows = await r.json();
  if(!Array.isArray(rows) || !rows.length) throw new Error(`OpenLigaDB ${league}: keine Spiele`);
  return rows.map(m => {
    const score = endResult(m);
    const live  = score ? null : liveInfo(m);
    return {
      id:'ol'+m.matchID, day: m.group?.groupOrderID || 1, start: m.matchDateTime,
      home: m.team1.teamName, away: m.team2.teamName, finished: !!score,
      ...(score ? {score} : {}),
      ...(live ? {live:true, liveScore:live.score, minute:live.minute} : {})
    };
  });
}

async function loadOdds(sportKey){
  if(!KEY) return [];
  const u = new URLSearchParams({apiKey:KEY, regions:'eu', markets:'h2h', oddsFormat:'decimal'});
  try{
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?${u}`);
    if(!r.ok) return [];
    return await r.json();
  }catch(e){ return []; }
}
const espnDate = ts => {
  const d = new Date(ts);
  return d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0');
};
const normName = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'');
function sameFighter(a,b){
  const x=normName(a), y=normName(b);
  if(!x || !y) return false;
  return x===y || x.includes(y) || y.includes(x);
}
async function loadEspnData(dateStrs){
  const finished=[], allePaarungen=[];
  for(const ds of dateStrs){
    try{
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${ds}`);
      if(!r.ok) continue;
      const data = await r.json();
      for(const ev of data.events||[])
        for(const comp of ev.competitions||[]){
          const cs = comp.competitors||[];
          if(cs.length<2||!cs[0].athlete?.fullName||!cs[1].athlete?.fullName) continue;
          allePaarungen.push({a:cs[0].athlete.fullName, b:cs[1].athlete.fullName});
          if(!comp.status?.type?.completed) continue;
          const winner = cs.find(c=>c.winner===true), loser = cs.find(c=>c.winner===false);
          if(!winner?.athlete?.fullName || !loser?.athlete?.fullName) continue;
          finished.push({winnerName:winner.athlete.fullName, loserName:loser.athlete.fullName, date:comp.date});
        }
    }catch(e){ /* dieser Tag wird übersprungen, Rest läuft weiter */ }
  }
  return {finished, allePaarungen};
}
function bestPrices(ev){
  const best={};
  for(const bm of ev.bookmakers||[]){
    const h2h = bm.markets?.find(m=>m.key==='h2h');
    for(const o of h2h?.outcomes||[])
      if(!best[o.name] || o.price>best[o.name]) best[o.name]=o.price;
  }
  return best;
}

const norm = s => String(s).toLowerCase()
  .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
  .replace(/\b(fc|sc|sv|vfb|vfl|tsg|sg|bv|spvgg|borussia|1|04|05|07|09|1899|1860)\b/g,'')
  .replace(/[^a-z]/g,'')
  .replace('munchen','munich').replace('koln','cologne')
  .replace('monchengladbach','gladbach').replace('mgladbach','gladbach')
  .replace('nurnberg','nuremberg').replace('hannover','hanover')
  .replace('braunschweig','brunswick');
function sameTeam(a,b){
  const x=norm(a), y=norm(b);
  if(!x || !y || x.length<3 || y.length<3) return false;
  return x===y || x.includes(y) || y.includes(x);
}

function buildFootball(match, oddsEvents, table){
  const ev = oddsEvents.find(e =>
    sameTeam(match.home, e.home_team) && sameTeam(match.away, e.away_team));
  let lh, la, sides, source;
  if(ev){
    const best = bestPrices(ev);
    const h=best[ev.home_team], d=best['Draw'], a=best[ev.away_team];
    if(h && d && a){
      sides = [{key:'1',label:'1',q:h},{key:'X',label:'X',q:d},{key:'2',label:'2',q:a}];
      [lh,la] = fitLambdas(...devig([h,d,a]));
      source = 'mkt';
    }
  }
  if(!sides){
    [lh,la] = modelLambdas(match.home, match.away, table);
    const p = probs1X2(scoreMatrix(lh,la,6));
    sides = [
      {key:'1',label:'1',q:price(p.h,VIG_1X2)},
      {key:'X',label:'X',q:price(p.d,VIG_1X2)},
      {key:'2',label:'2',q:price(p.a,VIG_1X2)}
    ];
    source = 'mdl';
  }
  const m = scoreMatrix(lh,la,6), exact=[];
  for(let i=0;i<=3;i++)
    for(let j=0;j<=3;j++)
      exact.push({key:`${i}:${j}`, label:`${i}:${j}`, q:price(m[i][j],VIG_EXACT)});
  return {...match, sport:'fb', source, sides, exact};
}

/* Ein ESPN-Spiel in ein fertiges Tipp-Spiel verwandeln.
   Anders als bei OpenLigaDB stecken die Quoten schon im Spiel selbst — es
   muss also nichts über Team-Namen zusammengesucht werden, was bei
   internationalen Namen ("Internazionale" vs. "Inter Mailand") ohnehin die
   fehleranfälligste Stelle wäre.
   Alle CL-Spiele bekommen day:1 — die Ligaphase kennt keine "Spieltage" im
   Bundesliga-Sinn, und die App zeigt dann schlicht den laufenden Spieltag. */
function buildEspnFootball(m){
  const {marktQuoten, ...rest} = m;
  let lh, la, sides, source;
  if(marktQuoten){
    const {q1, qx, q2} = marktQuoten;
    sides = [{key:'1',label:'1',q:q1},{key:'X',label:'X',q:qx},{key:'2',label:'2',q:q2}];
    [lh,la] = fitLambdas(...devig([q1,qx,q2]));
    source = 'mkt';
  }else{
    /* Ohne Quoten: neutrales Modell mit leichtem Heimvorteil. Für die
       Champions League gibt es keine Liga-Tabelle als Stärke-Maß. */
    [lh,la] = [1.45, 1.15];
    const p = probs1X2(scoreMatrix(lh,la,6));
    sides = [
      {key:'1',label:'1',q:price(p.h,VIG_1X2)},
      {key:'X',label:'X',q:price(p.d,VIG_1X2)},
      {key:'2',label:'2',q:price(p.a,VIG_1X2)}
    ];
    source = 'mdl';
  }
  const mtx = scoreMatrix(lh,la,6), exact=[];
  for(let i=0;i<=3;i++)
    for(let j=0;j<=3;j++)
      exact.push({key:`${i}:${j}`, label:`${i}:${j}`, q:price(mtx[i][j],VIG_EXACT)});
  return {...rest, day:1, sport:'fb', source, sides, exact};
}

const isWeekend = ts => { const d = new Date(ts).getUTCDay(); return d===0 || d===6; };
const mmaId = (a,b) => 'mma-'+[normName(a),normName(b)].sort().join('-');

function buildUFC(oddsEvents, results){
  const built = oddsEvents.map(ev => {
    const best = bestPrices(ev);
    const qa = best[ev.home_team], qb = best[ev.away_team];
    if(!qa || !qb) return null;
    let finished=false, winner=null;
    const hit = results.find(f =>
      (sameFighter(f.winnerName, ev.home_team) && sameFighter(f.loserName, ev.away_team)) ||
      (sameFighter(f.winnerName, ev.away_team) && sameFighter(f.loserName, ev.home_team)));
    if(hit){ finished=true; winner = sameFighter(hit.winnerName, ev.home_team) ? 'A' : 'B'; }
    return {
      id:mmaId(ev.home_team,ev.away_team), day:1, sport:'mma', source:'mkt',
      start:ev.commence_time, home:ev.home_team, away:ev.away_team, finished,
      ...(winner ? {winner} : {}),
      sides:[
        {key:'A', label:ev.home_team.split(' ').pop(), q:qa},
        {key:'B', label:ev.away_team.split(' ').pop(), q:qb}
      ]
    };
  }).filter(Boolean);

  for(const f of results){
    const already = built.some(b =>
      (sameFighter(f.winnerName,b.home) && sameFighter(f.loserName,b.away)) ||
      (sameFighter(f.winnerName,b.away) && sameFighter(f.loserName,b.home)));
    if(already) continue;
    built.push({
      id:mmaId(f.winnerName,f.loserName), day:1, sport:'mma', source:'mkt',
      start:f.date||null, home:f.winnerName, away:f.loserName, finished:true, winner:'A',
      sides:[
        {key:'A', label:f.winnerName.split(' ').pop(), q:1.01},
        {key:'B', label:f.loserName.split(' ').pop(), q:1.01}
      ]
    });
  }

  const weekendOnly = built.filter(f => isWeekend(f.start) || f.start === null);
  if(!weekendOnly.length) return [];

  /* Karten-Auswahl per Zeit-Cluster statt per "ist bei der Odds API noch offen":
     Die alte Logik hat sich daran orientiert, welche Kämpfe die Odds API GERADE
     als offen (wettbar) listet. Sobald eine Card durch ist, verschwinden ihre
     Kämpfe dort komplett — und je nachdem, ob schon eine neue Card gelistet war
     oder nicht, ist entweder die gerade beendete Card verschwunden oder mehrere
     vergangene Wochenenden wurden zu einer Liste zusammengeworfen. Stattdessen
     gruppieren wir jetzt alle bekannten Kämpfe (egal ob offen oder schon
     entschieden) rein nach Startzeit in Cards und wählen die Card, die dem
     aktuellen Zeitpunkt am nächsten liegt — das bleibt stabil, unabhängig
     davon, was die Odds API gerade zufällig anzeigt. */
  const timed = weekendOnly.filter(f => f.start !== null)
    .sort((a,b) => new Date(a.start) - new Date(b.start));
  const untimed = weekendOnly.filter(f => f.start === null);
  if(!timed.length) return untimed;

  const WINDOW = 2*864e5;
  const cards = [];
  for(const f of timed){
    const t = new Date(f.start).getTime();
    const card = cards[cards.length-1];
    if(card && t - card.max <= WINDOW){
      card.fights.push(f);
      card.max = Math.max(card.max, t);
    } else {
      cards.push({fights:[f], min:t, max:t});
    }
  }

  const now = Date.now();
  let closest = cards[0], closestDist = Infinity;
  for(const card of cards){
    const dist = now < card.min ? card.min - now
               : now > card.max ? now - card.max
               : 0;
    if(dist < closestDist){ closestDist = dist; closest = card; }
  }
  return [...closest.fights, ...untimed];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const competitions = [];

  for(const L of LEAGUES){
    try{
      const [schedule, table] = await Promise.all([loadSchedule(L.ol), loadRatings(L.ol)]);
      const odds    = await loadOdds(L.odds);
      const matches = schedule.map(m => buildFootball(m, odds, table));
      competitions.push({id:L.id, name:L.name, sport:'fb', matches});
    }catch(e){ /* ein ausgefallener Wettbewerb reißt die anderen nicht mit */ }
  }

  /* Wettbewerbe aus ESPN (aktuell: Champions League). ESPN liefert Ansetzung,
     Zwischenstand UND Quoten in einem Rutsch — es braucht also weder
     OpenLigaDB noch Odds-API-Guthaben. */
  for(const L of ESPN_LEAGUES){
    try{
      const spiele = await loadEspnSoccer(L.slug, fensterTage());
      if(!spiele.length) continue;
      const matches = spiele.map(m => buildEspnFootball(m));
      competitions.push({id:L.id, name:L.name, sport:'fb', matches});
    }catch(e){ /* Champions League fehlt in diesem Aufruf, Rest bleibt nutzbar */ }
  }

  let fights = [];
  try{
    const odds = await loadOdds(UFC.odds);
    /* 21 Tage zurück statt 3 — ersetzt das frühere "alte data.json lesen",
       das es in einer Serverless-Funktion ohne eigene Festplatte nicht mehr
       geben kann. So bleibt eine kürzlich entschiedene Card trotzdem sichtbar,
       ganz ohne gespeicherten Zustand. */
    const dateSet = new Set();
    odds.forEach(ev => dateSet.add(espnDate(ev.commence_time)));
    for(let i=0;i<21;i++) dateSet.add(espnDate(Date.now()-i*864e5));
    const {finished:results, allePaarungen} = await loadEspnData(dateSet);
    const istEchtesUFC = ev => allePaarungen.some(p =>
      (sameFighter(p.a,ev.home_team)&&sameFighter(p.b,ev.away_team)) ||
      (sameFighter(p.a,ev.away_team)&&sameFighter(p.b,ev.home_team)));
    const proTag={};
    odds.forEach(ev=>{ const d=espnDate(ev.commence_time); (proTag[d]=proTag[d]||[]).push(ev); });
    let oddsGefiltert=[];
    Object.values(proTag).forEach(evsAmTag=>{
      const treffer=evsAmTag.filter(istEchtesUFC);
      if(treffer.length/evsAmTag.length>=0.5) oddsGefiltert.push(...treffer);
      else oddsGefiltert.push(...evsAmTag);
    });
    fights = buildUFC(oddsGefiltert, results);
    if(fights.length) competitions.push({id:'ufc', name:'UFC', sport:'mma', matches:fights});
  }catch(e){ /* UFC fehlt in diesem Aufruf, Rest bleibt trotzdem nutzbar */ }

  if(!competitions.length){
    res.status(502).json({error:'Keine Datenquelle erreichbar'});
    return;
  }

  const bl1 = competitions.find(c => c.id==='bl1');
  const out = {
    updated: new Date().toISOString(),
    competitions,
    matches: bl1 ? bl1.matches : [],
    fights
  };

  /* 90 Sekunden am Vercel-Edge zwischengespeichert: öffnen mehrere Leute die
     App im selben Zeitfenster, wird trotzdem nur EINMAL bei den echten
     Datenquellen nachgefragt — schont sowohl API-Guthaben als auch Ladezeit. */
  res.setHeader('Cache-Control', 'public, s-maxage=90, stale-while-revalidate=30');
  res.status(200).json(out);
}
