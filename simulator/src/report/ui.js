'use strict';

const {formatNumber, escapeHtml} = require('./formatters');
const {PAGE_SIZE_OPTIONS} = require('./constants');

function metric(label, value, detail = '', classes = '') {
  const renderedValue = typeof value === 'number' ? formatNumber(value) : value;
  return `<div class="metric${classes === '' ? '' : ` ${classes}`}">` +
    `<span>${escapeHtml(label)}</span><strong>${escapeHtml(renderedValue)}</strong>` +
    (detail === '' ? '' : `<small>${escapeHtml(detail)}</small>`) + '</div>';
}

function hashField(value, label) {
  return `<code class="hash-value truncate" title="${escapeHtml(value)}" ` +
    `aria-label="${escapeHtml(label)}">${escapeHtml(value)}</code>`;
}

function sectionHeading(title, subtitle) {
  return `<div class="section-title"><h2>${escapeHtml(title)}</h2>` +
    `<p>${escapeHtml(subtitle)}</p></div>`;
}

function backToTop() {
  return '<a class="back-top" href="#top">Back to top <span aria-hidden="true">↑</span></a>';
}

function pageSizeOptions(selected = 25) {
  return PAGE_SIZE_OPTIONS.map(size => `<option value="${size}"` +
    `${size === selected ? ' selected' : ''}>${size}</option>`).join('');
}

function paginateRows(rows, requestedPage, pageSize) {
  const validPageSize = PAGE_SIZE_OPTIONS.includes(Number(pageSize)) ? Number(pageSize) : 25;
  const pageCount = Math.max(1, Math.ceil(rows.length / validPageSize));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  return {
    entries: rows.slice(page * validPageSize, (page + 1) * validPageSize),
    matchCount: rows.length,
    page,
    pageCount,
    pageSize: validPageSize,
  };
}

module.exports = {metric, hashField, sectionHeading, backToTop, pageSizeOptions, paginateRows};
