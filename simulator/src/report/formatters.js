'use strict';



function isValidIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

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

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(2).replace(/\.00$/, '')} s`;
  }
  let seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 || hours > 0 ? `${minutes}m` : '',
    `${seconds}s`,
  ].filter(Boolean).join(' ');
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(percent * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

module.exports = {isValidIsoTimestamp, escapeHtml, embeddedJson, formatNumber, formatDuration, percentile};
