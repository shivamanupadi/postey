/** Marketing-site chrome (floating pill nav + footer) for content pages.
 *  Wizard routes render without this - they use WizardShell instead. */
import type { ReactElement, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

function Wordmark(): ReactElement {
  return (
    <span className="font-display text-lg font-semibold tracking-tight text-ink">
      postey<span className="text-accent">.</span>
    </span>
  );
}

export function SiteChrome({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      {/* Floating pill nav */}
      <header className="sticky top-4 z-50 px-4">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 rounded-full border border-line bg-white/90 pl-5 pr-2.5 shadow-sm backdrop-blur">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="Postey" className="h-6 w-6" />
            <Wordmark />
          </Link>
          <nav className="ml-5 hidden items-center gap-1 text-[15px] font-medium text-ink-soft md:flex">
            <a href="/#features" className="rounded-full px-3 py-1.5 transition hover:bg-paper hover:text-ink">
              Features
            </a>
            <a href="/#newsletters" className="rounded-full px-3 py-1.5 transition hover:bg-paper hover:text-ink">
              Newsletters
            </a>
            <a href="/#pricing" className="rounded-full px-3 py-1.5 transition hover:bg-paper hover:text-ink">
              Pricing
            </a>
            <a href="/#faq" className="rounded-full px-3 py-1.5 transition hover:bg-paper hover:text-ink">
              FAQ
            </a>
          </nav>
          <div className="flex-1" />
          <Link
            to="/deploy"
            className="rounded-full bg-ink px-4.5 py-2 text-sm font-medium text-white transition hover:bg-black"
          >
            Deploy to Cloudflare
          </Link>
        </div>
      </header>

      {children}

      <footer className="border-t border-line-soft bg-paper-deep">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-14 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <img src="/logo.svg" alt="Postey" className="h-7 w-7" />
              <Wordmark />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Self-hosted transactional email &amp; newsletters, installed into your own Cloudflare
              account.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 text-sm sm:grid-cols-3">
            <div>
              <p className="font-semibold text-ink">Product</p>
              <ul className="mt-3 space-y-2 text-ink-soft">
                <li>
                  <a href="/#features" className="hover:text-ink">
                    Features
                  </a>
                </li>
                <li>
                  <a href="/#pricing" className="hover:text-ink">
                    Pricing
                  </a>
                </li>
                <li>
                  <Link to="/deploy" className="hover:text-ink">
                    Deploy
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Resources</p>
              <ul className="mt-3 space-y-2 text-ink-soft">
                <li>
                  <a href="/#faq" className="hover:text-ink">
                    FAQ
                  </a>
                </li>
                <li>
                  <span className="cursor-default opacity-60">Docs (soon)</span>
                </li>
                <li>
                  <span className="cursor-default opacity-60">API reference (soon)</span>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Family</p>
              <ul className="mt-3 space-y-2 text-ink-soft">
                <li>
                  <a
                    href="https://traks.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-ink"
                  >
                    Traks - analytics
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <div className="border-t border-line py-5 text-center text-xs text-ink-soft">
          © {new Date().getFullYear()} Postey. Your mail, your infrastructure.
        </div>
      </footer>
    </>
  );
}
