import {expect, test} from 'vitest';
// @ts-expect-error Maintenance helper is JavaScript with no generated declarations.
import {normalizeReplayText} from '../scripts/replay-text.mjs';

test('older simulator templates become current placeholders without changing protocol-style text', () => {
  const text = {Default: {default: {startBattle: '[TRAINER] and [TRAINER]', tieBattle: '[TRAINER] / [TRAINER]',
    winBattle: '[TRAINER] won!', move: '[POKEMON] used [MOVE]!'}, spe: {statName: 'Speed'}},
  Moves: {example: {message: '[POKEMON] [ITEM] [from]'}}};
  const normalized = normalizeReplayText(text);
  expect(normalized.Default.default.startBattle).toBe('{TRAINER1} and {TRAINER2}');
  expect(normalized.Default.default.winBattle).toBe('{TRAINER} won!');
  expect(normalized.Moves.example.message).toBe('{POKEMON} {ITEM} [from]');
  expect(normalized.StatNames.spe).toBe('Speed');
  expect(text.Default.default.startBattle).toBe('[TRAINER] and [TRAINER]');
});
