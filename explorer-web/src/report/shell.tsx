import {KeyboardEvent, useEffect, useState} from 'react';
import type {Bracket, RunDetail} from '../types';
import {BackToRuns} from './shared';
import {Summary, Verification} from './summary';
import {Standings} from './standings';
import {Knockout} from './knockout';
import {BattleExplorer} from './battles';
import {PodAttribution} from './pods';
import {RunDetails} from './details';

export function useActiveSection(sectionIds: string[]) {
  const [active, setActive] = useState(sectionIds[0]);
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const visible = new Map<Element, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      const current = [...visible].sort((left, right) => right[1] - left[1])[0];
      if (current?.[1] > 0) setActive((current[0] as HTMLElement).id);
    }, {rootMargin: '-118px 0px -55% 0px', threshold: [0, .1, .25, .5]});
    sectionIds.map(id => document.getElementById(id)).filter(Boolean).forEach(item => observer.observe(item!));
    return () => observer.disconnect();
  }, [sectionIds.join('|')]);
  return active;
}

export function SectionNavigation({hasPods}: {hasPods: boolean}) {
  const links = [
    ['summary', 'Summary'], ['integrity', 'Verify'], ['standings', 'Groups'],
    ['bracket', 'Rounds'], ['simulations', 'Battles'],
    ...(hasPods ? [['pod-attribution', 'Pod attribution']] : []), ['details', 'Run details'],
  ];
  const active = useActiveSection(links.map(([id]) => id));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const anchors = [...event.currentTarget.querySelectorAll('a')];
    const index = anchors.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? anchors.length - 1 :
      event.key === 'ArrowRight' ? (index + 1) % anchors.length : (index - 1 + anchors.length) % anchors.length;
    anchors[next].focus();
  };
  return <nav className="section-nav" aria-label="Report sections" onKeyDown={onKeyDown}>
    {links.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'location' : undefined}>{label}</a>)}
  </nav>;
}

export default function ReportView({run, bracket, goHome}: {
  run: RunDetail; bracket: Bracket; goHome: () => void;
}) {
  const hasPods = run.report.podAttribution.distinctHostnameCount > 0;
  return <div className="report-page">
    <header className="application-header"><div className="app-identity"><span className="app-mark">M</span><span><strong>METRONOME</strong><small>Tournament explorer</small></span></div><div className="app-actions">{run.hasReport && <a className="report-download" href={`/api/runs/${encodeURIComponent(run.runId)}/report`} download>Download offline report <span aria-hidden="true">↓</span></a>}<BackToRuns goHome={goHome} /></div></header>
    <header id="top" className="report-header">
      <p>Metronome tournament · completed-run explorer</p>
      <h1>{run.runId}</h1>
      <p className="champion-line">Champion <strong>{run.champion.species}</strong></p>
    </header>
    <SectionNavigation hasPods={hasPods} />
    <main>
      <Summary run={run} />
      <Verification run={run} />
      <Standings runId={run.runId} />
      <Knockout bracket={bracket} />
      <BattleExplorer run={run} />
      {hasPods && <PodAttribution run={run} />}
      <RunDetails run={run} />
    </main>
    <footer>Read-only projection · canonical tournament artifacts remain authoritative</footer>
  </div>;
}
