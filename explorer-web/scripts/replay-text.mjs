// pokemon-showdown@0.11.11 uses [PLACEHOLDER]; the pinned client uses {PLACEHOLDER}.
// This adapts rendering data only. It never modifies the battle or its protocol.
export function normalizeReplayText(input) {
  const text = structuredClone(input);
  for (const name of ['startBattle', 'tieBattle']) {
    let trainer = 0;
    text.Default.default[name] = text.Default.default[name].replace(/\[TRAINER\]/g, () => `{TRAINER${++trainer}}`);
  }
  const visit = value => {
    if (typeof value === 'string') return value.replace(/\[([A-Z][A-Z0-9]*)\]/g, '{$1}');
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  const normalized = visit(text);
  for (const [table, field] of [['StatNames', 'statName'], ['StatMediumNames', 'statName'], ['StatShortNames', 'statShortName']]) {
    normalized[table] = Object.fromEntries(Object.entries(normalized.Default)
      .filter(([, entry]) => typeof entry.statName === 'string').map(([id, entry]) => [id, entry[field] || entry.statName]));
  }
  return normalized;
}
