/**
 * sync.js — holt Spielpläne, Quoten und Ergebnisse, schreibt data.json
 * Läuft wöchentlich über GitHub Actions (.github/workflows/sync.yml).
 *
 * Spielplan + Ergebnisse : OpenLigaDB   (kostenlos, ohne Schlüssel)
 * Quoten                 : The Odds API (Schlüssel als Secret ODDS_API_KEY)
 *
 * Wettbewerbe: Bundesliga, 2. Bundesliga, 3. Liga, Champions League, UFC.
 *
 * Buchmacher stellen Quoten meist erst vier bis sieben Tage vor Anpfiff.
 * Für alle übrigen Spiele rechnet dieses Skript eigene Quoten aus der
 * Spielstärke der Mannschaften — sonst hätte jede Partie denselben Wert
 * und es gäbe gar keine Ergebniswette.
 */

const KEY = process.env.ODDS_API_KEY;
const SEASON = process.env.SEASON || '2026';

/* ══════════════════════════════════════════════════════════════════════════
   WETTBEWERBE
   'ol'   = Kürzel bei OpenLigaDB
   'odds' = Kürzel bei The Odds API
   Fällt einer aus, laufen die übrigen trotzdem durch.
   ══════════════════════════════════════════════════════════════════════════ */
const LEAGUES = [
  {id:'bl1', name:'Bundesliga',       ol:'bl1', odds:'soccer_germany_bundesliga'},
  {id:'bl2', name:'2. Bundesliga',    ol:'bl2', odds:'soccer_germany_bundesliga2'},
  {id:'bl3', name:'3. Liga',          ol:'bl3', odds:'soccer_germany_liga3'},
  {id:'ucl', name:'Champions League', ol:'ucl', odds:'soccer_uefa_champs_league'}
];
const UFC = {id:'ufc', name:'UFC', odds:'mma_mixed_martial_arts'};

/* ══════════ Spielstärke ══════════
   Erwartete Tore je Spiel, geschätzt aus der laufenden Tabelle.
   Am Saisonanfang gibt es noch keine Zahlen — dann greifen diese Startwerte. */
const PRIOR = [1.40, 1.40];      // [Angriff, Abwehr] für unbekannte Vereine
const SHRINK = 6;                // wie stark die Startwerte nachwirken
const VIG_1X2   = 0.06;          // Marge Siegwette
const VIG_EXACT = 0.16;          // Marge Ergebniswette

/* ══════════ Poisson-Modell ══════════ */
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
/* Umkehrung: welche Torerwartungen passen zu diesen 1X2-Wahrscheinlichkeiten? */
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

/* ══════════ Spielstärke aus der Tabelle ══════════
   OpenLigaDB liefert je Verein Tore und Gegentore der laufenden Saison.
   Daraus wird die Spielstärke geschätzt, behutsam gemischt mit den
   Startwerten — so sind die Quoten schon am ersten Spieltag brauchbar
   und werden mit jedem Spieltag genauer.                                    */
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
    console.log(`  Spielstärke aus Tabelle: ${rows.length} Mannschaften, Schnitt ${schnitt.toFixed(2)} Tore`);
  }catch(e){
    console.log(`  Keine Tabelle verfügbar (${e.message}) — es gelten die Startwerte`);
  }
  return out;
}
const ratingOf = (team, table) => table[team] || PRIOR;

function modelLambdas(home, away, table){
  const [ah,dh] = ratingOf(home, table);
  const [aa,da] = ratingOf(away, table);
  /* 0.95 und 0.80 bilden den Heimvorteil ab */
  return [ah*da*0.95/PRIOR[1], aa*dh*0.80/PRIOR[1]];
}

/* ══════════ Spielplan und Ergebnisse ══════════ */
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
      id:'ol'+m.matchID,
      day: m.group?.groupOrderID || 1,
      start: m.matchDateTime,
      home: m.team1.teamName,
      away: m.team2.teamName,
      finished: !!score,
      ...(score ? {score} : {})
    };
  });
}

/* ══════════ Quoten und Ergebnisse von The Odds API ══════════ */
async function loadOdds(sportKey){
  if(!KEY){ console.log('  Kein ODDS_API_KEY — nur Modellquoten'); return []; }
  const u = new URLSearchParams({apiKey:KEY, regions:'eu', markets:'h2h', oddsFormat:'decimal'});
  try{
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?${u}`);
    if(!r.ok){ console.log(`  Quoten ${sportKey}: HTTP ${r.status} — es gelten Modellquoten`); return []; }
    const left = r.headers.get('x-requests-remaining');
    if(left) console.log(`  Odds API: noch ${left} Abrufe frei`);
    return await r.json();
  }catch(e){ console.log(`  Quoten ${sportKey}: ${e.message}`); return []; }
}
async function loadScores(sportKey){
  if(!KEY) return [];
  const u = new URLSearchParams({apiKey:KEY, daysFrom:'3'});
  try{
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?${u}`);
    if(!r.ok){ console.log(`  Ergebnisse ${sportKey}: HTTP ${r.status}`); return []; }
    return await r.json();
  }catch(e){ console.log(`  Ergebnisse ${sportKey}: ${e.message}`); return []; }
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

/* ══════════ Vereinsnamen der beiden Quellen zusammenbringen ══════════
   OpenLigaDB schreibt deutsch ("FC Bayern München"), die Odds API englisch
   ("Bayern Munich") — ohne Übersetzung fände man kein einziges Spiel wieder. */
const norm = s => String(s).toLowerCase()
  .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
  .replace(/\b(fc|sc|sv|vfb|vfl|tsg|sg|bv|spvgg|borussia|1|04|05|07|09|1899|1860)\b/g,'')
  .replace(/[^a-z]/g,'')
  .replace('munchen','munich')
  .replace('koln','cologne')
  .replace('monchengladbach','gladbach')
  .replace('mgladbach','gladbach')
  .replace('nurnberg','nuremberg')
  .replace('hannover','hanover')
  .replace('braunschweig','brunswick');
function sameTeam(a,b){
  const x=norm(a), y=norm(b);
  if(!x || !y || x.length<3 || y.length<3) return false;
  return x===y || x.includes(y) || y.includes(x);
}

/* ══════════ Ein Fußballspiel fertig aufbereiten ══════════ */
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

/* ══════════ Kampfsport ══════════ */
function buildUFC(oddsEvents, scores){
  return oddsEvents.map(ev => {
    const best = bestPrices(ev);
    const qa = best[ev.home_team], qb = best[ev.away_team];
    if(!qa || !qb) return null;

    let finished = false, winner = null;
    const sc = (scores||[]).find(s => s.id === ev.id);
    if(sc && sc.completed && Array.isArray(sc.scores)){
      const a = sc.scores.find(x => x.name === ev.home_team);
      const b = sc.scores.find(x => x.name === ev.away_team);
      const na = Number(a?.score), nb = Number(b?.score);
      if(Number.isFinite(na) && Number.isFinite(nb) && na !== nb){
        finished = true; winner = na > nb ? 'A' : 'B';
      }
    }
    return {
      /* Kennung von der API — bleibt über Wochen gleich, damit
         abgegebene Tipps beim nächsten Abruf nicht ins Leere laufen. */
      id:'mma-'+ev.id, day:1, sport:'mma', source:'mkt',
      start:ev.commence_time, home:ev.home_team, away:ev.away_team, finished,
      ...(winner ? {winner} : {}),
      sides:[
        {key:'A', label:ev.home_team.split(' ').pop(), q:qa},
        {key:'B', label:ev.away_team.split(' ').pop(), q:qb}
      ]
    };
  }).filter(Boolean);
}

/* ══════════ Alles zusammenführen ══════════ */
(async () => {
  const competitions = [];
  const bericht = [];

  for(const L of LEAGUES){
    console.log(`\n${L.name} (${L.ol}):`);
    try{
      const [schedule, table] = await Promise.all([loadSchedule(L.ol), loadRatings(L.ol)]);
      const odds    = await loadOdds(L.odds);
      const matches = schedule.map(m => buildFootball(m, odds, table));
      const mkt     = matches.filter(m => m.source==='mkt').length;
      const fertig  = matches.filter(m => m.finished).length;

      competitions.push({id:L.id, name:L.name, sport:'fb', matches});
      bericht.push(`${L.name}: ${matches.length} Spiele, ${mkt} mit Marktquoten, ${fertig} gespielt`);
      console.log(`  OK — ${matches.length} Spiele, ${mkt} mit Marktquoten, ${fertig} bereits gespielt`);
    }catch(e){
      /* Ein Ausfall darf die übrigen Wettbewerbe nicht mitreißen. */
      bericht.push(`${L.name}: FEHLT (${e.message})`);
      console.log(`  FEHLER — ${e.message}`);
    }
  }

  console.log(`\n${UFC.name}:`);
  let fights = [];
  try{
    const [odds, scores] = await Promise.all([loadOdds(UFC.odds), loadScores(UFC.odds)]);
    fights = buildUFC(odds, scores);
    if(fights.length) competitions.push({id:'ufc', name:'UFC', sport:'mma', matches:fights});
    bericht.push(`UFC: ${fights.length} Kämpfe, ${fights.filter(f=>f.finished).length} entschieden`);
    console.log(`  OK — ${fights.length} Kämpfe, ${fights.filter(f=>f.finished).length} entschieden`);
  }catch(e){
    bericht.push(`UFC: FEHLT (${e.message})`);
    console.log(`  FEHLER — ${e.message}`);
  }

  if(!competitions.length){
    console.error('\nKein einziger Wettbewerb abrufbar — data.json bliebe leer. Abbruch.');
    process.exit(1);
  }

  const bl1 = competitions.find(c => c.id==='bl1');
  const out = {
    updated: new Date().toISOString(),
    competitions,
    /* Für ältere App-Versionen, die nur diese beiden Felder kennen: */
    matches: bl1 ? bl1.matches : [],
    fights
  };
  require('fs').writeFileSync('data.json', JSON.stringify(out));

  console.log('\n─── Zusammenfassung ───');
  bericht.forEach(z => console.log('  '+z));
})().catch(e => { console.error('Abbruch:', e.message); process.exit(1); });
