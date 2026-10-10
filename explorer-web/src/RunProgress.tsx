import {useState} from 'react';
import {PokemonName} from './PokemonName';
import type {ControlRun} from './control-api';

export function RunProgress({run}: {run: ControlRun}) {
  const [group, setGroup] = useState('');
  const standings = run.snapshot?.standings;
  const selected = standings?.groups.find(item => item.group === group) || standings?.groups[0];
  return <>
    <div className="control-metrics"><p>Accepted battles <strong>{run.progress?.acceptedResultCount.toLocaleString() ?? 'Waiting'}</strong></p>
      <p>Stage <strong>{run.progress?.stage || 'Waiting'} {run.progress?.round || ''}</strong></p></div>
    <section><h2>Recent battle events</h2>
      <p>Updated every three seconds. Accepted battles are saved before they appear here.</p>
      <ol className="battle-events">{run.snapshot?.events?.filter(event => event.type === 'battle-accepted').slice(-20).reverse().map(event =>
        <li key={`${event.at}-${event.matchId}`}><code>{event.matchId}</code> · {event.pokemon1} vs {event.pokemon2} · {event.outcome} · {event.turns} turns</li>)}</ol>
      {!run.snapshot && <p>Live details will return when a runner is available. The last saved progress remains above.</p>}
    </section>
    {standings && <section><h2>{standings.status === 'final' ? 'Group standings' : 'Preliminary group standings'}</h2>
      <p>Snapshot from {new Date(standings.updatedAt).toLocaleTimeString()}. Rankings may change until the group stage finishes.</p>
      <label>Group <select value={selected?.group || ''} onChange={event => setGroup(event.target.value)}>
        {standings.groups.map(item => <option key={item.group}>{item.group}</option>)}
      </select></label>
      <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Pokémon</th><th>Played</th><th>Points</th></tr></thead>
        <tbody>{selected?.standings.map(item => <tr key={item.speciesId}><td>{item.rank}</td>
          <td><PokemonName name={item.species} speciesId={item.speciesId} /></td><td>{item.played}</td><td>{item.points}</td></tr>)}</tbody></table></div>
    </section>}
    {run.snapshot?.bracket && <section><h2>Knockout bracket</h2>
      {run.snapshot.bracket.rounds.map(round => <details key={round.round} open><summary>{round.round}</summary>
        <ul>{round.series.map(series => <li key={series.seriesId}>
          <PokemonName name={series.entrant1.species} compact /> vs <PokemonName name={series.entrant2.species} compact />
          {series.evaluation && <span> · {series.evaluation.entrant1Wins ?? 0}–{series.evaluation.entrant2Wins ?? 0}
            {series.evaluation.winner && ` · ${series.evaluation.winner.species} advances`}</span>}
        </li>)}</ul></details>)}
      <p>The bracket snapshot updates at round boundaries.</p>
    </section>}
  </>;
}
