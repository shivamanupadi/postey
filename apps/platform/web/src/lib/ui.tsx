import type { ReactElement, ReactNode } from 'react';
import { STATUS_COLORS } from './api';

/** Consistent page header: title, optional one-line description, action slot. */
export function PageHeader({
  title,
  sub,
  action,
}: {
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold text-ink">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">{sub}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pt-0.5">{action}</div>}
    </div>
  );
}

export function Badge({ status }: { status: string }): ReactElement {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${STATUS_COLORS[status] ?? 'bg-ink/8 text-ink-soft'}`}
    >
      {status}
    </span>
  );
}

export function Card({
  title,
  sub,
  action,
  children,
}: {
  title?: string;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-2xl border border-line-soft bg-white p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
      {(title || action) && (
        <div className={`flex items-center justify-between gap-4 ${sub ? 'mb-1' : 'mb-4'}`}>
          {title ? <h2 className="text-[15px] font-semibold text-ink">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {sub && <p className="mb-4 text-[13px] leading-relaxed text-ink-soft">{sub}</p>}
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
    ghost: 'border border-line bg-white text-ink hover:bg-paper',
    danger: 'border border-bad/25 bg-white text-bad hover:bg-bad-soft/60',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[10px] px-4 py-2 text-[13.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

const fieldClass =
  'w-full rounded-[10px] border border-line bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input {...props} className={`${fieldClass} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <select {...props} className={`${fieldClass} cursor-pointer ${props.className ?? ''}`}>
      {props.children}
    </select>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return <textarea {...props} className={`${fieldClass} font-mono ${props.className ?? ''}`} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Small pill switcher (body view, snippet language, …). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}): ReactElement {
  return (
    <div className="flex gap-0.5 rounded-full border border-line-soft bg-paper p-0.5 text-xs font-semibold">
      {options.map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-full px-3 py-1 transition ${
            value === v ? 'bg-white text-ink shadow-[0_1px_2px_rgba(30,25,18,0.08)]' : 'text-ink-soft hover:text-ink'
          }`}
        >
          {v}
        </button>
      ))}
    </div>
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
    <div className="overflow-x-auto rounded-2xl border border-line-soft bg-white shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line-soft">
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#f1ede7]">{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white/50 py-14 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }): ReactElement | null {
  if (!error) return null;
  return (
    <p className="rounded-xl bg-bad-soft px-4 py-2.5 text-sm leading-relaxed text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
