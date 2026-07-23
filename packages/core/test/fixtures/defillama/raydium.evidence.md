# Fixture evidence: defillama/raydium

- recorded_at: 2026-07-22T21:32:22.292Z
- endpoint: https://api.llama.fi/protocol/raydium
- http_status: 200
- capability: protocol.tvl
- args: {"chain":"solana","protocolSlug":"raydium"}
- envelope_fields: chain, raw
- vendor_response_fields: address, chainTvls, chains, cmcId, currentChainTvls, description, gecko_id, hacks, hallmarks, id, isParentProtocol, logo, mcap, misrepresentedTokens, name, otherProtocols, raises, symbol, tokens, tokensInUsd, treasury, tvl, twitter, url
- series trimmed to last 3 points post-recording (fixture-size finding, cycle 2): every `chainTvls[*].tvl` array and the top-level `tvl` array (5 series total) were sliced to their last 3 entries each; golden tests only ever read the LAST point of each series (`lastTotalLiquidityUsd()`), so trimming loses no test coverage. All non-series fields are preserved byte-for-byte from the original 2026-07-22 live capture; only array LENGTH changed, never any individual point's own values. File shrank to ~4KB.
