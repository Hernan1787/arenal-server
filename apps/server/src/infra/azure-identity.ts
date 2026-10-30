import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import type { Config } from '../config.js';

let shared: TokenCredential | undefined;

/**
 * Credencial de la identidad administrada asignada por el usuario (la de Container Apps).
 * `AZURE_CLIENT_ID` dice cuál usar. Se comparte entre Postgres y Redis: la librería guarda
 * los tokens en caché y los renueva antes de que venzan.
 */
export function azureCredential(config: Pick<Config, 'AZURE_CLIENT_ID'>): TokenCredential {
  shared ??= new ManagedIdentityCredential(
    config.AZURE_CLIENT_ID === undefined ? {} : { clientId: config.AZURE_CLIENT_ID },
  );
  return shared;
}
