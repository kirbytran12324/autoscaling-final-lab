'use strict';

const {stageForResult} = require('./attribution');
const {SIMULATION_COLUMNS, SIMULATION_PAGE_SIZE} = require('./constants');
const {sectionHeading, pageSizeOptions, backToTop} = require('./ui');
const {formatNumber, escapeHtml} = require('./formatters');

function simulationData(data) {
  return data.results.map(result => {
    const group = data.groupByMatchId.get(result.matchId);
    const roundMatch = /^(r\d+)-/.exec(result.matchId);
    return {
      matchId: result.matchId,
      stage: stageForResult(data, result),
      group: group || '',
      round: roundMatch === null ? '' : roundMatch[1],
      pokemon1: result.pokemon1,
      pokemon2: result.pokemon2,
      result: result.outcome,
      winnerSide: result.winnerSide,
      winner: result.winnerSpecies || 'Draw',
      turns: result.turns,
      termination: result.termination,
      servedBy: result.servedBy,
      durationMs: result.durationMs,
      seed: result.seed,
      simulatorVersion: result.simulatorVersion,
      protocolHash: result.protocolHash,
    };
  }).sort((left, right) => left.matchId.localeCompare(right.matchId));
}

function simulationPayload(rows) {
  return {
    schemaVersion: 1,
    shared: {simulatorVersion: rows[0]?.simulatorVersion || ''},
    columns: SIMULATION_COLUMNS,
    rows: rows.map(row => SIMULATION_COLUMNS.map(column => row[column])),
  };
}

function renderSimulationTable(data, simulations) {
  const pods = [...new Set(data.results.map(result => result.servedBy).filter(Boolean))].sort();
  const stages = [...new Set(simulations.map(row => row.stage))].sort();
  return `<section id="simulations">${sectionHeading('Battle explorer',
    'Filter accepted battles, then select a row to inspect its complete record.')}` +
    `<details id="simulation-explorer" class="disclosure"><summary>` +
    `Search and browse ${formatNumber(data.uniqueResultCount)} accepted simulations</summary>` +
    `<div class="table-toolbar" aria-label="Battle explorer controls">` +
    `<label class="grow">Search <input id="sim-search" type="search" ` +
    `placeholder="Match ID or species" autocomplete="off"></label>` +
    `<label>Stage <select id="sim-stage"><option value="">All</option>` +
    stages.map(stage => `<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`).join('') +
    `</select></label><label>Result <select id="sim-result"><option value="">All</option>` +
    `<option value="win">Win</option><option value="tie">Tie</option></select></label>` +
    `<label>Reported hostname <select id="sim-pod"><option value="">All</option>` +
    pods.map(pod => `<option value="${escapeHtml(pod)}">${escapeHtml(pod)}</option>`).join('') +
    `</select></label><label>Rows <select id="sim-page-size">` +
    `${pageSizeOptions(SIMULATION_PAGE_SIZE)}</select></label>` +
    `<button id="sim-reset" type="button">Reset filters</button>` +
    `<output id="sim-count" aria-live="polite">Expand to load.</output>` +
    `<div class="pager"><button id="sim-prev" type="button">Previous</button>` +
    `<span id="sim-page" aria-live="polite"></span>` +
    `<button id="sim-next" type="button">Next</button></div></div>` +
    `<div class="explorer-layout"><div class="table-wrap large-table-wrap"><table id="simulation-table" ` +
    `class="data-table primary-sticky selectable-table"><thead><tr>` +
    `<th data-sort="matchId">Match ID</th><th data-sort="stage">Stage</th>` +
    `<th data-sort="pokemon1">Matchup</th>` +
    `<th data-sort="result">Result</th><th data-sort="winner">Winner</th>` +
    `<th data-sort="turns">Turns</th></tr></thead><tbody></tbody></table></div>` +
    `<aside id="sim-detail" class="record-detail" aria-live="polite">` +
    `<p>Select a battle to view the complete accepted record.</p></aside></div>` +
    `<p class="note">Only the selected page is rendered. Filtering and sorting still ` +
    `operate locally on every embedded accepted record.</p></details>${backToTop()}</section>`;
}

module.exports = {simulationData, simulationPayload, renderSimulationTable};
