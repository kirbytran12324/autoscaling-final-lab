'use strict';

const {formatNumber, escapeHtml} = require('./formatters');
const {hashField, sectionHeading, backToTop} = require('./ui');

function renderGame(game) {
  const winner = game.outcome === 'tie' ? 'Draw' : game.winnerSpecies;
  return `<tr><td>${formatNumber(game.gameNumber)}</td>` +
    `<td>${hashField(game.matchId, 'Match ID')}</td>` +
    `<td>${escapeHtml(game.pokemon1)}</td><td>${escapeHtml(game.pokemon2)}</td>` +
    `<td>${hashField(game.seed.join(', '), 'Battle seed')}</td>` +
    `<td>${escapeHtml(game.outcome)} / ${escapeHtml(winner)}</td>` +
    `<td>${formatNumber(game.turns)}</td><td>${escapeHtml(game.termination)}</td>` +
    `<td>${hashField(game.protocolHash, 'Protocol hash')}</td></tr>`;
}

function roundCounts(round) {
  return {
    series: round.series.length,
    games: round.series.reduce((total, series) => total + series.games.length, 0),
  };
}

function renderRound(round, index) {
  const counts = roundCounts(round);
  const series = round.series.map(item => {
    const evaluation = item.evaluation;
    const lottery = evaluation.lotteryHash === null
      ? ''
      : `<p><strong>Series lottery hash:</strong> ` +
        `${hashField(evaluation.lotteryHash, 'Series lottery hash')}</p>`;
    const entrant1Class = evaluation.winner.species === item.entrant1.species ? 'winner' : 'loser';
    const entrant2Class = evaluation.winner.species === item.entrant2.species ? 'winner' : 'loser';
    return `<details class="series"><summary>` +
      `<strong class="series-score">${formatNumber(evaluation.entrant1Wins)}–` +
      `${formatNumber(evaluation.entrant2Wins)}</strong>` +
      `<span><span class="${entrant1Class}">${escapeHtml(item.entrant1.species)}</span> vs ` +
      `<span class="${entrant2Class}">${escapeHtml(item.entrant2.species)}</span></span>` +
      `<span class="series-winner">${escapeHtml(evaluation.winner.species)} advances</span>` +
      `<code title="${escapeHtml(item.seriesId)}">${escapeHtml(item.seriesId)}</code></summary>` +
      `<p>${formatNumber(evaluation.gamesPlayed)} games · ` +
      `${formatNumber(evaluation.draws)} draws · ${escapeHtml(evaluation.resolution)}</p>${lottery}` +
      `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Match ID</th>` +
      `<th>Participant 1</th><th>Participant 2</th><th>Seed</th>` +
      `<th>Game outcome / game winner</th><th>Turns</th><th>Termination</th>` +
      `<th>Protocol hash</th></tr></thead><tbody>` +
      `${item.games.map(renderGame).join('')}</tbody></table></div></details>`;
  }).join('');
  return `<article id="round-panel-${index}" class="tab-panel round" role="tabpanel" ` +
    `aria-labelledby="round-tab-${index}" data-round-index="${index}"` +
    `${index === 0 ? '' : ' hidden'}><div class="section-heading"><h3>` +
    `${escapeHtml(round.round.toUpperCase())}</h3><p>${formatNumber(counts.series)} series · ` +
    `${formatNumber(counts.games)} games</p></div>${series}</article>`;
}

function renderBracket(bracket) {
  const champion = bracket.champion;
  const tabs = bracket.rounds.map((round, index) =>
    `<button id="round-tab-${index}" role="tab" type="button" ` +
    `aria-selected="${index === 0}" aria-controls="round-panel-${index}" ` +
    `tabindex="${index === 0 ? 0 : -1}" data-round-index="${index}">` +
    `${escapeHtml(round.round.toUpperCase())}</button>`
  ).join('');
  return `<section id="bracket">${sectionHeading('Knockout rounds',
    'Select a round, then expand a series for its complete game evidence.')}` +
    `<div class="champion"><span>Champion</span>` +
    `<strong>${escapeHtml(champion.champion.species)}</strong>` +
    `<small>Group ${escapeHtml(champion.champion.group)}, rank ` +
    `${formatNumber(champion.champion.rank)}; advanced from ` +
    `${escapeHtml(champion.champion.sourceSeriesId)} into ` +
    `${escapeHtml(champion.finalSeriesId)}; ${escapeHtml(champion.resolution)} after ` +
    `${formatNumber(champion.gamesPlayed)} games.</small></div>` +
    `<div class="tabs" role="tablist" aria-label="Knockout rounds">${tabs}</div>` +
    `${bracket.rounds.map(renderRound).join('')}${backToTop()}</section>`;
}

module.exports = {renderGame, roundCounts, renderRound, renderBracket};
