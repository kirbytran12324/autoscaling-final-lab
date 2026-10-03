'use strict';

const {isValidIsoTimestamp, escapeHtml, embeddedJson} = require('./formatters');
const {simulationData, renderSimulationTable, simulationPayload} = require('./simulations');
const {renderPodAttribution} = require('./attribution');
const {CSS, SCRIPT} = require('./assets');
const {renderSummary, renderIntegrity} = require('./summary');
const {renderStandings} = require('./standings');
const {renderBracket} = require('./bracket');
const {renderRunDetails} = require('./details');

function renderReport(data, options = {}) {
  const generatedAt = options.generatedAt === undefined
    ? new Date().toISOString()
    : options.generatedAt;
  if (!isValidIsoTimestamp(generatedAt)) {
    throw new TypeError('Report generation timestamp must be a valid ISO timestamp');
  }
  const simulations = simulationData(data);
  const podAttribution = renderPodAttribution(data);
  const podNavigation = podAttribution === ''
    ? ''
    : `<a href="#pod-attribution">Pod attribution</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark">` +
    `<title>${escapeHtml(data.metadata.runId)} tournament report</title>` +
    `<style>${CSS}</style></head><body><header id="top" class="report-header">` +
    `<p>Metronome tournament · offline report</p>` +
    `<h1>${escapeHtml(data.metadata.runId)}</h1>` +
    `<p class="champion-line">Champion <strong>` +
    `${escapeHtml(data.bracket.champion.champion.species)}</strong></p></header>` +
    `<nav class="section-nav" aria-label="Report sections">` +
    `<a href="#summary">Summary</a><a href="#integrity">Verify</a>` +
    `<a href="#standings">Groups</a><a href="#bracket">Rounds</a>` +
    `<a href="#simulations">Battles</a>${podNavigation}` +
    `<a href="#details">Run details</a></nav><main>` +
    renderSummary(data) + renderIntegrity(data) + renderStandings(data.standings) +
    renderBracket(data.bracket) + renderSimulationTable(data, simulations) +
    podAttribution + renderRunDetails(data, generatedAt) +
    `</main><footer>Derived report · ${escapeHtml(generatedAt)}</footer>` +
    `<script id="standings-data" type="application/json">` +
    `${embeddedJson(data.standings)}</script>` +
    `<script id="simulation-data" type="application/json">` +
    `${embeddedJson(simulationPayload(simulations))}</script>` +
    `<script>${SCRIPT}</script></body></html>\n`;
}

module.exports = {renderReport};
