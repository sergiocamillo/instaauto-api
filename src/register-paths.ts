/**
 * Resolve os aliases de tsconfig em runtime (após o build, a partir de dist/).
 *
 * O tsc não reescreve path-aliases no JS emitido, então registramos o mapa
 * apontando para o layout compilado (dist/src/generated/prisma/...).
 * Importado no topo de main.ts, antes de qualquer módulo da aplicação.
 */
import { register } from 'tsconfig-paths';
import { join } from 'path';

// __dirname em produção: dist/src
register({
  baseUrl: __dirname,
  paths: {
    '@generated/prisma': [join('generated', 'prisma', 'client')],
    '@generated/prisma/*': [join('generated', 'prisma', '*')],
  },
});
