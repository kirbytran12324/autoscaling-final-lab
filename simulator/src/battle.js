'use strict';

const {createHash} = require('node:crypto');
const {BattleStream} = require('pokemon-showdown');
const {getBaseSpecies} = require('./catalog');

function makeTeam(speciesName) {
  const species = getBaseSpecies(speciesName);

  return [{
    name: species.name,
    species: species.name,
    ability: species.abilities[0],
    item: '',
    moves: ['Metronome'],
    nature: 'Serious',
    evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
    ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
    level: 100,
    gender: species.gender || 'M',
    happiness: 255,
  }];
}

async function simulateBattle({
  pokemon1,
  pokemon2,
  seed,
  maxTurns = 100,
}) {
  if (
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 10_000
  ) {
    throw new RangeError(
      'maxTurns must be an integer from 1 through 10000'
    );
  }

  // Validate both species before starting the stream.
  const p1Team = makeTeam(pokemon1);
  const p2Team = makeTeam(pokemon2);

  const stream = new BattleStream();
  const protocolHash = createHash('sha256');

  let currentTurn = 0;
  let completedTurns = 0;
  let capped = false;
  let protocolLineCount = 0;

  const completedBattle = (async () => {
    for await (const chunk of stream) {
      const [type, ...parts] = chunk.split('\n');

      if (type === 'update') {
        for (const line of parts) {
          if (line.startsWith('|t:|')) continue;

          if (line.startsWith('|turn|')) {
            currentTurn = Number(
              line.slice('|turn|'.length)
            );
          }

          if (line === '|upkeep') {
            completedTurns = currentTurn;
          }

          protocolHash.update(line);
          protocolHash.update('\n');
          protocolLineCount++;
        }

        if (
          !capped &&
          completedTurns >= maxTurns &&
          parts.includes('|upkeep')
        ) {
          capped = true;
          await stream.write('>forcetie');
        }
      }

      if (type === 'sideupdate' && !capped) {
        const [side, ...lines] = parts;
        const requestLine = lines.find(line =>
          line.startsWith('|request|')
        );

        if (!requestLine) continue;

        const request = JSON.parse(
          requestLine.slice('|request|'.length)
        );

        if (request.teamPreview) {
          await stream.write(`>${side} team 1`);
        } else if (request.active) {
          await stream.write(`>${side} move 1`);
        }
      }

      if (type === 'end') {
        const result = JSON.parse(parts.join('\n'));
        const winnerSide =
          result.winner === 'p1' || result.winner === 'p2'
            ? result.winner
            : null;

        return {
          outcome: winnerSide ? 'win' : 'tie',
          winnerSide,
          winnerSpecies: winnerSide === 'p1'
            ? p1Team[0].species
            : winnerSide === 'p2'
              ? p2Team[0].species
              : null,
          turns: capped ? completedTurns : result.turns,
          seed: [...seed],
          termination: capped ? 'turn-cap' : 'natural',
          protocolHash: protocolHash.digest('hex'),
          protocolLineCount,
        };
      }
    }

    throw new Error('Battle stream ended without a result');
  })();

  await stream.write(
    `>start ${JSON.stringify({
      formatid: 'gen9customgame',
      seed,
    })}`
  );

  await stream.write(
    `>player p1 ${JSON.stringify({
      name: 'p1',
      team: p1Team,
    })}`
  );

  await stream.write(
    `>player p2 ${JSON.stringify({
      name: 'p2',
      team: p2Team,
    })}`
  );

  return completedBattle;
}

module.exports = {makeTeam, simulateBattle};
