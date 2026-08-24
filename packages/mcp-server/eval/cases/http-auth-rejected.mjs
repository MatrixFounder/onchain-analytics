// Transport case — a request without a usable token is refused BEFORE any routing (task 014-33).
//
// The four states §7.5.2 distinguishes (no header, malformed, unknown digest, revoked) answer ONE
// `401` on the wire and are told apart only in diagnostics. This case asserts the wire contract,
// which is the half a caller can observe.
export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'the perimeter admitting an unauthenticated request, the refusal losing its ' +
    '`WWW-Authenticate` header (which is what tells a client to present a credential rather than ' +
    'to give up), and a refusal that leaks which of the four token states applied',
  exercise: async ({ request }) => {
    const absent = await request({ method: 'POST', body: '{}' });
    const bogus = await request({
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer oi_notarealtokenvalue' },
    });
    return {
      absent: {
        status: absent.status,
        authenticate: absent.headers['www-authenticate'] ?? null,
        body: absent.body,
      },
      bogus: {
        status: bogus.status,
        authenticate: bogus.headers['www-authenticate'] ?? null,
        body: bogus.body,
      },
    };
  },
  check: (o) => {
    const problems = [];
    for (const [name, r] of Object.entries(o ?? {})) {
      if (r?.status !== 401) {
        problems.push(
          `${name}: status ${String(r?.status)} — an unauthenticated request must be 401`,
        );
      }
      if (typeof r?.authenticate !== 'string' || !/bearer/i.test(r.authenticate)) {
        problems.push(`${name}: no WWW-Authenticate: Bearer on the refusal`);
      }
      // The refusal must not name WHICH state applied. A body distinguishing "unknown token" from
      // "revoked token" is an oracle for whoever is guessing.
      if (
        typeof r?.body === 'string' &&
        /revoked|expired|unknown token|no such token/i.test(r.body)
      ) {
        problems.push(
          `${name}: the refusal body names the token state — it is one 401 for all four`,
        );
      }
    }
    if (Object.keys(o ?? {}).length !== 2)
      problems.push('the case observed fewer than two requests');
    return problems;
  },
};
