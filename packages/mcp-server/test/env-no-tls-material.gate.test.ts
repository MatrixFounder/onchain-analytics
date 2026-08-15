import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/env.js';

/**
 * Task 014-11 — AC-36: no declared environment key names TLS material.
 *
 * **Why a gate over the DECLARED keys, and not a parse test.** `EnvSchema` is deliberately not
 * `.strict()` (`env.ts`: the real input is `process.env`, which carries hundreds of unrelated keys),
 * so an unknown key is STRIPPED rather than rejected. A test asserting "the schema does not accept a
 * certificate path" is therefore true of any invented name — and it would stay green on the day such
 * a key was added to the schema, which is the one case the criterion exists for.
 *
 * **Why the engine holds no certificate.** TLS terminates at the reverse proxy (R-12.6). A
 * certificate path in the schema means the process reads one, which moves renewal and private-key
 * custody onto the engine — and the engine's own `.env` is not where a private key should live.
 */

/**
 * What counts as TLS material, and why `key` alone does not.
 *
 * The task's own wording lists the substrings `cert`, `key`, `pem`, `pfx`. Measured against the
 * declared keys, `key` alone flags six legitimate ones — `COINGECKO_API_KEY`, `DUNE_API_KEY`,
 * `BLOCKSCOUT_PRO_API_KEY`, `NANSEN_API_KEY` and their siblings — so a gate written to the letter
 * would be red today on vendor credentials that have nothing to do with TLS. Either the gate gets a
 * suppression list, which is where a gate goes to die, or the rule says what it actually means.
 *
 * It means: material a TLS listener would read. A certificate, a container of one, or a key that is
 * private, or a key named as a FILE — because a key that arrives as a path is a key on disk.
 */
const TLS_MATERIAL = [
  /cert/i,
  /\bpem\b|_pem|pem_/i,
  /pfx/i,
  /\btls\b|_tls|tls_/i,
  /\bssl\b|_ssl|ssl_/i,
  /(private|secret)_?key/i,
  /key_?(path|file)/i,
] as const;

const namesTlsMaterial = (key: string): boolean => TLS_MATERIAL.some((rule) => rule.test(key));

describe('AC-36: the schema declares no TLS material', () => {
  it('finds none among the declared keys', () => {
    const declared = Object.keys(EnvSchema.shape);
    // The count is not pinned — it was twelve when §7.5.4 measured it and is twenty-two since task
    // 014-40. A gate that asserted the number would fail on every key added for any reason.
    expect(declared.length).toBeGreaterThan(0);
    const offenders = declared.filter(namesTlsMaterial);
    expect(
      offenders,
      'a key naming a certificate or a private key means the process reads one — TLS terminates at ' +
        'the reverse proxy (R-12.6), and the engine holds neither certificate nor private key',
    ).toStrictEqual([]);
  });

  it('is red on the key AC-36 names, and on its siblings', () => {
    // The criterion's own example, plus the forms it would be introduced under.
    for (const invented of [
      'TLS_CERT_PATH',
      'ONCHAIN_TLS_KEY_PEM',
      'SERVER_CERTIFICATE',
      'ONCHAIN_SSL_CA',
      'ONCHAIN_PRIVATE_KEY',
      'ONCHAIN_KEY_FILE',
      'ONCHAIN_CLIENT_PFX',
    ]) {
      expect(namesTlsMaterial(invented), invented).toBe(true);
    }
  });

  it('is green on every vendor credential the schema legitimately declares', () => {
    // The half that makes the rule usable. `key` as a bare substring would flag all of these, and a
    // gate that has to be suppressed for correct code is a gate nobody keeps.
    for (const legitimate of [
      'COINGECKO_API_KEY',
      'COINGECKO_PRO_API_KEY',
      'DUNE_API_KEY',
      'BLOCKSCOUT_PRO_API_KEY',
      'NANSEN_API_KEY',
      'ONCHAIN_TOKEN_HASH_SALT',
    ]) {
      expect(namesTlsMaterial(legitimate), legitimate).toBe(false);
    }
    // And every one of them is really declared, so the list above is not a set of straw names.
    const declared = Object.keys(EnvSchema.shape);
    for (const key of ['COINGECKO_API_KEY', 'NANSEN_API_KEY', 'ONCHAIN_TOKEN_HASH_SALT']) {
      expect(declared).toContain(key);
    }
  });

  it('would catch a TLS key added to the schema, not merely one absent from it', () => {
    // The distinction the docstring opens with: the schema strips unknown keys, so "an invented key
    // does not parse" proves nothing. What this gate reads is the DECLARATION.
    const withTls = { ...EnvSchema.shape, TLS_CERT_PATH: EnvSchema.shape.DATA_DIR };
    expect(Object.keys(withTls).filter(namesTlsMaterial)).toStrictEqual(['TLS_CERT_PATH']);
  });
});
