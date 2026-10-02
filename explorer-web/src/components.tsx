import type {ReactNode} from 'react';

export function LoadingState({label = 'Loading completed runs…'}: {label?: string}) {
  return <div className="state-card" role="status"><span className="spinner" />{label}</div>;
}

export function EmptyState() {
  return (
    <div className="state-card empty-state">
      <span className="state-icon">◇</span>
      <h2>No completed runs yet</h2>
      <p>The explorer lists a run only after every canonical artifact passes strict completion validation.</p>
    </div>
  );
}

export function ErrorState({message, retry}: {message: string; retry: () => void}) {
  return (
    <div className="state-card error-state" role="alert">
      <span className="state-icon">!</span>
      <h2>Could not load tournament data</h2>
      <p>{message}</p>
      <button className="button" onClick={retry}>Try again</button>
    </div>
  );
}

export function Section({id, eyebrow, title, children}: {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="panel section-block">
      <div className="section-heading"><div><p>{eyebrow}</p><h2>{title}</h2></div></div>
      {children}
    </section>
  );
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatDuration(startedAt: string, completedAt: string) {
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`]
    .filter(Boolean)
    .join(' ');
}
