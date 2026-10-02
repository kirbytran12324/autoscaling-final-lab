import {ReactNode, useState} from 'react';

export function SectionTitle({title, subtitle}: {title: string; subtitle: string}) {
  return <div className="section-title"><h2>{title}</h2><p>{subtitle}</p></div>;
}

export function ReportSection({id, title, subtitle, children, back = true}: {
  id: string; title: string; subtitle: string; children: ReactNode; back?: boolean;
}) {
  return <section id={id}><SectionTitle title={title} subtitle={subtitle} />{children}
    {back && <a className="back-top" href="#top">Back to top <span aria-hidden="true">↑</span></a>}
  </section>;
}

export function Metric({label, value, detail, className = ''}: {
  label: string; value: ReactNode; detail?: ReactNode; className?: string;
}) {
  return <div className={`metric ${className}`.trim()}><span>{label}</span><strong>{value}</strong>
    {detail !== undefined && <small>{detail}</small>}
  </div>;
}

export function CopyButton({value, label}: {value?: string; label: string}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
    } else {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1000);
  };
  return <button type="button" className="copy-button" aria-label={`Copy ${label}`} onClick={copy}>
    {copied ? 'Copied' : 'Copy'}
  </button>;
}

export function BackToRuns({goHome}: {goHome: () => void}) {
  return <button type="button" className="back-runs" onClick={goHome}>← Back to all runs</button>;
}

export function Pager({page, total, limit, previous, next, onPrevious, onNext}: {
  page: number; total: number; limit: number; previous: boolean; next: boolean;
  onPrevious: () => void; onNext: () => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return <div className="pager"><button type="button" disabled={!previous} onClick={onPrevious}>Previous</button><span aria-live="polite">Page {page} of {pages}</span><button type="button" disabled={!next} onClick={onNext}>Next</button></div>;
}

export function EmptyRow({columns, children}: {columns: number; children: ReactNode}) {
  return <tr><td colSpan={columns} className="empty-state">{children}</td></tr>;
}

export function DetailPair({label, value, copy = false}: {label: string; value?: ReactNode; copy?: boolean}) {
  const text = value === undefined || value === null || value === '' ? 'Not reported' : String(value);
  return <><dt>{label}</dt><dd><span title={text}>{text}</span>{copy && <CopyButton value={text === 'Not reported' ? undefined : text} label={label} />}</dd></>;
}
