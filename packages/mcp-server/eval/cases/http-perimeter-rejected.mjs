// Transport case — a VALID token behind a foreign `Origin` is still refused (task 014-33, R-12.2).
//
// The two guards are independent, and this case is the one that proves it: a request that would
// have been served is refused on the perimeter alone. Without the valid token the case would prove
// nothing about the perimeter, because the token check would have refused it first.
export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'the perimeter collapsing into the token check — an installation where a valid token is ' +
    'sufficient from any origin — and the refusal arriving as 401, which would tell a browser to ' +
    'retry with a credential it already has',
  exercise: async ({ request, token }) => {
    const foreign = await request({
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    });
    // The control: the SAME request without the Origin header. The engine's clients are servers and
    // send none, so this must NOT be refused on the perimeter — otherwise the case would pass on an
    // installation that refuses everything.
    const control = await request({
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      foreign: { status: foreign.status, body: foreign.body },
      control: { status: control.status },
    };
  },
  check: (o) => {
    const problems = [];
    if (o?.foreign?.status !== 403) {
      problems.push(`a foreign Origin answered ${String(o?.foreign?.status)}, not 403`);
    }
    if (o?.control?.status === 403) {
      problems.push(
        'the control request, with no Origin at all, was ALSO refused on the perimeter — ' +
          'this installation admits nothing and the case above passes for the wrong reason',
      );
    }
    return problems;
  },
};
