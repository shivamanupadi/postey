/**
 * Credential-free Email Sending onboarding detection: Cloudflare's onboarding
 * creates public records on the cf-bounce subdomain (MX + SPF TXT, DKIM TXT),
 * so DNS-over-HTTPS answers "is this domain onboarded?" without the instance
 * holding any Cloudflare API access. Same signal the deploy wizard polls.
 */

async function hasRecord(name: string, type: 'TXT' | 'MX'): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { Answer?: unknown[] };
    return (data.Answer?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function sendingDnsReady(domain: string): Promise<boolean> {
  const [spf, dkim, mx] = await Promise.all([
    hasRecord(`cf-bounce.${domain}`, 'TXT'),
    hasRecord(`cf-bounce._domainkey.${domain}`, 'TXT'),
    hasRecord(`cf-bounce.${domain}`, 'MX'),
  ]);
  return spf || dkim || mx;
}
