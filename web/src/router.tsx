import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Layout } from './components/Layout.js';
import { DashboardPage } from './pages/Dashboard.js';
import { SettingsPage } from './pages/Settings.js';

/**
 * Code-based router config. Two top-level pages for M9 (Dashboard, Settings);
 * M10 adds /quarantine, /audit, /review which we wire here.
 *
 * Why code-based over file-based: keeps the route tree readable at a glance,
 * no codegen step in the build, and the SPA stays small enough that a
 * directory full of route files would be more friction than help.
 */

const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([dashboardRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
