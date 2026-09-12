import { EvaluationSummary } from "./statistics.js";
import { RunEvent } from "../run/events.js";
import { GameResult } from "../tournaments/game-runner.js";

export interface BenchmarkReportInput {
  title: string;
  evaluation: EvaluationSummary;
  config: Record<string, unknown>;
  games: GameResult[];
  events: RunEvent[];
  generatedAt?: string;
}
export function benchmarkReport(input: BenchmarkReportInput): string {
  const timelineMap = new Map<string, unknown[]>();
  for (const event of input.events)
    if (
      event.gameId &&
      [
        "game_started",
        "decision_accepted",
        "state_transition",
        "game_completed",
        "game_failed",
        "game_forfeited",
      ].includes(event.type)
    ) {
      const entries = timelineMap.get(event.gameId) ?? [];
      entries.push({
        type: event.type,
        timestamp: event.timestamp,
        seat: event.seat,
        turn: event.turn,
        actionId: event.actionId,
        beforeStateHash: event.beforeStateHash,
        afterStateHash: event.afterStateHash,
        status: event.status,
      });
      timelineMap.set(event.gameId, entries);
    }
  const timelines = Object.fromEntries(timelineMap);
  const data = safeJson({
    title: input.title,
    evaluation: input.evaluation,
    config: publicConfig(input.config),
    games: input.games.map((game) => ({
      id: game.id,
      seed: game.seed,
      fellowship: game.fellowship,
      sauron: game.sauron,
      outcome: game.outcome,
      winner: game.winner,
      actions: game.actions,
      durationMs: game.durationMs,
      totalCost: game.totalCost,
      error: game.error,
    })),
    timelines,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Benchmark Report</title><style>:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#172033;--muted:#65708a;--line:#dce1ec;--accent:#2855d9;--good:#087f5b;--bad:#b4233b}@media(prefers-color-scheme:dark){:root{--bg:#10131b;--card:#191e2a;--ink:#e8edf8;--muted:#aab5ca;--line:#30394b;--accent:#8fa8ff;--good:#52d6aa;--bad:#ff899d}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:20px;align-items:start}h1{margin:0;font-size:clamp(1.8rem,4vw,3rem)}h2{font-size:1.1rem;margin:0 0 14px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:22px 0}.card,section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.metric{font-size:1.8rem;font-weight:700}.bar{height:10px;background:var(--line);border-radius:8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-size:.8rem;text-transform:uppercase}button,input{font:inherit}button{color:var(--accent);background:none;border:1px solid var(--line);border-radius:6px;padding:5px;cursor:pointer}.scroll{overflow:auto}.timeline{white-space:pre-wrap;font:12px ui-monospace,monospace;max-height:260px;overflow:auto}details{margin-top:10px}.status{font-weight:700}.failed{color:var(--bad)}.completed{color:var(--good)}@media(max-width:600px){main{padding:15px}header{display:block}th:nth-child(3),td:nth-child(3){display:none}}@media print{body{background:#fff;color:#000}.card,section{break-inside:avoid;box-shadow:none}button,input{display:none}}</style></head><body><main><header><div><p class="muted">Offline benchmark dossier</p><h1 id="title"></h1><p id="meta" class="muted"></p></div><a href="events.jsonl">Canonical event log</a></header><div id="cards" class="grid"></div><section><h2>Leaderboard And Confidence</h2><div id="leaderboard" class="scroll"></div></section><div class="grid"><section><h2>Cost Versus Performance</h2><div id="cost"></div></section><section><h2>Latency And Reliability</h2><div id="reliability"></div></section><section><h2>Seat Bias</h2><div id="seat"></div></section></div><section><h2>Head-to-Head Matrix</h2><div id="matrix" class="scroll"></div></section><section><h2>Victory Types, Tokens, And Costs</h2><div id="totals"></div></section><section><h2>Paired Seed Analysis</h2><div id="paired"></div></section><section><h2>Games</h2><label>Filter games <input id="filter" type="search" placeholder="agent, seed, outcome"></label><div id="games" class="scroll"></div></section><section><h2>Reproducibility Metadata</h2><pre id="config" class="timeline"></pre></section></main><script>const data=${data};const $=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n},table=(heads,rows)=>{const t=el('table'),h=el('thead'),r=el('tr');heads.forEach(x=>r.append(el('th',x)));h.append(r);t.append(h);const b=el('tbody');rows.forEach(row=>{const tr=el('tr');row.forEach(x=>tr.append(el('td',x)));b.append(tr)});t.append(b);return t};const pct=x=>x==null?'n/a':(x*100).toFixed(1)+'%';$('title').textContent=data.title;$('meta').textContent='Generated '+data.generatedAt+' | evaluation schema v'+data.evaluation.evaluationSchemaVersion;const c=data.evaluation.counts;$('cards').append(...[['Completed',c.completed],['Wins / draws',c.wins+' / '+c.draws],['Failures / forfeits',c.failures+' / '+c.forfeits],['Incomplete pairs',data.evaluation.paired.incompletePairs.length]].map(([a,b])=>{const d=el('div');d.className='card';d.append(el('div',a),Object.assign(el('div',b),{className:'metric'}));return d}));const ci=data.evaluation.winRate.wilson95;$('leaderboard').append(table(['Metric','Estimate','95% CI'],[['Win rate',pct(data.evaluation.winRate.rate),ci?pct(ci[0])+' - '+pct(ci[1]):'n/a'],['Draw rate',pct(data.evaluation.drawRate.rate),data.evaluation.drawRate.wilson95?data.evaluation.drawRate.wilson95.map(pct).join(' - '):'n/a']]));const costs=data.evaluation.costs;$('cost').append(el('p','Cost data '+(costs.missingCostEvents?'partially unavailable / estimated':'available')+'.'),el('p','Total: $'+costs.total.toFixed(4)+' | per win: '+(costs.perWin==null?'n/a':'$'+costs.perWin.toFixed(4))));const l=data.evaluation.latencyMs;$('reliability').append(el('p','Latency ms: median '+(l.median??'n/a')+', p95 '+(l.p95??'n/a')+', p99 '+(l.p99??'n/a')),el('p','Retries '+pct(data.evaluation.errorRates.retry.rate)+' | timeouts '+pct(data.evaluation.errorRates.timeout.rate)+' | provider errors '+pct(data.evaluation.errorRates.providerError.rate)));$('seat').append(table(['Seat','Wins','Losses','Draws'],Object.entries(data.evaluation.bySeat).map(([k,v])=>[k,v.wins,v.losses,v.draws])));$('matrix').append(table(['Fellowship','Sauron','Games','F wins','S wins','Draws'],data.evaluation.headToHead.map(x=>[x.fellowship,x.sauron,x.games,x.fellowshipWins,x.sauronWins,x.draws])));$('totals').append(el('p','Victory types: '+Object.entries(data.evaluation.byVictoryType).map(([k,v])=>k+'='+v).join(', ')||'n/a'),el('p','Tokens input/output/total: '+[data.evaluation.tokens.input,data.evaluation.tokens.output,data.evaluation.tokens.total].join(' / ')+'; missing usage '+data.evaluation.tokens.missingUsageEvents));$('paired').append(el('p','Complete pairs: '+data.evaluation.paired.completePairs+'. Incomplete: '+(data.evaluation.paired.incompletePairs.join(', ')||'none')),el('p',data.evaluation.methodology.pairedComparison));function renderGames(){const q=$('filter').value.toLowerCase(),rows=data.games.filter(g=>JSON.stringify(g).toLowerCase().includes(q)).map(g=>{const d=el('details');d.append(el('summary','Timeline'));d.append(el('div',JSON.stringify(data.timelines[g.id]||[],null,2)));d.lastChild.className='timeline';const cell=el('div');cell.append(d);return [g.id,g.seed,g.fellowship+' vs '+g.sauron,g.outcome,g.actions,cell]});const wrap=$('games');wrap.replaceChildren(table(['Game','Seed','Seats','Outcome','Actions','Replay'],rows))}$('filter').addEventListener('input',renderGames);renderGames();$('config').textContent=JSON.stringify(data.config,null,2);</script></body></html>`;
}
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
function publicConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(config);
  for (const key of Object.keys(copy))
    if (/key|token|authorization|secret/i.test(key)) delete copy[key];
  return copy;
}
