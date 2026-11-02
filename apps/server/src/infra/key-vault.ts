import { SecretClient } from '@azure/keyvault-secrets';
import { ConfigError, type Config } from '../config.js';
import { azureCredential } from './azure-identity.js';

/** Lee un secreto de Key Vault: `vaultUrl` es `https://<vault>.vault.azure.net`. */
export type SecretReader = (vaultUrl: string, name: string, version: string | undefined) => Promise<string | undefined>;

/** Separa la URL de un secreto en el vault, el nombre y la versión (opcional). */
export function parseSecretUri(uri: string): { vaultUrl: string; name: string; version: string | undefined } {
  const url = new URL(uri);
  const [kind, name, version, ...rest] = url.pathname.split('/').filter((part) => part !== '');
  if (kind !== 'secrets' || name === undefined || rest.length > 0) {
    throw new ConfigError(
      'Configuración inválida:\n- JWT_PRIVATE_KEY_SECRET_URI: no es la URL de un secreto de Key Vault',
    );
  }
  return { vaultUrl: url.origin, name, version };
}

/**
 * Si la llave de los JWT no vino directa, la lee de Key Vault con la identidad administrada.
 * Container Apps no siempre permite referencias a Key Vault (los ambientes Express no las
 * tienen), así que la app la busca ella misma al arrancar: el valor no queda en la
 * configuración de Azure ni en la plantilla. Si no la puede leer, la réplica no arranca.
 */
export async function resolveSecrets(
  config: Config,
  read: SecretReader = (vaultUrl, name, version) =>
    new SecretClient(vaultUrl, azureCredential(config))
      .getSecret(name, version === undefined ? {} : { version })
      .then((secret) => secret.value),
): Promise<Config> {
  if (config.JWT_PRIVATE_KEY !== undefined || config.JWT_PRIVATE_KEY_SECRET_URI === undefined) return config;
  const { vaultUrl, name, version } = parseSecretUri(config.JWT_PRIVATE_KEY_SECRET_URI);
  const value = await read(vaultUrl, name, version);
  if (value === undefined || value === '') {
    throw new ConfigError(`El secreto ${name} de Key Vault está vacío`);
  }
  return { ...config, JWT_PRIVATE_KEY: value };
}
