# Fixture evidence: defillama/uniswap

- recorded_at: 2026-07-22T21:32:21.100Z
- endpoint: https://api.llama.fi/protocol/uniswap
- http_status: 200
- capability: protocol.tvl
- args: {"chain":"ethereum","protocolSlug":"uniswap"}
- envelope_fields: chain, raw
- vendor_response_fields: address, chainTvls, chains, cmcId, currentChainTvls, description, gecko_id, github, governanceID, hacks, hallmarks, id, isParentProtocol, logo, mcap, misrepresentedTokens, name, otherProtocols, raises, symbol, tokens, tokensInUsd, treasury, tvl, twitter, url
- series trimmed to last 3 points post-recording (fixture-size finding, cycle 2): every `chainTvls[*].tvl` array and the top-level `tvl` array (49 series total) were sliced to their last 3 entries each — the raw recording was ~3.6MB (49 chains' full daily history, most going back years); golden tests only ever read the LAST point of each series (`lastTotalLiquidityUsd()`), so trimming loses no test coverage. All non-series fields (name, chains, currentChainTvls, tokens/tokensInUsd — both empty in this recording, symbol, address, etc.) are preserved byte-for-byte from the original 2026-07-22 live capture; only array LENGTH changed, never any individual point's own values. File shrank to ~24KB.
