import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseSecretUri, resolveSecrets } from '../src/infra/key-vault.js';

const URI = 'https://kv-arenal-dev-abc123.vault.azure.net/secrets/jwt-private-key';

describe('llave de los JWT desde Key Vault', () => {
  it('separa el vault, el nombre y la versión de la URL del secreto', () => {
    expect(parseSecretUri(URI)).toEqual({
      vaultUrl: 'https://kv-arenal-dev-abc123.vault.azure.net',
      name: 'jwt-private-key',
      version: undefined,
    });
    expect(parseSecretUri(`${URI}/0123abcd`).version).toBe('0123abcd');
    expect(() => parseSecretUri('https://kv.vault.azure.net/keys/otra')).toThrow(/no es la URL de un secreto/);
  });

  it('lee la llave con la URL del secreto y la deja en la configuración', async () => {
    const read = vi.fn(() => Promise.resolve('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'));
    const config = await resolveSecrets(loadConfig({ NODE_ENV: 'production', JWT_PRIVATE_KEY_SECRET_URI: URI }), read);
    expect(read).toHaveBeenCalledWith('https://kv-arenal-dev-abc123.vault.azure.net', 'jwt-private-key', undefined);
    expect(config.JWT_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
  });

  it('si la llave vino directa no consulta Key Vault', async () => {
    const read = vi.fn(() => Promise.resolve('otra'));
    const config = await resolveSecrets(loadConfig({ JWT_PRIVATE_KEY: 'pem', JWT_PRIVATE_KEY_SECRET_URI: URI }), read);
    expect(read).not.toHaveBeenCalled();
    expect(config.JWT_PRIVATE_KEY).toBe('pem');
  });

  it('un secreto vacío detiene el arranque', async () => {
    const config = loadConfig({ NODE_ENV: 'production', JWT_PRIVATE_KEY_SECRET_URI: URI });
    await expect(resolveSecrets(config, () => Promise.resolve(''))).rejects.toThrow(/vacío/);
  });

  it('en producción exige la llave o la URL del secreto', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_PRIVATE_KEY_SECRET_URI/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_PRIVATE_KEY_SECRET_URI: 'http://inseguro/secrets/x' }),
    ).toThrow();
  });
});
