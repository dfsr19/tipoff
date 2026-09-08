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

const LEAGUES = [
  {id:'bl1', name:'Bundesliga',       ol:'bl1', odds:'soccer_germany_bundesliga'},
  {id:'bl2', name:'2. Bundesliga',    ol:'bl2', odds:'soccer_germany_bundesliga2'},
  {id:'bl3', name:'3. Liga',          ol:'bl3', odds:'soccer_germany_liga3'},
  {id:'ucl', name:'Champions League', ol:'ucl', odds:'soccer_uefa_champs_league'}
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
async function loadSchedule(league){
  const r = await fetch(`https://api.openligadb.de/getmatchdata/${league}/${SEASON}`);
  if(!r.ok) throw new Error(`OpenLigaDB ${league}: HTTP ${r.status}`);
  const rows = await r.json();
  if(!Array.isArray(rows) || !rows.length) throw new Error(`OpenLigaDB ${league}: keine Spiele`);
  return rows.map(m => {
    const score = endResult(m);
    return {
      id:'ol'+m.matchID, day: m.group?.groupOrderID || 1, start: m.matchDateTime,
      home: m.team1.teamName, away: m.team2.teamName, finished: !!score,
      ...(score ? {score} : {})
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

  const weekendOnly = built.filter(f => isWeekend(f.start));
  const open = weekendOnly.filter(f => !f.finished);
  if(!open.length) return weekendOnly.filter(f=>f.finished);
  const first = Math.min(...open.map(f => new Date(f.start).getTime()));
  const WINDOW = 2*864e5;
  return weekendOnly.filter(f =>
    f.finished || new Date(f.start).getTime() - first <= WINDOW);
}

export default async function handler(req, res) {
  const competitions = [];

  for(const L of LEAGUES){
    try{
      const [schedule, table] = await Promise.all([loadSchedule(L.ol), loadRatings(L.ol)]);
      const odds    = await loadOdds(L.odds);
      const matches = schedule.map(m => buildFootball(m, odds, table));
      competitions.push({id:L.id, name:L.name, sport:'fb', matches});
    }catch(e){ /* ein ausgefallener Wettbewerb reißt die anderen nicht mit */ }
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
