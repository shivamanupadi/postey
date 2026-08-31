/**
 * Credential-free Email Sending onboarding detection: Cloudflare's onboarding
 * creates public records on the cf-bounce subdomain (MX + SPF TXT, DKIM TXT),
 * so DNS-over-HTTPS answers "is this domain onboarded?" without the instance
 * holding any Cloudflare API access. Same signal the deploy wizard polls.
 */

/** DNS RR type numbers as they appear in dns-json answers. */
const RR = { TXT: 16, MX: 15 } as const;

/**
 * True only when an answer of the REQUESTED type exists whose content matches
 * `expect`. Counting any answer is not enough: a wildcard or CNAME on the
 * queried name returns answers for domains that were never onboarded (or are
 * not even the user's), which used to let Verify & activate pass wrongly.
 */
async function hasRecord(
  name: string,
  type: 'TXT' | 'MX',
  expect?: (data: string) => boolean
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { Answer?: { type?: number; data?: string }[] };
    return (data.Answer ?? []).some(
      a => a.type === RR[type] && (!expect || expect(String(a.data ?? '')))
    );
  } catch {
    return false;
  }
}

export interface SendingDnsChecks {
  spf: boolean;
  dkim: boolean;
  mx: boolean;
}

export async function sendingDnsChecks(domain: string): Promise<SendingDnsChecks> {
  const [spf, dkim, mx] = await Promise.all([
    hasRecord(`cf-bounce.${domain}`, 'TXT', d => d.toLowerCase().includes('v=spf1')),
    hasRecord(`cf-bounce._domainkey.${domain}`, 'TXT', d => d.toLowerCase().includes('v=dkim1')),
    hasRecord(`cf-bounce.${domain}`, 'MX'),
  ]);
  return { spf, dkim, mx };
}

/** Onboarded = a content-verified SPF or DKIM record exists on cf-bounce.
 *  The MX check alone is not sufficient (wildcard MX would satisfy it). */
export async function sendingDnsReady(domain: string): Promise<boolean> {
  const { spf, dkim } = await sendingDnsChecks(domain);
  return spf || dkim;
}
