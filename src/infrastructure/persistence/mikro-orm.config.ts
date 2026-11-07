import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/app-config';

const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Config do MikroORM. O mapeamento das entidades usa EntitySchema dentro de
 * infrastructure/, para que o domínio não dependa do ORM (CHALLENGE §6.1).
 */
export function buildMikroOrmConfig(config: Pick<AppConfig, 'databaseUrl'>) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    // Proíbe usar o EntityManager global (identity map compartilhado): exige contexto
    // explícito via em.fork() / em.transactional().
    allowGlobalContext: false,
    // Pool pequeno por instância: com N instâncias, o total é N × max.
    // acquireTimeout curto: com o banco fora, falha rápido (erro transitório) em vez de
    // empilhar requisições por 60s (default do tarn).
    pool: { min: 0, max: 10, acquireTimeoutMillis: 10_000 },
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: migrationsPath,
      pathTs: migrationsPath,
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      // Migrations são escritas à mão (SQL explícito): o schema é parte da avaliação.
      emit: 'ts',
      snapshot: false,
    },
  });
}
