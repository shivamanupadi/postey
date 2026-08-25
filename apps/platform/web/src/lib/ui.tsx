import type { ReactElement, ReactNode } from 'react';
import { STATUS_COLORS } from './api';

export function Badge({ status }: { status: string }): ReactElement {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[status] ?? 'bg-ink/10 text-ink-soft'}`}
    >
      {status}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-2xl border border-line bg-white/60 p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title ? <h2 className="font-display text-lg font-semibold">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
}): ReactElement {
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-deep',
    ghost: 'border border-line bg-paper text-ink hover:border-ink-soft',
    danger: 'border border-bad/30 bg-paper text-bad hover:bg-bad/5',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft/60 focus:border-accent ${props.className ?? ''}`}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return (
    <textarea
      {...props}
      className={`w-full rounded-xl border border-line bg-white px-3.5 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-soft/60 focus:border-accent ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
        {label}
      </span>
      {children}
    </label>
  );
}

export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-paper-deep text-xs uppercase tracking-wide text-ink-soft">
          <tr>
            {head.map(h => (
              <th key={h} className="px-4 py-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-white/40">{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="py-10 text-center text-sm text-ink-soft">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }): ReactElement | null {
  if (!error) return null;
  return (
    <p className="rounded-xl border border-bad/30 bg-bad/5 px-4 py-2.5 text-sm text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
