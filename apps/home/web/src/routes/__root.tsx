import type { ReactElement } from 'react';
import { createRootRoute, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

/** Routes own their chrome: the landing page wraps itself in SiteChrome; the
 *  deploy/update/destroy wizards render as full pages via WizardShell. */
function RootLayout(): ReactElement {
  return (
    <div className="min-h-screen bg-paper">
      <Outlet />
    </div>
  );
}
