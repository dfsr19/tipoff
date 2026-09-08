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
const LEAGUES = ['bl1', 'bl2', 'bl3', 'ucl'];

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
