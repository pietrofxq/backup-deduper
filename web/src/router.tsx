import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Layout } from './components/Layout.js';
import { DashboardPage } from './pages/Dashboard.js';
import { SettingsPage } from './pages/Settings.js';
import { QuarantinePage } from './pages/Quarantine.js';
import { AuditLogPage } from './pages/AuditLog.js';
import { ReviewQueuePage } from './pages/ReviewQueue.js';

/**
 * Code-based router config. Five top-level pages: Dashboard, Settings,
 * Quarantine, Audit log, Review queue.
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

const quarantineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quarantine',
  component: QuarantinePage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditLogPage,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ReviewQueuePage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  settingsRoute,
  quarantineRoute,
  auditRoute,
  reviewRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
