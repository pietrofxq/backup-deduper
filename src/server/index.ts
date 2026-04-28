import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from '../db/index.js';
import { registerRoutes } from './routes/index.js';

/**
 * App type with Zod type provider attached. Routes typed against this get
 * automatic request/response validation + inferred parameter types from the
 * inline `schema` block.
 */
export type App = FastifyInstance<
  ReturnType<typeof Fastify>['server'] extends infer _ ? never : never,
  never,
  never,
  never,
  ZodTypeProvider
>;

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
