import type { ReactElement } from 'react';
import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

function Wordmark({ light = false }: { light?: boolean }): ReactElement {
  return (
    <span
      className={`font-display text-2xl font-semibold tracking-tight ${light ? 'text-cream' : 'text-ink'}`}
    >
      postey<span className="text-accent">.</span>
    </span>
  );
}

function RootLayout(): ReactElement {
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-50 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="Postey" className="h-8 w-8" />
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-medium text-ink-soft md:flex">
            <a href="/#features" className="hover:text-ink">
              Features
            </a>
            <a href="/#newsletters" className="hover:text-ink">
              Newsletters
            </a>
            <a href="/#architecture" className="hover:text-ink">
              Architecture
            </a>
            <a href="/#pricing" className="hover:text-ink">
              Pricing
            </a>
            <a href="/#faq" className="hover:text-ink">
              FAQ
            </a>
          </nav>
          <Link
            to="/deploy"
            className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-cream transition hover:bg-ink-deep"
          >
            Deploy to Cloudflare
          </Link>
        </div>
      </header>

      <Outlet />

      <footer className="border-t border-line bg-paper-deep">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-12 md:flex-row md:items-start md:justify-between">
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
                    Traks — analytics
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
    </div>
  );
}
