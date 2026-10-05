/**
 * api/data.js — Vercel Serverless Function
 *
 * Ersetzt sync.js + GitHub Actions: läuft nicht mehr nach einem festen
 * Zeitplan, sondern bei jedem Seitenaufruf — mit kurzer Zwischenspeicherung
 * (Cache-Control-Header unten), damit nicht jeder einzelne Besuch eine neue
 * Anfrage an die echten Datenquellen auslöst.
 *
 * Spielplan + Ergebnisse : OpenLigaDB      (kostenlos, ohne Schlüssel)
 * Quoten (Bundesliga etc): eigenes Modell  (Tabellenwerte aus OpenLigaDB,
 *                           keine externe Quote nötig — echte Marktquoten
 *                           würden hier zwar minimal realistischer sein,
 *                           kosten aber Odds-API-Guthaben ohne echten Vorteil
 *                           fürs Tippspiel; bewusst weggelassen)
 * Champions League       : ESPN Scoreboard (Ansetzung, Live-Stand, Quote wo
 *                           vorhanden — kostenlos, kein Odds-API-Guthaben)
 * UFC                    : The Odds API für ECHTE Marktquoten, ESPN Scoreboard
 *                           für Ergebnisse und zum Aussortieren von Nicht-UFC-
 *                           Kämpfen (die MMA-Kategorie bei Odds API ist nicht
 *                           UFC-exklusiv). Odds-API-Guthaben wird NICHT bei
 *                           jedem Seitenaufruf verbraucht, sondern nur alle
 *                           6 Stunden einmal — dazwischen läuft alles über
 *                           einen Zwischenspeicher in Vercel KV (siehe unten).
 *                           Gibt es (noch) keine echte Quote für einen Kampf,
 *                           taucht er schlicht nicht auf — KEINE Platzhalter-
 *                           oder Modell-Quote für noch offene Kämpfe, damit
 *                           nie ein falscher Favorit angezeigt wird.
 *
 * WICHTIGER UNTERSCHIED zu sync.js: Serverless-Funktionen haben keine eigene
 * Festplatte, die zwischen Aufrufen erhalten bleibt — "die letzte data.json
 * lesen, um alte Kämpfe zu übernehmen" geht hier nicht mehr. Für UFC-Ergebnisse
 * wird ESPN deshalb für ein deutlich breiteres Zeitfenster abgefragt (21 Tage
 * zurück), für die Odds-API-Quoten übernimmt stattdessen Vercel KV die Rolle
 * des Gedächtnisses zwischen Aufrufen.
 */

const SEASON = process.env.SEASON || '2026';
const ODDS_KEY = process.env.ODDS_API_KEY;
const FD_KEY   = process.env.FOOTBALL_DATA_KEY;

/* ══════════ ZWISCHENSPEICHER FÜR ODDS-API (Vercel KV) ══════════
   Ohne das würde jeder einzelne Seitenaufruf live bei The Odds API anfragen
   und binnen weniger Tage das komplette Monats-Guthaben (500 Anfragen) auf-
   brauchen — genau das ist am 12.09.2026 passiert. Stattdessen wird hier nur
   alle 6 Stunden EINMAL wirklich nachgefragt; dazwischen liefert jeder Aufruf
   das letzte gespeicherte Ergebnis aus Vercel KV, komplett unabhängig davon,
   wie oft die App in der Zwischenzeit geöffnet wird.

   Kommt eine frische Abfrage leer zurück (Guthaben erschöpft, Odds API kurz
   down, o.ä.), wird der Speicher NICHT überschrieben — sonst würde ein
   einziger fehlgeschlagener Versuch die zuletzt bekannten, guten Quoten
   sofort löschen. Stattdessen bleibt der alte Stand einfach etwas länger
   als 6 Stunden gültig, bis der nächste Versuch wieder klappt.

   Voraussetzung: In den Vercel-Projekteinstellungen muss unter "Storage"
   einmalig ein KV-Speicher angelegt und mit diesem Projekt verbunden sein —
   danach setzt Vercel KV_REST_API_URL und KV_REST_API_TOKEN automatisch als
   Umgebungsvariablen. Ohne die beiden läuft die App weiter, fragt dann aber
   wieder bei jedem Aufruf live nach (kein Absturz, nur kein Schutz). */
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ODDS_CACHE_TTL_MS = 6*3600e3;
const ODDS_CACHE_KEY = 'ufc-odds-v1';

async function kvGet(key){
  if(!KV_URL || !KV_TOKEN) return null;
  try{
    const r = await fetch(`${KV_URL}/get/${key}`, {headers:{Authorization:`Bearer ${KV_TOKEN}`}});
    if(!r.ok) return null;
    const j = await r.json();
    return j.result == null ? null : JSON.parse(j.result);
  }catch(e){ return null; }
}
async function kvSet(key, value){
  if(!KV_URL || !KV_TOKEN) return;
  try{
    await fetch(`${KV_URL}/set/${key}`, {
      method:'POST',
      headers:{Authorization:`Bearer ${KV_TOKEN}`},
      body: JSON.stringify(value)
    });
  }catch(e){ /* Cache-Schreibfehler ist unkritisch — nächster Versuch in 6h */ }
}

/* ── Feste Kämpfer-Reihenfolge ─────────────────────────────────────────────
   Ein UFC-Tipp wird als "A" oder "B" gespeichert. Solange der Kampf bei der
   Odds API gelistet ist, steht A für deren "Heim"-Kämpfer. Ist der Kampf durch,
   fliegt er dort aus der Liste und wird nur noch aus ESPN nachgebaut — und
   dort stand der SIEGER immer als A. Dadurch drehte sich jeder Tipp, bei dem
   die Odds API den Sieger zuletzt als B geführt hatte, nachträglich auf den
   Gegner (und umgekehrt wurden falsche Tipps plötzlich "richtig").

   Lösung: Die Reihenfolge wird beim ersten Sehen des Kampfes dauerhaft im KV
   gemerkt und danach nie mehr aus dem Ergebnis abgeleitet. */
const ORDER_KEY = 'ufc-order-v1';
const MEET_WINDOW = 10*864e5;     // gleiches Paar innerhalb von 10 Tagen = derselbe Kampf
const pairEntries = (order, a, b) => Object.entries(order||{}).filter(([,e]) =>
  (sameFighter(e.h,a)&&sameFighter(e.a,b)) || (sameFighter(e.h,b)&&sameFighter(e.a,a)));
const sameMeeting = (x, y) => {
  const p=Date.parse(x), q=Date.parse(y);
  return !isFinite(p) || !isFinite(q) || Math.abs(p-q) < MEET_WINDOW;
};
/* Welcher Register-Eintrag gehört zu GENAU diesem Kampf (Paar + Zeitraum)?
   Ein noch nicht ausgetragener Eintrag mit anderem Datum gilt als verschobener
   Kampf (gleiche ID, damit die Tipps erhalten bleiben). Ein bereits beendeter
   Eintrag dagegen als frühere Begegnung — taucht das Paar danach wieder auf, ist
   es ein Rückkampf mit eigener ID. */
function reihenfolgeFinden(order, a, b, dMs){
  const list = pairEntries(order, a, b);
  if(!list.length) return null;
  const hit = list.find(([,e]) => e.d==null || !isFinite(dMs) || Math.abs(e.d-dMs) < MEET_WINDOW)
           || list.find(([,e]) => !e.fin);
  return hit ? {id:hit[0], e:hit[1]} : null;
}
/* ID für einen neuen Kampf: der erste einer Paarung behält die bisherige ID (damit
   bestehende Tipps passen), jede weitere Begegnung bekommt das Datum angehängt. */
function neueId(order, a, b, dMs){
  const base = mmaId(a,b);
  if(!order[base]) return base;
  return base+'-'+new Date(isFinite(dMs)?dMs:Date.now()).toISOString().slice(0,10).replace(/-/g,'');
}
/* Dreht ein Odds-API-Ereignis, falls die Odds API die Seiten inzwischen anders
   herum liefert als beim ersten Mal, und hängt die feste ID an. */
function reihenfolgeAnpassen(ev, order){
  const f = reihenfolgeFinden(order, ev.home_team, ev.away_team, Date.parse(ev.commence_time));
  if(!f) return ev;
  const dreh = !sameFighter(f.e.h, ev.home_team);
  return {...ev, _id:f.id, ...(dreh ? {home_team:ev.away_team, away_team:ev.home_team} : {})};
}
/* Merkt sich die zuletzt gesehenen echten Quoten jedes Kampfes im Register, damit
   sie nach dem Kampf (wenn die Odds API ihn nicht mehr listet) erhalten bleiben. */
function quotenMerken(order, fights){
  let geaendert = false;
  for(const f of fights){
    const o = order[f.id];
    if(!o || f.finished && f.fest===false) continue;
    const qh = f.sides[0].q, qa = f.sides[1].q;
    if(!qh || !qa || qh<=1.01 && qa<=1.01) continue;
    const neu = {[f.home]: qh, [f.away]: qa};
    if(JSON.stringify(o.q) !== JSON.stringify(neu)){ o.q = neu; geaendert = true; }
  }
  return geaendert;
}
async function reihenfolgeLaden(oddsEvents, rohKaempfe){
  const order = (await kvGet(ORDER_KEY)) || {};
  let geaendert = false;
  /* Jeden gelisteten Kampf beim ersten Sehen festhalten (kostet nichts). */
  for(const ev of oddsEvents){
    const d = Date.parse(ev.commence_time);
    const f = reihenfolgeFinden(order, ev.home_team, ev.away_team, d);
    if(f){
      if(isFinite(d) && f.e.d!==d && !f.e.fin){ f.e.d = d; geaendert = true; }   // Kampf verschoben
      continue;
    }
    order[neueId(order, ev.home_team, ev.away_team, d)] = {h:ev.home_team, a:ev.away_team, d};
    geaendert = true;
  }
  /* Ausgetragene Kämpfe als beendet markieren — ab dann zählt dasselbe Paar
     in der Zukunft als Rückkampf. */
  for(const f of rohKaempfe){
    if(!f.finished) continue;
    for(const [,e] of pairEntries(order, f.a, f.b))
      if(!e.fin && (e.d==null || sameMeeting(e.d, f.date))){ e.fin = true; geaendert = true; }
  }
  if(geaendert) await kvSet(ORDER_KEY, order);
  return order;
}

/* Rohe, ungecachte Abfrage bei The Odds API — wird ab jetzt nur noch von
   loadOddsCached() aus aufgerufen, nie mehr direkt bei jedem Seitenaufruf. */
async function loadOddsRoh(sportKey){
  if(!ODDS_KEY) return [];
  const u = new URLSearchParams({apiKey:ODDS_KEY, regions:'eu', markets:'h2h', oddsFormat:'decimal'});
  try{
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?${u}`);
    if(!r.ok) return [];
    return await r.json();
  }catch(e){ return []; }
}

async function loadOddsCached(sportKey){
  const cached = await kvGet(ODDS_CACHE_KEY);
  if(cached && (Date.now()-cached.zeit) < ODDS_CACHE_TTL_MS) return cached.daten;

  const frisch = await loadOddsRoh(sportKey);
  if(frisch.length){
    await kvSet(ODDS_CACHE_KEY, {zeit:Date.now(), daten:frisch});
    return frisch;
  }
  /* Frische Abfrage kam leer zurück — altes Ergebnis weiterverwenden statt
     den Cache zu leeren, falls überhaupt schon mal was Gutes gespeichert war. */
  return cached ? cached.daten : [];
}

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
/* OpenLigaDB liefert matchDateTime in deutscher Ortszeit OHNE Zeitzonen-Angabe
   — naiv geparst hält JavaScript das für UTC und verschiebt die Zeit um 1-2
   Stunden. matchDateTimeUTC ist das richtige Feld, aber auch das kommt ohne
   "Z" — das hängen wir hier explizit an, damit es eindeutig als UTC erkannt
   wird. Fehlt matchDateTimeUTC ausnahmsweise, bleibt nur der unsichere
   Rückfall auf matchDateTime. */
function utcZeit(m){
  if(m.matchDateTimeUTC)
    return /[Zz]|[+-]\d\d:\d\d$/.test(m.matchDateTimeUTC) ? m.matchDateTimeUTC : m.matchDateTimeUTC+'Z';
  return m.matchDateTime || null;
}
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
/* Ligen, deren Spielplan von football-data.org kommt (kostenlos, 10 Abfragen/Min.). */
const INTL = [
  {id:'eng1', name:'Premier League', fd:'PL', odds:'soccer_epl'},
  {id:'esp1', name:'La Liga',        fd:'PD', odds:'soccer_spain_la_liga'},
  {id:'ita1', name:'Serie A',        fd:'SA', odds:'soccer_italy_serie_a'}
];
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
  const start = new Date(utcZeit(m)).getTime();
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
      id:'ol'+m.matchID, day: m.group?.groupOrderID || 1, start: utcZeit(m),
      home: m.team1.teamName, away: m.team2.teamName, finished: !!score,
      ...(score ? {score} : {}),
      ...(live ? {live:true, liveScore:live.score, minute:live.minute} : {})
    };
  });
}

/* ── Spielplan von football-data.org ──
   Liefert den kompletten Saison-Spielplan mit Spieltagsnummer, Anstoßzeit und
   Endergebnis. Im Gratis-Tarif kommen Ergebnisse leicht verzögert — der Live-
   Stand und das schnelle Abpfiff-Signal kommen deshalb aus ESPN (api/live.js).
   5 Minuten Zwischenspeicher: bei 3 Ligen sind das höchstens 36 Abfragen pro
   Stunde, weit unter dem Limit. Antwortet die Quelle nicht, gilt der letzte
   gespeicherte Stand weiter, statt dass die Liga verschwindet. */
const FD_TTL = 5*60e3;
function fdMatch(m){
  if(!m || !m.id || !m.homeTeam || !m.awayTeam) return null;
  if(m.status === 'CANCELLED') return null;
  const ft = m.score && m.score.fullTime;
  const fertig = (m.status==='FINISHED' || m.status==='AWARDED') && ft && Number.isFinite(ft.home) && Number.isFinite(ft.away);
  return {
    id:'fd'+m.id, day:m.matchday||1, start:m.utcDate,
    home:m.homeTeam.name||m.homeTeam.shortName, away:m.awayTeam.name||m.awayTeam.shortName,
    ...(m.homeTeam.tla ? {homeTla:m.homeTeam.tla} : {}), ...(m.awayTeam.tla ? {awayTla:m.awayTeam.tla} : {}),
    finished:!!fertig, ...(fertig ? {score:{h:ft.home,a:ft.away}} : {})
  };
}
async function loadScheduleFD(code){
  const key = 'fd-sched-v1-'+code, jetzt = Date.now();
  const cached = await kvGet(key);
  if(cached && jetzt-cached.zeit < FD_TTL) return cached.matches;
  try{
    if(!FD_KEY) throw new Error('FOOTBALL_DATA_KEY fehlt');
    const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/matches`, {headers:{'X-Auth-Token':FD_KEY}});
    if(!r.ok) throw new Error(`football-data ${code}: HTTP ${r.status}`);
    const d = await r.json();
    const matches = (Array.isArray(d.matches)?d.matches:[]).map(fdMatch).filter(Boolean);
    if(!matches.length) throw new Error(`football-data ${code}: keine Spiele`);
    await kvSet(key, {zeit:jetzt, matches});
    return matches;
  }catch(e){
    if(cached) return cached.matches;        // alter Stand ist besser als keine Liga
    throw e;
  }
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

/* Ergebnisse UND die vollständige Liste echter UFC-Paarungen von ESPN.
   Letztere braucht es, weil die "mma_mixed_martial_arts"-Kategorie bei
   The Odds API NICHT UFC-exklusiv ist — andere Promotions können mit
   reinrutschen. Ein Kampf gilt nur als echtes UFC, wenn ESPN ihn für den
   gleichen Tag auch kennt (Abgleich passiert im handler). */
async function loadEspnData(dateStrs){
  const roh = [];
  for(const ds of dateStrs){
    try{
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${ds}`);
      if(!r.ok) continue;
      const data = await r.json();
      for(const ev of data.events||[])
        for(const comp of ev.competitions||[]){
          const cs = comp.competitors||[];
          if(cs.length<2||!cs[0].athlete?.fullName||!cs[1].athlete?.fullName) continue;
          const finished = !!comp.status?.type?.completed;
          let winner = null;
          if(finished){
            const w = cs.find(c=>c.winner===true);
            if(w===cs[0]) winner='A'; else if(w===cs[1]) winner='B';
          }
          roh.push({a:cs[0].athlete.fullName, b:cs[1].athlete.fullName, date:comp.date, finished, winner});
        }
    }catch(e){ /* dieser Tag wird übersprungen, Rest läuft weiter */ }
  }
  /* ESPN kann denselben Kampf über zwei Datums-Buckets doppelt liefern (Zeitzonen) —
     per Namens-Id entdoppeln, die Version mit Ergebnis gewinnt. */
  const proId = new Map();
  for(const f of roh){
    const id = mmaId(f.a,f.b);
    const vorhanden = proId.get(id);
    if(!vorhanden || (f.finished && !vorhanden.finished)) proId.set(id, f);
  }
  return [...proId.values()];
}
/* Marktnahe Quote = MEDIAN der Anbieter (ein typischer Buchmacher), nicht der
   höchste Preis — der läge systematisch über dem, was ein normaler Anbieter zahlt. */
function medianPrices(ev){
  const alle={};
  for(const bm of ev.bookmakers||[]){
    const h2h = bm.markets?.find(m=>m.key==='h2h');
    for(const o of h2h?.outcomes||[]) if(o.price>1) (alle[o.name]=alle[o.name]||[]).push(o.price);
  }
  const out={};
  for(const [k,v] of Object.entries(alle)){
    v.sort((a,b)=>a-b); const m=v.length>>1;
    out[k]=Math.round((v.length%2?v[m]:(v[m-1]+v[m])/2)*100)/100;
  }
  return out;
}

/* ── Fußball-Quoten: einmal pro Woche, bei Lücken höchstens einmal täglich ──
   Pro Liga wird die Odds API grundsätzlich nur einmal pro Woche gefragt. Fehlt
   bei einem Spiel der nächsten 6 Tage noch eine Quote (Anbieter listen manche
   Spiele erst später), wird höchstens einmal am Tag nachgesehen. Gespeichert
   wird nur das Nötige (Teams, Anstoß, Median-Quote), nicht die Rohantwort. */
const DAY = 864e5;
const FB_ODDS_TTL = 7*DAY;
const FB_QUOTES_KEY = 'fb-quotes-v1';
function kompakteQuoten(events){
  return events.map(ev => {
    const p = medianPrices(ev);
    const q1=p[ev.home_team], qx=p['Draw'], q2=p[ev.away_team];
    return (q1&&qx&&q2) ? {home:ev.home_team, away:ev.away_team, commence:ev.commence_time, q1, qx, q2} : null;
  }).filter(Boolean);
}
function findeQuote(match, events, intl){
  const gleich = intl ? sameTeamIntl : sameTeam;
  const t = Date.parse(match.start);
  return events.find(e => gleich(match.home, e.home) && gleich(match.away, e.away) &&
    (!isFinite(t) || Math.abs(Date.parse(e.commence) - t) < 2*DAY)) || null;
}
async function loadLeagueOdds(sportKey, schedule, intl){
  const key = 'fb-odds-'+sportKey, jetzt = Date.now();
  const cached = await kvGet(key);
  const daten = cached ? cached.daten : [];
  const alter = cached ? jetzt - cached.zeit : Infinity;
  const luecke = schedule.some(m => {
    const t = Date.parse(m.start);
    return !m.finished && t > jetzt && t - jetzt < 6*DAY && !findeQuote(m, daten, intl);
  });
  if(alter < FB_ODDS_TTL && !(luecke && alter > DAY)) return daten;
  const frisch = kompakteQuoten(await loadOddsRoh(sportKey));
  const neu = frisch.length ? frisch : daten;      // Fehler/leer: alte Daten behalten
  await kvSet(key, {zeit:jetzt, daten:neu});        // Zeitstempel trotzdem setzen → kein Dauerfeuern
  return neu;
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
/* ── Vereinsnamen international ──
   football-data.org, die Odds API und ESPN schreiben dieselben Vereine
   unterschiedlich ("Manchester United FC" / "Manchester United", "FC
   Internazionale Milano" / "Inter Milan", "Club Atlético de Madrid" /
   "Atlético Madrid"). Zuerst werden Allerweltswörter (FC, CF, AC, "de", Jahres-
   zahlen …) entfernt, danach bekannte Sonderfälle auf eine gemeinsame Schreib-
   weise gebracht. Verglichen wird dann auf exakte Gleichheit — "Inter" darf
   nie als Teil von "Milan" gelten oder umgekehrt. */
const INTL_STOP = new Set(['fc','cf','afc','ac','as','ss','ssc','us','acf','bc','cfc','sc','cd','ud','rcd','rc','ca',
  'calcio','club','de','del','di','the','and','balompie','futbol']);
const INTL_ALIAS = {
  internazionalemilano:'intermilan', internazionale:'intermilan', inter:'intermilan',
  athleticbilbao:'athletic', athleticclub:'athletic',
  rayovallecanomadrid:'rayovallecano', espanyolbarcelona:'espanyol', deportivoalaves:'alaves',
  wolves:'wolverhamptonwanderers', spurs:'tottenhamhotspur', manunited:'manchesterunited', mancity:'manchestercity',
  verona:'hellasverona', celta:'celtavigo', betis:'realbetis', atleticomadrid:'atleticomadrid', atletico:'atleticomadrid',
  newcastle:'newcastleunited', westham:'westhamunited', leeds:'leedsunited', nottmforest:'nottinghamforest',
  brighton:'brightonhovealbion', sociedad:'realsociedad', oviedo:'realoviedo', valladolid:'realvalladolid'
};
function canonIntl(name){
  const t = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/&/g,' and ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
    .filter(w => w && !INTL_STOP.has(w) && !/^\d+$/.test(w));
  const k = t.join('');
  return INTL_ALIAS[k] || k;
}
function sameTeamIntl(a,b){
  const x = canonIntl(a), y = canonIntl(b);
  if(!x || !y) return false;
  if(x===y) return true;
  /* Rückfall für unbekannte Schreibweisen: einer enthält den anderen, aber nur bei
     längeren Namen, damit kurze wie "inter"/"milan" nie vermischt werden. */
  return x.length>=8 && y.length>=8 && (x.includes(y) || y.includes(x));
}

const TEAM_GLEICH = {herthabsc:'hertha', herthaberlin:'hertha'};
function sameTeam(a,b){
  const x=TEAM_GLEICH[norm(a)]||norm(a), y=TEAM_GLEICH[norm(b)]||norm(b);
  if(!x || !y || x.length<3 || y.length<3) return false;
  return x===y || x.includes(y) || y.includes(x);
}

/* Aus Marktquoten (1/X/2) ein Tipp-Spiel bauen. Die Quoten fürs genaue Ergebnis
   werden aus genau diesen Marktquoten abgeleitet (Torerwartung → Poisson), damit
   jedes Ergebnis seine eigene, zur Marktlage passende Quote hat. Gibt es noch
   keine Marktquote, bekommt das Spiel KEINE Quote ("Quote folgt") — es wird
   bewusst nichts selbst errechnet. */
const OHNE_QUOTE = [{key:'1',label:'1',q:null},{key:'X',label:'X',q:null},{key:'2',label:'2',q:null}];
function mitMarktquoten(match, q){
  const [lh,la] = fitLambdas(...devig(q));
  const m = scoreMatrix(lh,la,6), exact=[];
  for(let i=0;i<=3;i++)
    for(let j=0;j<=3;j++)
      exact.push({key:`${i}:${j}`, label:`${i}:${j}`, q:price(m[i][j],VIG_EXACT)});
  return {...match, sport:'fb', source:'mkt',
    sides:[{key:'1',label:'1',q:q[0]},{key:'X',label:'X',q:q[1]},{key:'2',label:'2',q:q[2]}], exact};
}
/* gemerkt = letzte bekannte Marktquote dieses Spiels (bleibt nach dem Anpfiff
   erhalten, auch wenn die Odds API das Spiel dann nicht mehr listet). */
function buildFootball(match, events, gemerkt, intl){
  const e = findeQuote(match, events, intl);
  const q = e ? [e.q1, e.qx, e.q2] : (gemerkt ? gemerkt.q : null);
  if(!q) return {...match, sport:'fb', source:'none', sides:OHNE_QUOTE.map(x=>({...x})), exact:[]};
  const out = mitMarktquoten(match, q);
  if(e && (!gemerkt || JSON.stringify(gemerkt.q)!==JSON.stringify(q))) out._merken = {q, t:Date.now()};
  return out;
}
function quotenGedaechtnisAufraeumen(memo){
  const grenze = Date.now() - 150*DAY;
  for(const [k,v] of Object.entries(memo)) if(!v || v.t < grenze) delete memo[k];
}

/* Ein ESPN-Spiel in ein fertiges Tipp-Spiel verwandeln.
   Anders als bei OpenLigaDB stecken die Quoten schon im Spiel selbst — es
   muss also nichts über Team-Namen zusammengesucht werden, was bei
   internationalen Namen ("Internazionale" vs. "Inter Mailand") ohnehin die
   fehleranfälligste Stelle wäre.
   Alle CL-Spiele bekommen day:1 — die Ligaphase kennt keine "Spieltage" im
   Bundesliga-Sinn, und die App zeigt dann schlicht den laufenden Spieltag. */
function buildEspnFootball(m, gemerkt){
  const {marktQuoten, ...rest} = m;
  const q = marktQuoten ? [marktQuoten.q1, marktQuoten.qx, marktQuoten.q2] : (gemerkt ? gemerkt.q : null);
  if(!q) return {...rest, day:1, sport:'fb', source:'none', sides:OHNE_QUOTE.map(x=>({...x})), exact:[]};
  const out = {...mitMarktquoten(rest, q), day:1};
  if(marktQuoten && (!gemerkt || JSON.stringify(gemerkt.q)!==JSON.stringify(q))) out._merken = {q, t:Date.now()};
  return out;
}

const isWeekend = ts => { const d = new Date(ts).getUTCDay(); return d===0 || d===6; };
const mmaId = (a,b) => 'mma-'+[normName(a),normName(b)].sort().join('-');

function buildUFC(oddsEvents, rohKaempfe, order){
  const built = oddsEvents.map(ev => {
    const best = medianPrices(ev);
    const qa = best[ev.home_team], qb = best[ev.away_team];
    if(!qa || !qb) return null;
    const hit = rohKaempfe.find(f => sameMeeting(f.date, ev.commence_time) && (
      (sameFighter(f.a, ev.home_team) && sameFighter(f.b, ev.away_team)) ||
      (sameFighter(f.a, ev.away_team) && sameFighter(f.b, ev.home_team))));
    let finished=false, winner=null;
    if(hit?.finished){
      finished = true;
      const aIstHeim = sameFighter(hit.a, ev.home_team);
      winner = (aIstHeim ? hit.winner==='A' : hit.winner==='B') ? 'A' : 'B';
    }
    return {
      id:ev._id || mmaId(ev.home_team,ev.away_team), day:1, sport:'mma', source:'mkt',
      start:ev.commence_time, home:ev.home_team, away:ev.away_team, finished,
      ...(winner ? {winner} : {}),
      sides:[
        {key:'A', label:ev.home_team.split(' ').pop(), q:qa},
        {key:'B', label:ev.away_team.split(' ').pop(), q:qb}
      ]
    };
  }).filter(Boolean);

  /* Bereits entschiedene Kämpfe, die ESPN kennt, aber die bei Odds API nicht
     (mehr) gelistet sind (z.B. weil die Karte durch ist und die Wetten
     geschlossen wurden) — rein zur Anzeige/History, KEIN Effekt auf laufendes
     Tippen, deshalb reicht ein neutraler Platzhalter statt einer echten Quote. */
  for(const f of rohKaempfe){
    if(!f.finished) continue;
    const already = built.some(b => sameMeeting(f.date, b.start) && (
      (sameFighter(f.a,b.home) && sameFighter(f.b,b.away)) ||
      (sameFighter(f.a,b.away) && sameFighter(f.b,b.home))));
    if(already) continue;
    const sieger = f.winner==='A' ? f.a : f.b;
    const verlierer = f.winner==='A' ? f.b : f.a;
    /* Seiten so setzen, wie der Kampf beim Tippen geführt wurde — NICHT nach
       Sieger sortieren, sonst drehen sich gespeicherte A/B-Tipps um. Nur wenn
       die ursprüngliche Reihenfolge unbekannt ist, bleibt der alte Notbehelf. */
    const dF = Date.parse(f.date);
    const gef = reihenfolgeFinden(order, f.a, f.b, dF), o = gef && gef.e;
    let home = sieger, away = verlierer, winner = 'A';
    if(o){
      home = sameFighter(o.h, f.a) ? f.a : f.b;
      away = home===f.a ? f.b : f.a;
      winner = sameFighter(home, sieger) ? 'A' : 'B';
    }
    /* Letzte echte Quoten, die der Kampf hatte, bevor er bei der Odds API aus der
       Liste fiel — statt der früheren Platzhalter-Quote 1.01. Unbekannt → null,
       die App zeigt dann einen Strich bzw. die beim Tippen eingefrorene Quote. */
    const qVon = name => {
      if(!o || !o.q) return null;
      const k = Object.keys(o.q).find(n => sameFighter(n, name));
      return k ? o.q[k] : null;
    };
    built.push({
      id: gef ? gef.id : neueId(order, f.a, f.b, dF), day:1, sport:'mma', source:'mkt',
      start:f.date||null, home, away, finished:true, winner,
      fest: !!o,
      sides:[
        {key:'A', label:home.split(' ').pop(), q:qVon(home)},
        {key:'B', label:away.split(' ').pop(), q:qVon(away)}
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

  /* Gedächtnis der letzten Marktquote je Spiel — damit nach dem Anpfiff die
     echte Quote stehen bleibt statt zu verschwinden. */
  let memo = {}, memoGeaendert = false;
  try{ memo = (await kvGet(FB_QUOTES_KEY)) || {}; }catch(e){}
  const merke = (key, out) => { if(out._merken){ memo[key]=out._merken; memoGeaendert=true; } delete out._merken; return out; };

  /* Alle Fußball-Ligen gleichzeitig laden — nacheinander würde das Zeitlimit der
     Funktion bei sechs Ligen schnell knapp. Die Reihenfolge der Antwort bleibt. */
  const fussball = [...LEAGUES.map(L=>({L,intl:false})), ...INTL.map(L=>({L,intl:true}))];
  const fertig = await Promise.all(fussball.map(async ({L,intl}) => {
    try{
      const schedule = intl ? await loadScheduleFD(L.fd) : await loadSchedule(L.ol);
      let events = [];
      try{ events = await loadLeagueOdds(L.odds, schedule, intl); }catch(e){ /* ohne Quoten weiter: "Quote folgt" */ }
      const matches = schedule.map(m => merke(L.id+':'+m.id, buildFootball(m, events, memo[L.id+':'+m.id], intl)));
      return {id:L.id, name:L.name, sport:'fb', matches};
    }catch(e){ return null; }        // ein ausgefallener Wettbewerb reißt die anderen nicht mit
  }));
  fertig.forEach(c => { if(c) competitions.push(c); });

  /* Wettbewerbe aus ESPN (aktuell: Champions League). ESPN liefert Ansetzung,
     Zwischenstand UND Quoten in einem Rutsch — es braucht also weder
     OpenLigaDB noch Odds-API-Guthaben. */
  for(const L of ESPN_LEAGUES){
    try{
      const spiele = await loadEspnSoccer(L.slug, fensterTage());
      if(!spiele.length) continue;
      const matches = spiele.map(m => merke(L.id+':'+m.id, buildEspnFootball(m, memo[L.id+':'+m.id])));
      competitions.push({id:L.id, name:L.name, sport:'fb', matches});
    }catch(e){ /* Champions League fehlt in diesem Aufruf, Rest bleibt nutzbar */ }
  }

  if(memoGeaendert){ try{ quotenGedaechtnisAufraeumen(memo); await kvSet(FB_QUOTES_KEY, memo); }catch(e){} }

  let fights = [];
  try{
    /* Echte Marktquoten von The Odds API — aber nur alle 6h wirklich abgefragt
       (loadOddsCached, siehe oben), damit das Guthaben nicht mehr an die
       Anzahl der Seitenaufrufe gekoppelt ist. Liefert die "mma_mixed_martial_
       arts"-Kategorie gerade nichts (Guthaben erschöpft, noch nichts gelistet,
       o.ä.), gibt es schlicht keine UFC-Karte in dieser Antwort — KEIN
       Platzhalter, KEINE Modellschätzung für offene Kämpfe. */
    const odds = await loadOddsCached('mma_mixed_martial_arts');
    if(odds.length){
      const dateSet = new Set();
      odds.forEach(ev => dateSet.add(espnDate(ev.commence_time)));
      for(let i=0;i<21;i++) dateSet.add(espnDate(Date.now()-i*864e5));
      const rohKaempfe = await loadEspnData(dateSet);

      /* Die "mma_mixed_martial_arts"-Kategorie bei Odds API ist nicht UFC-
         exklusiv — Abgleich gegen ESPNs echte UFC-Paarungen filtert fremde
         Promotions raus, ohne einzelne, noch nicht in ESPNs Kalender
         eingetragene UFC-Kämpfe fälschlich mit rauszuwerfen. */
      const istEchtesUFC = ev => rohKaempfe.some(p =>
        (sameFighter(p.a,ev.home_team)&&sameFighter(p.b,ev.away_team)) ||
        (sameFighter(p.a,ev.away_team)&&sameFighter(p.b,ev.home_team)));
      const proTag = {};
      odds.forEach(ev => { const d=espnDate(ev.commence_time); (proTag[d]=proTag[d]||[]).push(ev); });
      let oddsGefiltert = [];
      Object.values(proTag).forEach(evsAmTag => {
        const treffer = evsAmTag.filter(istEchtesUFC);
        if(treffer.length/evsAmTag.length >= 0.5) oddsGefiltert.push(...treffer);
        else oddsGefiltert.push(...evsAmTag);
      });

      let order = {};
      try{ order = await reihenfolgeLaden(oddsGefiltert, rohKaempfe); }
      catch(e){ /* ohne Register läuft alles wie bisher weiter */ }
      const oddsStabil = oddsGefiltert.map(ev => reihenfolgeAnpassen(ev, order));
      fights = buildUFC(oddsStabil, rohKaempfe, order);
      /* Gelistete Kämpfe sind immer "fest" (Reihenfolge kommt direkt von der Odds API). */
      fights.forEach(f => { if(f.fest===undefined) f.fest = true; });
      try{ if(quotenMerken(order, fights)) await kvSet(ORDER_KEY, order); }catch(e){}
      if(fights.length) competitions.push({id:'ufc', name:'UFC', sport:'mma', matches:fights});
    }
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
