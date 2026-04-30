import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from '../db/index.js';
import { registerRoutes } from './routes/index.js';

/**
 * CORS allowlist for development. The Vite dev server runs on a different
 * port than Fastify (5173 vs 7777 by default), so the SPA's `fetch('/api/…')`
 * calls land cross-origin in dev. In production the SPA is served same-origin
 * by Fastify's static plugin, so these origins never match and CORS becomes
 * a no-op.
 *
 * Localhost-only by design: this is a safety-critical local tool, never meant
 * to be reachable from the internet. Widening the allowlist would let any web
 * page the user visits issue requests against their target_root.
 */
const DEV_ORIGIN_ALLOWLIST = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export type { ZodTypeProvider };
// Routes use the typed-app alias from `./types.js` (`ZodApp`). Don't add
// another typed-app alias here — having two competing definitions invites
// drift and the previous one resolved to `never` due to a TS quirk.

export interface ServerDeps {
  db: Db;
  targetRoot: string;
  port: number;
  /** When true (tests), don't actually .listen — just build the instance. */
  dontListen?: boolean;
}

export interface ServerHandle {
  app: FastifyInstance;
  port: number;
  close(): Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<ServerHandle> {
  const app = Fastify({
    logger:
      process.env.LOG_LEVEL === 'silent'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
          },
  });

  // Wire the Zod type provider before registering routes — handlers declare
  // their schema inline (`{schema: {body: …, response: …}}`) and get typed
  // request/reply with auto request validation + response serialization.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  await typed.register(fastifyCors, {
    origin: DEV_ORIGIN_ALLOWLIST,
    credentials: false,
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
  });

  await registerRoutes(typed, deps);

  if (deps.dontListen) {
    await app.ready();
    return {
      app,
      port: 0,
      close: async () => {
        await app.close();
      },
    };
  }
  await app.listen({ port: deps.port, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : deps.port;
  return {
    app,
    port,
    close: async () => {
      await app.close();
    },
  };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  return (await startServer({ ...deps, dontListen: true })).app;
}
