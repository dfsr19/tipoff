// sync.js — holt Spielplan + Quoten und schreibt sie in data.json

const KEY = process.env.ODDS_API_KEY;

/* ── Poisson-Modell: aus Siegwette werden Ergebnisquoten ── */
function poisson(k,l){let f=1;for(let i=2;i<=k;i++)f*=i;return Math.exp(-l)*Math.pow(l,k)/f;}
function scoreMatrix(lh,la,max=6){const m=[];for(let i=0;i<=max;i++){m[i]=[];for(let j=0;j<=max;j++)m[i][j]=poisson(i,lh)*poisson(j,la);}return m;}
function probs1X2(m){let h=0,d=0,a=0;m.forEach((row,i)=>row.forEach((p,j)=>{i>j?h+=p:i<j?a+=p:d+=p;}));const s=h+d+a;return{h:h/s,d:d/s,a:a/s};}
function devig(qs){const raw=qs.map(q=>1/q),s=raw.reduce((a,b)=>a+b,0);return raw.map(r=>r/s);}
function fitLambdas(pH,pD,pA){let best=[1.3,1.2],err=1e9;
  for(let lh=0.3;lh<=3.6;lh+=0.05)for(let la=0.25;la<=3.2;la+=0.05){
    const p=probs1X2(scoreMatrix(lh,la,6));const e=(p.h-pH)**2+(p.d-pD)**2+(p.a-pA)**2;
    if(e<err){err=e;best=[lh,la];}}
  return best;}
const price=(p,vig)=>Math.max(1.01,Math.round((1-vig)/p*100)/100);
const norm=s=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'');
const fuzzy=(a,b)=>{const x=norm(a),y=norm(b);return x.includes(y)||y.includes(x);};

/* ── Spielplan von OpenLigaDB (kostenlos, kein Schlüssel) ── */
async function loadSchedule(){
  const r=await fetch('https://api.openligadb.de/getmatchdata/bl1/2026');
  const rows=await r.json();
  return rows.map(m=>({
    id:'ol'+m.matchID, day:m.group.groupOrderID, start:m.matchDateTime,
    home:m.team1.teamName, away:m.team2.teamName
  }));
}

/* ── Quoten von The Odds API ── */
async function loadOdds(sportKey){
  if(!KEY) return [];
  const u=new URLSearchParams({apiKey:KEY,regions:'eu',markets:'h2h',oddsFormat:'decimal'});
  const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?${u}`);
  if(!r.ok) return [];
  return r.json();
}
function bestPrices(ev){
  const best={};
  (ev.bookmakers||[]).forEach(b=>(b.markets?.find(m=>m.key==='h2h')?.outcomes||[])
    .forEach(o=>{if(!best[o.name]||o.price>best[o.name])best[o.name]=o.price;}));
  return best;
}

/* ── Fußball: Quoten zuordnen + Ergebniswette herleiten ── */
function buildFootball(match, oddsEvents){
  const ev=oddsEvents.find(e=>fuzzy(match.home,e.home_team)&&fuzzy(match.away,e.away_team));
  let sides, exact=[], source;
  if(ev){
    const best=bestPrices(ev);
    const h=best[ev.home_team], d=best['Draw'], a=best[ev.away_team];
    if(h&&d&&a){
      sides=[{key:'1',label:'1',q:h},{key:'X',label:'X',q:d},{key:'2',label:'2',q:a}];
      const [lh,la]=fitLambdas(...devig([h,d,a]));
      const m=scoreMatrix(lh,la,6);
      for(let i=0;i<=3;i++)for(let j=0;j<=3;j++)
        exact.push({key:`${i}:${j}`,label:`${i}:${j}`,q:price(m[i][j],0.16)});
      source='mkt';
    }
  }
  if(!sides){ sides=[{key:'1',label:'1',q:2.5},{key:'X',label:'X',q:3.3},{key:'2',label:'2',q:2.8}]; source='mdl'; }
  return {...match, sport:'fb', sides, exact, source};
}

/* ── UFC: direkt aus der Odds API ── */
function buildUFC(oddsEvents){
  return oddsEvents.map((ev,i)=>{
    const best=bestPrices(ev);
    return {
      id:'mma'+i, sport:'mma', start:ev.commence_time,
      home:ev.home_team, away:ev.away_team, source:'mkt',
      sides:[
        {key:'A',label:ev.home_team.split(' ').pop(),q:best[ev.home_team]||2},
        {key:'B',label:ev.away_team.split(' ').pop(),q:best[ev.away_team]||2}
      ]
    };
  });
}

/* ── Alles zusammenführen und speichern ── */
(async()=>{
  const schedule = await loadSchedule();
  const buliOdds = await loadOdds('soccer_germany_bundesliga');
  const ufcOdds  = await loadOdds('mma_mixed_martial_arts');

  const matches = schedule.map(m=>buildFootball(m,buliOdds));
  const fights  = buildUFC(ufcOdds);

  const out = { updated:new Date().toISOString(), matches, fights };
  require('fs').writeFileSync('data.json', JSON.stringify(out));
  console.log(`Fertig: ${matches.length} Spiele, ${fights.length} Kämpfe`);
})();
