import {KeyboardEvent, useRef, useState} from 'react';
import {matchOutcome} from '../formatters';
import type {Bracket} from '../types';
import {ReportSection} from './shared';

export function Knockout({bracket}: {bracket: Bracket}) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const round = bracket.rounds[selected];
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % bracket.rounds.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + bracket.rounds.length) % bracket.rounds.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = bracket.rounds.length - 1;
    else return;
    event.preventDefault(); setSelected(next); refs.current[next]?.focus();
  };
  const champion = bracket.champion;
  return <ReportSection id="bracket" title="Knockout rounds" subtitle="Select a round, then expand a series for its complete game evidence.">
    <div className="champion"><span>Champion</span><strong>{champion.champion.species}</strong><small>Group {champion.champion.group}, rank {champion.champion.rank}; advanced from {champion.champion.sourceSeriesId} into {champion.finalSeriesId}; {champion.resolution} after {champion.gamesPlayed} games.</small></div>
    <div className="tabs" role="tablist" aria-label="Knockout rounds">{bracket.rounds.map((item, index) => <button key={item.round} ref={node => { refs.current[index] = node; }} id={`round-tab-${index}`} role="tab" type="button" aria-selected={selected === index} aria-controls={`round-panel-${index}`} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => onKey(event, index)}>{item.round.toUpperCase()}</button>)}</div>
    <article id={`round-panel-${selected}`} className="tab-panel round" role="tabpanel" aria-labelledby={`round-tab-${selected}`}>
      <div className="section-heading"><h3>{round.round.toUpperCase()}</h3><p>{round.series.length} series · {round.series.reduce((sum, item) => sum + item.games.length, 0)} games</p></div>
      {round.series.map(series => <details className="series" key={series.seriesId}><summary><strong className="series-score">{series.evaluation.entrant1Wins}–{series.evaluation.entrant2Wins}</strong><span><span className={series.evaluation.winner.speciesId === series.entrant1.speciesId ? 'winner' : 'loser'}>{series.entrant1.species}</span> vs <span className={series.evaluation.winner.speciesId === series.entrant2.speciesId ? 'winner' : 'loser'}>{series.entrant2.species}</span></span><span className="series-winner">{series.evaluation.winner.species} advances</span><code title={series.seriesId}>{series.seriesId}</code></summary>
        <p>{series.evaluation.gamesPlayed} games · {series.evaluation.draws} draws · {series.evaluation.resolution}</p>
        {series.evaluation.lotteryHash && <p><strong>Series lottery hash:</strong> <code className="truncate" title={series.evaluation.lotteryHash}>{series.evaluation.lotteryHash}</code></p>}
        <div className="table-wrap"><table><thead><tr><th>Game</th><th>Match ID</th><th>Participant 1</th><th>Participant 2</th><th>Seed</th><th>Game outcome / game winner</th><th>Turns</th><th>Termination</th><th>Protocol hash</th></tr></thead><tbody>{series.games.map(game => <tr key={game.matchId}><td>{game.gameNumber}</td><td><code className="truncate" title={game.matchId}>{game.matchId}</code></td><td>{game.pokemon1}</td><td>{game.pokemon2}</td><td><code className="truncate" title={game.seed.join(', ')}>{game.seed.join(', ')}</code></td><td>{matchOutcome(game).evidence}</td><td>{game.turns}</td><td>{game.termination}</td><td><code className="truncate" title={game.protocolHash}>{game.protocolHash}</code></td></tr>)}</tbody></table></div>
      </details>)}
    </article>
  </ReportSection>;
}
