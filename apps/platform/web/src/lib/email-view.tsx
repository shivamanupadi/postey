/**
 * Inline email rendering for the Inbox - sanitized HTML in the page flow
 * (no iframe), with quoted reply history split out behind a Gmail-style
 * "show quoted text" toggle.
 *
 * Security model: bodies are hostile input. DOMPurify does the heavy
 * lifting; on top of it we drop remote-content vectors it leaves alone -
 * cid:/unknown-scheme images (we don't store inbound attachments, so cid:
 * can never resolve) and url()/import tricks inside inline styles.
 */
import { useMemo, useState, type ReactElement } from 'react';
import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    // /api/inbox/ paths are our own attachment routes - cid: references are
    // rewritten to them before sanitizing; every other scheme dies here.
    if (!/^(https?:|data:image\/)/i.test(src) && !src.startsWith('/api/inbox/')) {
      node.remove();
      return;
    }
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
  const style = node.getAttribute?.('style');
  if (style && /url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding/i.test(style)) {
    node.removeAttribute('style');
  }
});

const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'link', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio'],
    FORBID_ATTR: ['class', 'id'],
    ALLOW_DATA_ATTR: false,
  });

/* ── quoted-history detection ────────────────────────────────────── */

// Wrappers the major clients put reply history in. Everything from the
// first match to the end of the body is treated as history (Outlook's
// divRplyFwdMsg header div is followed by sibling content).
const QUOTE_SELECTOR = [
  'div.gmail_quote',
  'blockquote[type="cite"]',
  'div.yahoo_quoted',
  'div[id^="divRplyFwdMsg"]',
  'div.moz-cite-prefix',
].join(', ');

function splitHtmlQuoted(html: string, cidMap?: Record<string, string>): { main: string; quoted: string | null } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Inline images arrive as cid: references to MIME parts; point them at our
  // attachment route (the sanitizer would otherwise drop them).
  if (cidMap) {
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? '';
      if (!src.toLowerCase().startsWith('cid:')) continue;
      const resolved = cidMap[src.slice(4).replace(/^<|>$/g, '')];
      if (resolved) img.setAttribute('src', resolved);
    }
  }
  const hit = doc.body.querySelector(QUOTE_SELECTOR);
  if (!hit) return { main: doc.body.innerHTML, quoted: null };
  const full = doc.body.innerHTML; // cid-rewritten, pre-split
  const container = doc.createElement('div');
  let node: Element | null = hit;
  while (node) {
    const next: Element | null = node.nextElementSibling;
    container.appendChild(node);
    node = next;
  }
  // A message that was nothing but history renders whole instead of empty.
  if (!doc.body.textContent?.trim() && !doc.body.querySelector('img')) {
    return { main: full, quoted: null };
  }
  return { main: doc.body.innerHTML, quoted: container.innerHTML };
}

const TEXT_MARKERS = [
  /^On\s.{4,160}\swrote:$/,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{8,}$/,
];

function splitTextQuoted(text: string): { main: string; quoted: string | null } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let idx = lines.findIndex(l => TEXT_MARKERS.some(re => re.test(l.trim())));
  if (idx < 0) idx = lines.findIndex(l => l.startsWith('>'));
  if (idx < 0) return { main: text.trim(), quoted: null };
  const main = lines.slice(0, idx).join('\n').trim();
  const quoted = lines
    .slice(idx)
    .map(l => l.replace(/^\s*>\s?/, ''))
    .join('\n')
    .trim();
  return main ? { main, quoted: quoted || null } : { main: text.trim(), quoted: null };
}

/* ── component ───────────────────────────────────────────────────── */

type Prepared =
  | { kind: 'html'; main: string; quoted: string | null }
  | { kind: 'text'; main: string; quoted: string | null }
  | { kind: 'empty' };

function prepare(html: string | null, text: string | null, cidMap?: Record<string, string>): Prepared {
  if (html) {
    const { main, quoted } = splitHtmlQuoted(html, cidMap);
    return { kind: 'html', main: sanitize(main), quoted: quoted ? sanitize(quoted) : null };
  }
  if (text?.trim()) return { kind: 'text', ...splitTextQuoted(text) };
  return { kind: 'empty' };
}

export function EmailBody({
  html,
  text,
  cidMap,
}: {
  html: string | null;
  text: string | null;
  /** contentId → same-origin attachment URL, for inline (cid:) images. */
  cidMap?: Record<string, string>;
}): ReactElement {
  const [showQuoted, setShowQuoted] = useState(false);
  const body = useMemo(() => prepare(html, text, cidMap), [html, text, cidMap]);

  if (body.kind === 'empty') {
    return <p className="text-[13px] italic text-ink-soft">(empty message)</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        {body.kind === 'html' ? (
          <div className="email-body" dangerouslySetInnerHTML={{ __html: body.main }} />
        ) : (
          <pre className="email-body whitespace-pre-wrap font-sans">{body.main}</pre>
        )}
      </div>

      {body.quoted && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowQuoted(s => !s)}
            aria-expanded={showQuoted}
            className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-ink-soft transition hover:bg-paper-deep hover:text-ink"
            title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
          >
            •••
          </button>
          {showQuoted && (
            <div className="mt-3 overflow-x-auto border-l-[3px] border-line pl-4 opacity-80">
              {body.kind === 'html' ? (
                <div className="email-body" dangerouslySetInnerHTML={{ __html: body.quoted }} />
              ) : (
                <pre className="email-body whitespace-pre-wrap font-sans text-ink-soft">
                  {body.quoted}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
