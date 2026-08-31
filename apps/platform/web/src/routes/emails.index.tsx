import { useState, type ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Badge, Empty, Input, PageHeader, Table } from '@/lib/ui';

export const Route = createFileRoute('/emails/')({
  component: EmailsPage,
  validateSearch: (s: Record<string, unknown>): { status?: string } =>
    typeof s.status === 'string' ? { status: s.status } : {},
});

interface MessageRow {
  id: string;
  from_email: string;
  from_name: string | null;
  to_json: string;
  subject: string;
  status: string;
  error_code: string | null;
  created_at: number;
  recipient_count: number;
}

function EmailsPage(): ReactElement {
  const { status } = Route.useSearch();
  const [q, setQ] = useState('');
  const messages = useQuery({
    queryKey: ['messages', status, q],
    queryFn: () =>
      api.get<MessageRow[]>(
        `/api/messages?limit=50${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`
      ),
    refetchInterval: 15_000,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={
          <>
            Emails
            {status && <span className="ml-2 align-middle"><Badge status={status} /></span>}
          </>
        }
        sub="Every send with its status and delivery timeline."
        action={
          <div className="w-72">
            <Input
              placeholder="Search subject, recipient, sender…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          </div>
        }
      />
      {messages.data?.length ? (
        <Table head={['Subject', 'To', 'Status', 'Sent']}>
          {messages.data.map(m => (
            <tr key={m.id} className="transition hover:bg-paper/60">
              <td className="px-4 py-3">
                <Link to="/emails/$id" params={{ id: m.id }} className="font-medium hover:text-accent">
                  {m.subject}
                </Link>
                <p className="mt-0.5 font-mono text-xs text-ink-soft">{m.id}</p>
              </td>
              <td className="px-4 py-3 text-ink-soft">
                {(JSON.parse(m.to_json) as string[])[0]}
                {m.recipient_count > 1 ? ` +${m.recipient_count - 1}` : ''}
              </td>
              <td className="px-4 py-3">
                <Badge status={m.status} />
                {m.error_code && <p className="mt-1 font-mono text-xs text-bad">{m.error_code}</p>}
              </td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(m.created_at)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{messages.isLoading ? 'Loading…' : 'No emails match.'}</Empty>
      )}
    </div>
  );
}
