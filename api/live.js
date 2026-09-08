/**
 * api/live.js — Vercel Serverless Function (Live-Zwischenstände)
 *
 * WARUM ES DIESE ZWEITE FUNKTION GIBT:
 * api/data.js fragt bei jedem Aufruf auch die Odds API nach Quoten — und die
 * kostet Guthaben (5 Credits pro Aufruf, bei 500 im Monat also nur 100 Aufrufe).
 * Während eines laufenden Spiels soll die App aber im Minutentakt nachschauen,
 * ob ein Tor gefallen ist. Über api/data.js wäre das Monatsguthaben nach zwei
 * Spielen aufgebraucht.
 *
 * Diese Funktion fragt deshalb AUSSCHLIESSLICH OpenLigaDB ab — kostenlos und
 * ohne Schlüssel. Sie liefert nur das, was sich während eines Spiels ändert:
 * Zwischenstand, Spielminute und ob das Spiel vorbei ist. Quoten braucht es
 * dafür nicht, die stehen beim Tippen ohnehin schon fest.
 *
 * Antwort:
 *   { updated: "...", live: { "ol12345": {score:{h,a}, minute, finished}, ... } }
 */

const SEASON = process.env.SEASON || '2026';

/**
 * ESPN-Anbindung — direkt in dieser Datei statt als Import (siehe data.js
 * für den Grund: ein fehlgeschlagener Import einer Hilfsdatei hat die
 * gesamte Funktion mit FUNCTION_INVOCATION_FAILED abstürzen lassen)
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

/* Nur die Bundesligen kommen aus OpenLigaDB. Die Champions League wird weiter
   unten über ESPN geholt — der OpenLigaDB-Eintrag für 2026/27 enthält nur
   Platzhalter-Daten (identische Anstoßzeiten, falsche Paarungen) und wäre für
   einen Live-Ticker unbrauchbar. */
const LEAGUES = ['bl1', 'bl2', 'bl3'];

/* Endstand — nur wenn das Spiel wirklich abgeschlossen ist. */
function endResult(m){
  if(!m.matchIsFinished) return null;
  const rs = m.matchResults || [];
  const r = rs.find(x => x.resultTypeID === 2) || rs[rs.length-1];
  if(!r) return null;
  const h = Number(r.pointsTeam1), a = Number(r.pointsTeam2);
  if(!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return {h, a};
}

/* Zwischenstand eines gerade laufenden Spiels. OpenLigaDB trägt Tore einzeln
   ein — der aktuelle Stand ist der Stand nach dem zuletzt gefallenen Tor.
   Kein Tor eingetragen, aber angepfiffen: dann steht es 0:0.
   Zeitfenster (angepfiffen, höchstens 3,5 Std. her) verhindert, dass ein Spiel
   ewig als "läuft" gilt, falls es niemand als beendet markiert. */
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const live = {};
  const jetzt = Date.now();

  /* Champions League über ESPN — dieselbe Quelle wie in api/data.js, damit
     die Spiel-Ids zusammenpassen. Nur der heutige und der gestrige Tag: mehr
     braucht ein Live-Ticker nicht, und es hält die Antwort schnell. */
  try{
    const clSpiele = await loadEspnSoccer('uefa.champions',
      [espnDay(jetzt - 864e5), espnDay(jetzt)]);
    for(const m of clSpiele){
      if(m.finished && m.score) live[m.id] = {score:m.score, finished:true};
      else if(m.live && m.liveScore)
        live[m.id] = {score:m.liveScore, minute:m.minute ?? null, finished:false};
    }
  }catch(e){ /* CL fehlt in diesem Aufruf, Bundesligen laufen weiter */ }

  for(const L of LEAGUES){
    try{
      const r = await fetch(`https://api.openligadb.de/getmatchdata/${L}/${SEASON}`);
      if(!r.ok) continue;
      const rows = await r.json();
      if(!Array.isArray(rows)) continue;
      for(const m of rows){
        const start = new Date(m.matchDateTime).getTime();
        /* Nur Spiele im relevanten Zeitfenster mitschicken — alles andere
           ändert sich gerade ohnehin nicht und würde die Antwort aufblähen. */
        if(!Number.isFinite(start)) continue;
        if(start > jetzt || jetzt - start > 6*3600e3) continue;

        const score = endResult(m);
        if(score){
          live['ol'+m.matchID] = {score, finished:true};
          continue;
        }
        const lv = liveInfo(m);
        if(lv) live['ol'+m.matchID] = {score:lv.score, minute:lv.minute, finished:false};
      }
    }catch(e){ /* eine ausgefallene Liga reißt die anderen nicht mit */ }
  }

  /* Kurz zwischengespeichert: schauen mehrere Leute gleichzeitig zu, fragt
     trotzdem nur einer wirklich bei OpenLigaDB nach. 25 Sekunden sind kurz
     genug, dass ein Tor spürbar schnell ankommt. */
  res.setHeader('Cache-Control', 'public, s-maxage=25, stale-while-revalidate=15');
  res.status(200).json({updated:new Date().toISOString(), live});
}
