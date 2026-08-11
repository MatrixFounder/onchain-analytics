import { nonEmpty, num } from '../case-lib.mjs';

export default {
  capability: 'protocol.incidents',
  // Protocol-scoped, not chain-scoped: the feed is global, so one probe answers for every chain
  // that declares the capability. `compound-finance` is asked for because it HAS a recorded
  // incident — a probe that can only ever return an empty list would pass while the join was
  // broken, which is the failure mode this case exists to catch.
  args: (_chain, probe) => ({ protocolSlug: probe?.incidentProtocolSlug ?? 'compound-finance' }),
  catches:
    'DeFiLlama changing the /hacks record shape or its id vocabulary, the protocol join silently ' +
    'returning nothing, and the feed going stale while still answering 200',
  check: (r) => {
    const problems = [nonEmpty(r?.source, 'source'), nonEmpty(r?.protocol, 'protocol')].filter(
      Boolean,
    );

    // The feed loaded at all. A collapse here is a vendor problem, and without it every other
    // assertion below would pass vacuously on an empty document.
    const records = num(r?.feedRecords);
    if (records === null || records < 100) {
      problems.push(`feedRecords is ${records} — the incident feed did not load or was truncated`);
      return problems;
    }

    // The staleness signal WI-52 required for non-on-chain data. 30 days is generous on purpose:
    // this feed is editorial and quiet months are real, but a year of silence means it was
    // abandoned and every empty answer downstream became meaningless.
    const through = num(r?.feedThroughTs);
    if (through === null) {
      problems.push('feedThroughTs missing — a caller cannot tell how current an empty list is');
    } else {
      const ageDays = (Date.now() - through) / 86_400_000;
      if (ageDays > 180) {
        problems.push(`the incident feed has had no new record for ${Math.round(ageDays)} days`);
      }
    }

    // The JOIN. This is the assertion that would catch the vendor renaming `defillamaId` — the
    // failure that turns every answer into a confident, empty "nothing recorded".
    if (r?.resolved !== true) {
      problems.push(
        `resolved is ${JSON.stringify(r?.resolved)} — the probe slug is no longer in the catalog, ` +
          'so this run proves nothing about the incident join',
      );
    } else if (!Array.isArray(r?.incidents) || r.incidents.length === 0) {
      problems.push(
        'the probe protocol has a recorded incident and none came back — the id join is broken',
      );
    } else {
      for (const incident of r.incidents) {
        if (num(incident?.ts) === null) problems.push('an incident has no usable ts');
        if (!nonEmpty(incident?.name, 'name') === false) problems.push('an incident has no name');
        if (incident?.matchedBy !== 'protocol' && incident?.matchedBy !== 'parent') {
          problems.push(`matchedBy is ${JSON.stringify(incident?.matchedBy)} — vocabulary changed`);
        }
      }
    }

    // WI-52's honesty fields must be PRESENT even on a rich answer — they are what a consumer
    // reads when the list is empty, and a field that only appears sometimes is a field nobody
    // learns to read.
    if (num(r?.unattributedRecords) === null) {
      problems.push('unattributedRecords missing — an empty list would be uninterpretable');
    }

    return problems;
  },
};
