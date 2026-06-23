import { SetMetadata } from '@nestjs/common';

export const REQUIRE_CONNECTED_ACCOUNT = 'requireConnectedAccount';

/**
 * Marca uma rota que só pode ser usada com uma conta da Meta conectada.
 * Aplicado a criação/edição/ativação de automações.
 */
export const RequireConnectedAccount = () =>
  SetMetadata(REQUIRE_CONNECTED_ACCOUNT, true);
