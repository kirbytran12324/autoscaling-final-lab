'use strict';

const {STANDINGS_PAGE_SIZE} = require('./constants');
const {paginateRows, hashField, sectionHeading, pageSizeOptions, backToTop} = require('./ui');
const {formatNumber, escapeHtml} = require('./formatters');

function paginateStandings(group, query, requestedPage, pageSize = STANDINGS_PAGE_SIZE) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
  const entries = group.standings.filter(entry =>
    normalizedQuery === '' || entry.species.toLocaleLowerCase('en-US').includes(normalizedQuery)
  );
  return paginateRows(entries, requestedPage, pageSize);
}

function standingRow(entry, advancingCount) {
  const classes = [
    entry.rank <= advancingCount ? 'advancing' : '',
    entry.rank === advancingCount ? 'cutoff-row' : '',
  ].filter(Boolean).join(' ');
  return `<tr${classes === '' ? '' : ` class="${classes}"`}>` +
    `<td>${formatNumber(entry.rank)}</td><td>${escapeHtml(entry.species)}</td>` +
    `<td>${formatNumber(entry.played)}</td><td>${formatNumber(entry.wins)}</td>` +
    `<td>${formatNumber(entry.draws)}</td><td>${formatNumber(entry.losses)}</td>` +
    `<td>${formatNumber(entry.points)}</td><td>${formatNumber(entry.miniTablePoints)}</td>` +
    `<td>${formatNumber(entry.sonnebornBerger)}</td>` +
    `<td>${hashField(entry.tieKey, `${entry.species} tie key`)}</td></tr>`;
}

function renderStandings(standings) {
  const tabs = standings.groups.map((group, index) =>
    `<button id="standings-tab-${index}" role="tab" type="button" ` +
    `aria-selected="${index === 0}" aria-controls="standings-panel-${index}" ` +
    `tabindex="${index === 0 ? 0 : -1}" data-group-index="${index}">` +
    `Group ${escapeHtml(group.group)}</button>`
  ).join('');
  const panels = standings.groups.map((group, index) => {
    const initial = paginateStandings(group, '', 0, STANDINGS_PAGE_SIZE);
    const rows = index === 0 ? initial.entries.map(entry =>
      standingRow(entry, standings.advancingCount)
    ).join('') : '';
    return `<article id="standings-panel-${index}" class="tab-panel" role="tabpanel" ` +
      `aria-labelledby="standings-tab-${index}" data-group-index="${index}"` +
      `${index === 0 ? '' : ' hidden'}><div class="section-heading"><h3>` +
      `Group ${escapeHtml(group.group)}</h3><p>${formatNumber(group.completedMatches)} / ` +
      `${formatNumber(group.expectedMatches)} matches · top ` +
      `${formatNumber(standings.advancingCount)} advance</p></div>` +
      `<div class="table-wrap large-table-wrap"><table class="data-table primary-sticky"><thead><tr>` +
      `<th>Rank</th><th>Species</th><th>P</th><th>W</th>` +
      `<th>D</th><th>L</th><th>Pts</th><th>Mini pts</th><th>SB</th>` +
      `<th>Tie key</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('');
  return `<section id="standings">${sectionHeading('Group standings',
    'Compare placement and advancement while keeping the full field searchable.')}` +
    `<div class="table-toolbar" aria-label="Standings controls">` +
    `<label class="grow">Search <input id="standings-search" type="search" ` +
    `placeholder="Pokémon name" autocomplete="off"></label>` +
    `<label>Rows <select id="standings-page-size">` +
    `${pageSizeOptions(STANDINGS_PAGE_SIZE)}</select></label>` +
    `<output id="standings-count" aria-live="polite"></output>` +
    `<div class="pager"><button id="standings-prev" type="button">Previous</button>` +
    `<span id="standings-page" aria-live="polite"></span>` +
    `<button id="standings-next" type="button">Next</button></div></div>` +
    `<div class="tabs" role="tablist" aria-label="Tournament groups">${tabs}</div>` +
    `${panels}<p class="note">Standings contain every entrant from the validated artifact. ` +
    `Only the selected page is rendered.</p>${backToTop()}</section>`;
}

module.exports = {paginateStandings, standingRow, renderStandings};
