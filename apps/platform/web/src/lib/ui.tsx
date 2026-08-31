import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Check, ChevronDown, Trash2, X } from 'lucide-react';
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
    <div className="rounded-2xl border border-line-soft bg-card p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
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
    ghost: 'border border-line bg-card text-ink hover:bg-paper',
    danger: 'border border-bad/25 bg-card text-bad hover:bg-bad-soft/60',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`whitespace-nowrap rounded-[10px] px-4 py-2 text-[13.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

const fieldClass =
  'w-full rounded-[10px] border border-line bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15';

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

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Small right-aligned annotation (a count, a domain, …). */
  hint?: string;
}

/** Filter dropdown: a labeled trigger with a popover listbox. Closes on
 *  outside click, Escape, or selection. */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Prefix shown before the selected value, e.g. "Domain". */
  label?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-3 py-2 text-[13px] font-medium transition ${
          open ? 'border-accent/50 bg-card text-ink ring-2 ring-accent/15' : 'border-line bg-card text-ink hover:bg-paper'
        }`}
      >
        {label && <span className="font-normal text-ink-soft">{label}</span>}
        {selected?.label}
        <ChevronDown className={`h-3.5 w-3.5 text-ink-soft transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[180px] rounded-xl border border-line-soft bg-card p-1.5 shadow-[0_16px_40px_-12px_rgba(30,25,18,0.25)]"
        >
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                o.value === value ? 'font-semibold text-ink' : 'text-ink-soft hover:bg-paper hover:text-ink'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="font-mono text-[10.5px] text-ink-soft/70">{o.hint}</span>}
              {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
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
            value === v ? 'bg-card text-ink shadow-[0_1px_2px_rgba(30,25,18,0.08)]' : 'text-ink-soft hover:text-ink'
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
  foot,
}: {
  head: string[];
  children: ReactNode;
  /** Optional footer row inside the card (pagination, totals). */
  foot?: ReactNode;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line-soft bg-card shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
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
        <tbody className="divide-y divide-[#efe8dc]">{children}</tbody>
      </table>
      {foot && (
        <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5 text-xs text-ink-soft">
          {foot}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card/50 py-14 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}

/** Right-side info drawer. Escape and backdrop clicks close it. */
export function Drawer({
  title,
  sub,
  children,
  onClose,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#1c1916]/30 backdrop-blur-[1px]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 flex w-full max-w-[400px] flex-col border-l border-line-soft bg-card shadow-[-24px_0_60px_-24px_rgba(30,25,18,0.35)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-[15.5px] font-semibold text-ink">{title}</h2>
            {sub && <div className="mt-0.5 text-xs text-ink-soft">{sub}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-soft transition hover:bg-paper hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>
  );
}

/** Centered confirmation dialog. With `confirmWord`, the confirm button stays
 *  disabled until the word is typed (for irreversible actions). Escape and
 *  backdrop clicks cancel. */
export function ConfirmDialog({
  title,
  sub,
  children,
  confirmLabel,
  confirmWord,
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
  confirmLabel: string;
  confirmWord?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const armed = !confirmWord || typed.trim() === confirmWord;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1c1916]/40 backdrop-blur-[1.5px] p-4"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[430px] rounded-2xl border border-line-soft bg-card p-6 shadow-[0_32px_80px_-20px_rgba(30,25,18,0.5)]"
      >
        <div className="mb-2.5 flex items-center gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
              danger ? 'bg-bad-soft text-bad' : 'bg-accent-soft text-accent-deep'
            }`}
          >
            <Trash2 className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[15.5px] font-semibold text-ink">{title}</h2>
            {sub && <p className="text-xs text-ink-soft">{sub}</p>}
          </div>
        </div>
        {children}
        {confirmWord && (
          <>
            <label
              htmlFor="confirm-word"
              className="mb-1.5 mt-4 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-soft"
            >
              Type {confirmWord} to confirm
            </label>
            <input
              id="confirm-word"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={confirmWord}
              autoComplete="off"
              autoFocus
              className="w-full rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition focus:border-bad focus:ring-2 focus:ring-bad/15"
            />
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[10px] border border-line bg-card px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-paper"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!armed || busy}
            className={`rounded-[10px] px-4 py-2 text-[13px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
              danger ? 'bg-bad hover:brightness-90' : 'bg-accent hover:bg-accent-deep'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
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
