'use strict';

const {isValidIsoTimestamp} = (() => {
  function valid(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }
  return {isValidIsoTimestamp: valid};
})();

const PAGE_SIZE = 100;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function embeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'Unavailable';
  if (milliseconds < 1000) return `${milliseconds.toFixed(0)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining.toFixed(1)}s`;
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(percent * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

function metric(label, value, detail = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span>` +
    `<strong>${escapeHtml(value)}</strong>` +
    (detail === '' ? '' : `<small>${escapeHtml(detail)}</small>`) + '</div>';
}

function renderSummary(data) {
  const {metadata, roster, results, bracket} = data;
  const elapsedMs = Date.parse(metadata.completedAt) - Date.parse(metadata.startedAt);
  return `<section id="summary"><h2>Run summary</h2><div class="metric-grid">${[
    metric('Run ID', metadata.runId),
    metric('Mode', metadata.mode, metadata.mode === 'sample'
      ? 'Accepted 32-species validation mode'
      : 'Required 1,025-species tournament'),
    metric('Tournament seed', metadata.tournamentSeed),
    metric('Started', metadata.startedAt),
    metric('Completed', metadata.completedAt),
    metric('Elapsed', formatDuration(elapsedMs)),
    metric('Rules version', metadata.rulesVersion),
    metric('Simulator version', metadata.simulatorVersion),
    metric('Simulator image', metadata.simulatorImage),
    metric('Runner concurrency', metadata.runnerConcurrency),
    metric('Entrants', roster.entrants.length),
    metric('Accepted results', results.length),
    metric('Champion', bracket.champion.champion.species,
      `${bracket.champion.finalSeriesId} · ${bracket.champion.resolution}`),
  ].join('')}</div></section>`;
}

function renderIntegrity(data) {
  const {metadata, results, failures, checkpoint, standings, bracket} = data;
  const expectedTotal = data.expectedGroupResultCount +
    results.filter(result => !result.matchId.startsWith('group-')).length;
  return `<section id="integrity"><h2>Integrity and reproducibility</h2>` +
    `<div class="metric-grid">${[
      metric('Roster hash', data.roster.rosterHash, data.rosterHashVerified ? 'Verified' : 'Invalid'),
      metric('Expected accepted results', expectedTotal),
      metric('Accepted result records', data.uniqueResultCount),
      metric('Unique match IDs', data.uniqueResultCount, 'Authoritative accepted set'),
      metric('Duplicate match IDs', data.duplicateMatchIdCount,
        data.duplicateMatchIdCount === 0 ? 'Check passed' : 'Identical deterministic duplicates'),
      metric('Terminal failures', failures.length),
      metric('Final checkpoint', `${checkpoint.stage} / ${checkpoint.round}`,
        `${checkpoint.acceptedResultCount} accepted`),
      metric('Standings status', standings.status),
      metric('Bracket status', bracket.status),
    ].join('')}</div>` +
    `<div class="callout"><strong>Reproducibility boundary.</strong> ` +
    `Match identity, participants, seed, simulator version, outcome, winner, turns, ` +
    `termination, and protocol hash are deterministic result fields. ` +
    `<code>servedBy</code> and <code>durationMs</code> are operational observations ` +
    `and may differ when an identical battle is executed again. Rules: ` +
    `${escapeHtml(metadata.rulesVersion)}.</div></section>`;
}

function renderStandings(standings) {
  return `<section id="standings"><h2>Group standings</h2>` +
    standings.groups.map(group => {
      const rows = group.standings.map(entry => {
        const advancing = entry.rank <= standings.advancingCount;
        const cutoff = entry.rank === standings.advancingCount
          ? ' cutoff-row'
          : '';
        return `<tr class="${advancing ? 'advancing' : ''}${cutoff}">` +
          `<td>${entry.rank}</td><td>${escapeHtml(entry.species)}</td>` +
          `<td>${entry.played}</td><td>${entry.wins}</td><td>${entry.draws}</td>` +
          `<td>${entry.losses}</td><td>${entry.points}</td>` +
          `<td>${entry.miniTablePoints}</td><td>${entry.sonnebornBerger}</td>` +
          `<td><code>${escapeHtml(entry.tieKey)}</code></td></tr>`;
      }).join('');
      return `<article class="group"><h3>Group ${escapeHtml(group.group)}</h3>` +
        `<p>${group.completedMatches} / ${group.expectedMatches} matches · ` +
        `top ${standings.advancingCount} advance</p><div class="table-wrap">` +
        `<table><thead><tr><th>Rank</th><th>Species</th><th>P</th><th>W</th>` +
        `<th>D</th><th>L</th><th>Pts</th><th>Mini pts</th><th>SB</th>` +
        `<th>Tie key</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
    }).join('') + '</section>';
}

function renderGame(game) {
  const winner = game.outcome === 'tie' ? 'Draw' : game.winnerSpecies;
  return `<tr><td>${game.gameNumber}</td><td><code>${escapeHtml(game.matchId)}</code></td>` +
    `<td>${escapeHtml(game.pokemon1)}</td><td>${escapeHtml(game.pokemon2)}</td>` +
    `<td><code>${escapeHtml(game.seed.join(', '))}</code></td>` +
    `<td>${escapeHtml(game.outcome)} / ${escapeHtml(winner)}</td>` +
    `<td>${game.turns}</td><td>${escapeHtml(game.termination)}</td>` +
    `<td><code>${escapeHtml(game.protocolHash)}</code></td></tr>`;
}

function renderBracket(bracket) {
  const champion = bracket.champion;
  const rounds = bracket.rounds.map(round => `<article class="round">` +
    `<h3>${escapeHtml(round.round.toUpperCase())}</h3>` +
    round.series.map(series => {
      const evaluation = series.evaluation;
      const winner = evaluation.winner.species;
      const lottery = evaluation.lotteryHash === null
        ? ''
        : `<p><strong>Lottery hash:</strong> <code>${escapeHtml(evaluation.lotteryHash)}</code></p>`;
      return `<details class="series"><summary>` +
        `<span>${escapeHtml(series.seriesId)}</span>` +
        `<span>${escapeHtml(series.entrant1.species)} vs ${escapeHtml(series.entrant2.species)}</span>` +
        `<strong>${escapeHtml(winner)}</strong></summary>` +
        `<p>${evaluation.gamesPlayed} games · ${evaluation.entrant1Wins}–` +
        `${evaluation.entrant2Wins} decisive wins · ${evaluation.draws} draws · ` +
        `${escapeHtml(evaluation.resolution)}</p>${lottery}` +
        `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Match ID</th>` +
        `<th>Participant 1</th><th>Participant 2</th><th>Seed</th>` +
        `<th>Outcome / winner</th><th>Turns</th><th>Termination</th>` +
        `<th>Protocol hash</th></tr></thead><tbody>` +
        series.games.map(renderGame).join('') + '</tbody></table></div></details>';
    }).join('') + '</article>').join('');
  return `<section id="bracket"><h2>Knockout bracket and series</h2>` +
    `<div class="champion"><span>Champion</span><strong>${escapeHtml(champion.champion.species)}</strong>` +
    `<small>Group ${escapeHtml(champion.champion.group)}, rank ${champion.champion.rank}; ` +
    `advanced from ${escapeHtml(champion.champion.sourceSeriesId)} into ` +
    `${escapeHtml(champion.finalSeriesId)}; ${escapeHtml(champion.resolution)} ` +
    `after ${champion.gamesPlayed} games.</small></div>` + rounds + '</section>';
}

function operationalStats(results, failures, metadata) {
  const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
  const servedBy = {};
  for (const result of results) servedBy[result.servedBy] = (servedBy[result.servedBy] || 0) + 1;
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  return {
    elapsedMs: Date.parse(metadata.completedAt) - Date.parse(metadata.startedAt),
    durations: {
      min: durations[0],
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.at(-1),
      mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    },
    wins: results.filter(result => result.outcome === 'win').length,
    draws: results.filter(result => result.outcome === 'tie').length,
    turnCaps: results.filter(result => result.termination === 'turn-cap').length,
    terminalFailures: failures.length,
    servedBy,
    slowest,
  };
}

function renderOperations(data) {
  const stats = operationalStats(data.results, data.failures, data.metadata);
  const podRows = Object.entries(stats.servedBy)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([pod, count]) => `<tr><td>${escapeHtml(pod)}</td><td>${count}</td></tr>`)
    .join('');
  const slowRows = stats.slowest.map(result => `<tr>` +
    `<td><code>${escapeHtml(result.matchId)}</code></td>` +
    `<td>${escapeHtml(result.pokemon1)} vs ${escapeHtml(result.pokemon2)}</td>` +
    `<td>${formatDuration(result.durationMs)}</td><td>${result.turns}</td>` +
    `<td>${escapeHtml(result.servedBy)}</td></tr>`).join('');
  return `<section id="operations"><h2>Operational summary</h2>` +
    `<div class="metric-grid">${[
      metric('Tournament elapsed', formatDuration(stats.elapsedMs)),
      metric('Wins', stats.wins),
      metric('Draws', stats.draws),
      metric('Turn-cap terminations', stats.turnCaps),
      metric('Terminal failures', stats.terminalFailures),
      metric('Minimum battle duration', formatDuration(stats.durations.min)),
      metric('Mean battle duration', formatDuration(stats.durations.mean)),
      metric('Median battle duration', formatDuration(stats.durations.median)),
      metric('p95 battle duration', formatDuration(stats.durations.p95)),
      metric('p99 battle duration', formatDuration(stats.durations.p99)),
      metric('Maximum battle duration', formatDuration(stats.durations.max)),
    ].join('')}</div><div class="split"><div><h3>Requests by simulator Pod</h3>` +
    `<table><thead><tr><th>servedBy</th><th>Count</th></tr></thead><tbody>${podRows}</tbody></table></div>` +
    `<div><h3>Slowest simulations</h3><div class="table-wrap"><table><thead><tr>` +
    `<th>Match ID</th><th>Participants</th><th>Duration</th><th>Turns</th><th>Pod</th>` +
    `</tr></thead><tbody>${slowRows}</tbody></table></div></div></div></section>`;
}

function renderRestart(evidence) {
  if (evidence.status === 'absent') {
    return `<section id="restart"><h2>Restart/resume validation</h2>` +
      `<div class="placeholder">Restart/resume evidence not supplied.</div></section>`;
  }
  if (evidence.status === 'incompatible') {
    return `<section id="restart"><h2>Restart/resume validation</h2>` +
      `<div class="placeholder">Restart/resume evidence not supplied: ` +
      `${escapeHtml(evidence.reason)}.</div></section>`;
  }
  return `<section id="restart"><h2>Restart/resume validation</h2>` +
    `<div class="metric-grid">${[
      metric('Interruption checkpoint',
        `${evidence.checkpoint.stage} / ${evidence.checkpoint.acceptedResultCount} accepted`),
      metric('Original Pod', evidence.firstPod, evidence.firstPodUid),
      metric('Replacement Pod', evidence.replacementPod, evidence.replacementPodUid),
      metric('Final harness status', evidence.finalStatus),
      metric('Duplicate accepted match IDs', evidence.duplicateMatchIdCount,
        `${evidence.uniqueResultCount} unique results validated from artifacts`),
    ].join('')}</div></section>`;
}

function renderAutoscaling(evidence) {
  if (evidence.status === 'absent') {
    return `<section id="autoscaling"><h2>Autoscaling evidence</h2>` +
      `<div class="placeholder">Pending Phase 7 — no HPA acceptance evidence was supplied for this report generation.</div></section>`;
  }
  if (evidence.status === 'incompatible') {
    return `<section id="autoscaling"><h2>Autoscaling evidence</h2>` +
      `<div class="placeholder">Supplied autoscaling evidence is incompatible: ` +
      `${escapeHtml(evidence.reason)}. No chart was rendered.</div></section>`;
  }
  return `<section id="autoscaling"><h2>Autoscaling evidence</h2>` +
    `<p>Offline aligned timeline from ${escapeHtml(evidence.source)}. Each series uses its own normalized scale; raw values remain embedded in the report.</p>` +
    `<canvas id="autoscaling-chart" width="1200" height="420" aria-label="Autoscaling timeline chart"></canvas>` +
    `<div class="legend"><span class="replicas">Replicas</span><span class="rate">Request rate</span>` +
    `<span class="latency">p95 latency</span><span class="failures">Failures</span></div></section>`;
}

function simulationData(data) {
  return data.results.map(result => {
    const group = data.groupByMatchId.get(result.matchId);
    const roundMatch = /^(r\d+)-/.exec(result.matchId);
    return {
      matchId: result.matchId,
      stage: group === undefined ? 'knockout' : 'group',
      group: group || '',
      round: roundMatch === null ? '' : roundMatch[1],
      pokemon1: result.pokemon1,
      pokemon2: result.pokemon2,
      result: result.outcome,
      winner: result.winnerSpecies || 'Draw',
      turns: result.turns,
      termination: result.termination,
      servedBy: result.servedBy,
      durationMs: result.durationMs,
      seed: result.seed.join(', '),
      protocolHash: result.protocolHash,
    };
  });
}

function renderSimulationTable(data) {
  const pods = [...new Set(data.results.map(result => result.servedBy))].sort();
  return `<section id="simulations"><h2>Simulation explorer</h2>` +
    `<div class="filters"><label>Search match ID or species <input id="sim-search" type="search"></label>` +
    `<label>Stage <select id="sim-stage"><option value="">All</option><option value="group">Group</option>` +
    `<option value="knockout">Knockout</option></select></label>` +
    `<label>Result <select id="sim-result"><option value="">All</option><option value="win">Win</option>` +
    `<option value="tie">Tie</option></select></label>` +
    `<label>Simulator Pod <select id="sim-pod"><option value="">All</option>` +
    pods.map(pod => `<option value="${escapeHtml(pod)}">${escapeHtml(pod)}</option>`).join('') +
    `</select></label></div><p id="sim-count"></p><div class="table-wrap"><table id="simulation-table">` +
    `<thead><tr><th data-sort="matchId">Match ID</th><th data-sort="stage">Stage</th>` +
    `<th data-sort="pokemon1">Participant 1</th><th data-sort="pokemon2">Participant 2</th>` +
    `<th data-sort="result">Result</th><th data-sort="winner">Winner</th>` +
    `<th data-sort="turns">Turns</th><th data-sort="termination">Termination</th>` +
    `<th data-sort="servedBy">Pod</th><th data-sort="durationMs">Duration (ms)</th>` +
    `</tr></thead><tbody></tbody></table></div><div class="pager">` +
    `<button id="sim-prev" type="button">Previous</button><span id="sim-page"></span>` +
    `<button id="sim-next" type="button">Next</button></div>` +
    `<p class="note">At most ${PAGE_SIZE} rows are added to the document at once; filtering and sorting operate on the embedded authoritative dataset.</p></section>`;
}

function renderMetadata(data, generatedAt) {
  return `<section id="metadata"><h2>Metadata and limitations</h2><dl>` +
    `<dt>Generated at</dt><dd>${escapeHtml(generatedAt)}</dd>` +
    `<dt>Source artifacts</dt><dd>${data.sourceFiles.map(escapeHtml).join(', ')}</dd>` +
    `<dt>Authority</dt><dd><code>results.jsonl</code> remains authoritative for accepted simulations; this HTML is derived and regenerable.</dd>` +
    `<dt>Tournament scope</dt><dd>${data.metadata.mode === 'sample'
      ? 'This is sample mode: a 32-species pipeline validation, not the required full 1,025-species tournament.'
      : 'This is the required full 1,025-species tournament.'}</dd>` +
    `<dt>Report behavior</dt><dd>Read-only and self-contained. It makes no network requests and modifies no tournament artifact.</dd>` +
    `<dt>Limitations</dt><dd>Operational Pod and duration values are observations, not deterministic replay fields. Optional evidence appears only when explicitly supplied.</dd>` +
    `</dl></section>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#09111f;--panel:#111d30;--panel2:#16243a;--ink:#e8eef8;--muted:#9cadc4;--accent:#62d6c5;--gold:#f3c969;--line:#2a3b55;--danger:#ef7d8d}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#18304d 0,transparent 35%),var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}header,main,footer{max-width:1440px;margin:auto;padding:24px}header{padding-top:54px}h1{font-size:clamp(2rem,5vw,4.5rem);line-height:1;margin:.2em 0}h1 span{color:var(--accent)}h2{margin:0 0 18px;font-size:1.65rem}h3{margin:22px 0 8px}p{color:var(--muted)}nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}nav a{color:var(--ink);text-decoration:none;background:var(--panel);border:1px solid var(--line);padding:7px 11px;border-radius:99px}section{background:rgba(17,29,48,.94);border:1px solid var(--line);border-radius:16px;padding:24px;margin:18px 0;box-shadow:0 16px 48px #0004}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.metric{background:var(--panel2);border-left:3px solid var(--accent);padding:13px;border-radius:8px;min-width:0}.metric span,.metric small{display:block;color:var(--muted)}.metric strong{display:block;font-size:1.08rem;overflow-wrap:anywhere}.metric small{font-size:.78rem}.callout,.placeholder{margin-top:18px;padding:16px;border-radius:9px;background:#0a1526;border:1px solid var(--line)}.placeholder{border-style:dashed;color:var(--muted)}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;color:#bbf4e9}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;white-space:nowrap}th{color:var(--accent);position:sticky;top:0;background:var(--panel);z-index:1}tr.advancing{background:#163a37}.cutoff-row td{border-bottom:3px solid var(--gold)}details.series{background:#0c1728;border:1px solid var(--line);border-radius:9px;margin:8px 0;padding:10px}summary{cursor:pointer;display:grid;grid-template-columns:160px 1fr 1fr;gap:12px}summary strong{color:var(--gold)}.champion{display:flex;flex-direction:column;align-items:center;text-align:center;padding:24px;margin:10px 0 24px;background:linear-gradient(130deg,#473b17,#182943);border-radius:14px}.champion strong{font-size:2.4rem;color:var(--gold)}.champion small{color:var(--muted)}.split{display:grid;grid-template-columns:minmax(240px,1fr) minmax(0,2fr);gap:20px}.filters{display:flex;gap:12px;flex-wrap:wrap}.filters label{color:var(--muted)}input,select,button{display:block;margin-top:5px;background:#081321;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px}th[data-sort]{cursor:pointer}.pager{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:14px}.pager span{min-width:100px;text-align:center}.note{font-size:.85rem}dl{display:grid;grid-template-columns:180px 1fr;gap:8px 20px}dt{font-weight:700;color:var(--accent)}dd{margin:0;color:var(--muted)}canvas{width:100%;height:auto;background:#091525;border:1px solid var(--line);border-radius:8px}.legend{display:flex;gap:22px;flex-wrap:wrap;margin-top:10px}.legend span:before{content:"";display:inline-block;width:18px;height:3px;margin:0 6px 3px 0;background:currentColor}.replicas{color:#62d6c5}.rate{color:#f3c969}.latency{color:#9c8cff}.failures{color:#ef7d8d}footer{color:var(--muted);text-align:center}@media(max-width:760px){header,main{padding:16px}.split{grid-template-columns:1fr}summary{grid-template-columns:1fr}dl{grid-template-columns:1fr}section{padding:16px}}`;

const SCRIPT = `
'use strict';
const simulations=JSON.parse(document.getElementById('simulation-data').textContent);
const pageSize=100;let page=0;let sortKey='matchId';let sortDirection=1;let filtered=[];
const tbody=document.querySelector('#simulation-table tbody');
const controls={search:document.getElementById('sim-search'),stage:document.getElementById('sim-stage'),result:document.getElementById('sim-result'),pod:document.getElementById('sim-pod')};
function compare(a,b){const left=a[sortKey],right=b[sortKey];return (typeof left==='number'?left-right:String(left).localeCompare(String(right)))*sortDirection}
function applyFilters(){const query=controls.search.value.trim().toLowerCase();filtered=simulations.filter(row=>(!query||row.matchId.toLowerCase().includes(query)||row.pokemon1.toLowerCase().includes(query)||row.pokemon2.toLowerCase().includes(query))&&(!controls.stage.value||row.stage===controls.stage.value)&&(!controls.result.value||row.result===controls.result.value)&&(!controls.pod.value||row.servedBy===controls.pod.value)).sort(compare);page=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1));render()}
function cell(row,value){const td=document.createElement('td');td.textContent=value;row.append(td)}
function render(){tbody.replaceChildren();const start=page*pageSize;for(const item of filtered.slice(start,start+pageSize)){const row=document.createElement('tr');cell(row,item.matchId);cell(row,item.group?('Group '+item.group):item.round.toUpperCase());cell(row,item.pokemon1);cell(row,item.pokemon2);cell(row,item.result);cell(row,item.winner);cell(row,item.turns);cell(row,item.termination);cell(row,item.servedBy);cell(row,item.durationMs);tbody.append(row)}const pages=Math.max(1,Math.ceil(filtered.length/pageSize));document.getElementById('sim-count').textContent=filtered.length+' simulations match';document.getElementById('sim-page').textContent='Page '+(page+1)+' of '+pages;document.getElementById('sim-prev').disabled=page===0;document.getElementById('sim-next').disabled=page>=pages-1}
for(const control of Object.values(controls))control.addEventListener('input',()=>{page=0;applyFilters()});
document.querySelectorAll('th[data-sort]').forEach(header=>header.addEventListener('click',()=>{const next=header.dataset.sort;if(sortKey===next)sortDirection*=-1;else{sortKey=next;sortDirection=1}applyFilters()}));
document.getElementById('sim-prev').addEventListener('click',()=>{if(page>0){page--;render()}});document.getElementById('sim-next').addEventListener('click',()=>{if((page+1)*pageSize<filtered.length){page++;render()}});applyFilters();
const timelineElement=document.getElementById('autoscaling-data');
if(timelineElement){const rows=JSON.parse(timelineElement.textContent);const canvas=document.getElementById('autoscaling-chart');const context=canvas.getContext('2d');const fields=[['replicas','#62d6c5'],['requestRate','#f3c969'],['latency','#9c8cff'],['failures','#ef7d8d']];context.lineWidth=2;context.font='13px system-ui';context.fillStyle='#9cadc4';context.fillText(rows[0].timestamp,20,400);context.textAlign='right';context.fillText(rows.at(-1).timestamp,1180,400);for(const [field,color] of fields){const values=rows.map(row=>row[field]);const min=Math.min(...values),max=Math.max(...values),span=max-min||1;context.beginPath();context.strokeStyle=color;rows.forEach((row,index)=>{const x=20+index*(1160/(rows.length-1||1));const y=370-(row[field]-min)/span*330;if(index===0)context.moveTo(x,y);else context.lineTo(x,y)});context.stroke()}}
`;

function renderReport(data, options = {}) {
  const generatedAt = options.generatedAt === undefined
    ? new Date().toISOString()
    : options.generatedAt;
  if (!isValidIsoTimestamp(generatedAt)) {
    throw new TypeError('Report generation timestamp must be a valid ISO timestamp');
  }
  const simulations = simulationData(data);
  const autoscalingData = options.autoscalingEvidence.status === 'supplied'
    ? `<script id="autoscaling-data" type="application/json">${embeddedJson(options.autoscalingEvidence.rows)}</script>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><title>${escapeHtml(data.metadata.runId)} tournament report</title>` +
    `<style>${CSS}</style></head><body><header><p>METRONOME TOURNAMENT / OFFLINE REPORT</p>` +
    `<h1>${escapeHtml(data.metadata.runId)}<br><span>${escapeHtml(data.bracket.champion.champion.species)}</span></h1>` +
    `<nav><a href="#summary">Summary</a><a href="#integrity">Integrity</a>` +
    `<a href="#standings">Standings</a><a href="#bracket">Bracket</a>` +
    `<a href="#simulations">Simulations</a><a href="#operations">Operations</a>` +
    `<a href="#restart">Restart</a><a href="#autoscaling">Autoscaling</a></nav></header><main>` +
    renderSummary(data) + renderIntegrity(data) + renderStandings(data.standings) +
    renderBracket(data.bracket) + renderSimulationTable(data) + renderOperations(data) +
    renderRestart(options.restartEvidence) + renderAutoscaling(options.autoscalingEvidence) +
    renderMetadata(data, generatedAt) + `</main><footer>Derived report · ${escapeHtml(generatedAt)}</footer>` +
    `<script id="simulation-data" type="application/json">${embeddedJson(simulations)}</script>` +
    autoscalingData + `<script>${SCRIPT}</script></body></html>\n`;
}

module.exports = {
  PAGE_SIZE,
  escapeHtml,
  renderReport,
};
