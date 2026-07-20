# Verification Corrections

> Adversarial verification pass over the most load-bearing claims. 15 claims checked, 5 corrected/uncertain. Each entry below was REFUTED or flagged UNCERTAIN — use the corrected statement.

## 1. [REFUTED] Dune Analytics has an OFFICIAL hosted Dune MCP server: Remote MCP over Streamable HTTP at https://api.dune.com/mcp/v1 (POST /mcp/v1, GET /mcp/v1 stream resume);…

**Evidence:** Primary source (official docs) verified the official server, transport, auth, categories, resources, and setup; the per-category tool enumeration totals 26, contradicting the claimed 29. The official-vs-community distinction and the four community servers were each verified against GitHub/source listings.

**Corrected:** The official hosted Dune MCP server is real and is hosted/authenticated/invoked exactly as claimed (Streamable HTTP at https://api.dune.com/mcp/v1 with POST/GET, OAuth 2.0 + PKCE S256 scope mcp:dune:full or x-dune-api-key/?api_key=, 6 tool categories + 2 resources, setup via claude mcp add / Cursor / Claude Desktop / OpenCode / Codex CLI), and the four community/unofficial REST-API servers (kukapay, ekailabs, demomagic, deacix) all exist as described. However, it exposes 26 tools, not 29: Discovery 5, Query Lifecycle 5, Materialized Views 6, Visualization 5, Dashboard 4, Account 1.

**Sources:**
- https://docs.dune.com/api-reference/agents/mcp
- https://dune.com/blog/dune-mcp
- https://github.com/kukapay/dune-analytics-mcp
- https://github.com/ekailabs/dune-mcp-server
- https://github.com/demomagic/dune-mcp-server
- https://lobehub.com/mcp/deacix-dune-mcp


## 2. [REFUTED] Surf (AskSurf.ai) API/Skill pricing: Developer side gives 30 free credits/day with no key, then pay-as-you-go credit-metered access (buy after signup at agents.…

**Evidence:** CONFIRMED via primary GitHub README, Surf FAQ, Surf blog, Surf X post, and Bitget coverage; REFUTED on 'USD/month not public' (FAQ lists Pro $49 and Max-1..7 at $100-$1,000); meta.credits_used and pay-as-you-go wording UNVERIFIED (blog body never rendered, absent from README/FAQ/docs).

**Corrected:** The Surf API is usable for an indie/agent build: 30 free credits/day per IP with NO API key (verified, official GitHub README), 83+ endpoints, install via Surf CLI, then sign up at agents.asksurf.ai for a key and higher limits. A $200K launch giveaway grants tiered credits ($3–~$100) via X/GitHub/wallet scoring. CORRECTION to the claim: exact consumer USD/month prices ARE public via the asksurf.ai FAQ — Pro is $49/mo ($348/yr) and Max has 7 sub-tiers at $100/$200/$300/$400/$600/$800/$1,000 per month; only the standalone /pricing page is JS-rendered. Pro+Max (7 Max sub-tiers), Studio monthly-refreshing credits, Plus discontinued 2026-04-01, and API billing being separate from the Chat/Studio subscription are all confirmed. NOT independently verifiable from primary sources: the per-response 'meta.credits_used' field and the explicit 'pay-as-you-go credits' wording (plausible but unconfirmed; no public per-call credit-cost table exists).

**Sources:**
- https://raw.githubusercontent.com/asksurf-ai/surf-skills/main/README.md
- https://github.com/asksurf-ai/surf-skills
- https://asksurf.ai/faq
- https://asksurf.ai/blog/en/surf-skill-the-crypto-data-api-for-ai-agents
- https://www.bitget.com/news/detail/12560605350502
- https://x.com/SurfAI/status/2042087718654730461
- https://agents.asksurf.ai/
- https://agents.asksurf.ai/docs/cli/cli


## 3. [REFUTED] Dune Sim APIs (sim.dune.com) pricing is usage-based (Compute Units/CUs), scaling free->enterprise; free/developer tier ~1,000,000 CUs and 5 RPS; billed by month…

**Evidence:** see evidence field

**Corrected:** The pricing mechanics are roughly right (usage-based Compute Units; Balances = 1 CU per chain per request — confirmed; sim.dune.com/pricing 308-redirects to dune.com/pricing — confirmed; free tier widely reported as ~1,000,000 CUs / 5 RPS but NOT confirmable from a directly-readable primary doc, treat as approximate; exact paid $ bundles not public). HOWEVER, the key conclusion is wrong for a NEW build: the Sim API is being retired on August 1, 2026, per multiple independent migration guides (Allium, Alchemy, Zerion) and an official Dune "Sunsetting Sim" blog post, with new signups reportedly disabled. For an indie/agent build started in/after mid-2026 it is therefore NOT a viable choice — you likely cannot sign up, and any integration would need migration to Alchemy Data APIs, Allium Real-time API, or Zerion API before the cutoff. Note: the official sunset blog URL was not directly fetchable (404 to crawler) and docs.sim.dune.com still shows no deprecation banner, so the shutdown — while strongly corroborated — rests on secondary sources; treat the Aug 1 2026 date as high-confidence-but-not-primary-confirmed.

**Sources:**
- https://sim.dune.com/pricing (308 redirect to dune.com/pricing - confirmed)
- https://docs.sim.dune.com/compute-units (CU model; Balances = 1 CU per chain - confirmed)
- https://dune.com/pricing (redirect target)
- https://www.allium.so/blog/dune-sim-is-shutting-down-heres-how-to-migrate-to-allium/ (retiring Aug 1 2026; published 2026-05-19)
- https://www.alchemy.com/blog/migrating-from-sim-to-alchemy-data-apis (Aug 1 2026; cites official dune.com/blog/sunsetting-sim)
- https://zerion.io/blog/migrating-from-dune-sim-to-zerion-api/ (migration alternative)
- https://dune.com/blog/sunsetting-sim-idx (official Sunsetting Sim post - surfaced in search, returned 404 to fetcher)
- https://docs.sim.dune.com/ (no deprecation banner as of fetch; free tier described as active)


## 4. [REFUTED] DexScreener: Free, no API key. Rate limits: 60 req/min for token-profiles, token-boosts, orders, ads, community-takeovers, metas/trending; 300 req/min for DEX p…

**Evidence:** The free-tier mechanics are CONFIRMED and the API is fully usable for an indie/agent build: the public REST API requires no API key and is openly callable. The official reference (docs.dexscreener.com/api/reference) explicitly annotates token-profiles, community-takeovers, ads, and metas/trending as "rate-limit 60 requests per minute"; token-boosts and orders render via OpenAPI blocks but multiple independent sources group "Token Profile/Boost endpoints: 60 requests per minute," matching the claim. The DEX data endpoints (latest/dex/pairs, latest/dex/search, token-pairs, tokens) are documented/reported at "300 requests per minute," also matching. HOWEVER, the claim's assertion "No public paid API tier" is FALSE. DexScreener's own primary source — the API Terms & Conditions (docs.dexscreener.com/api/api-terms-and-conditions) — states verbatim: "Users have the option to choose between a free and paid version of the API Services, with the specifications, such as rate limiting and requests per second, detailed during the API Services checkout stage." That is a paid API-access tier (offering higher rate limits / RPS), not merely paid token-profile/boost listings. Because the claim contains this material false statement, it cannot be marked CONFIRMED. Net: free tier facts (no key, 60/300 RPM) are accurate, but the no-paid-API-tier qualifier is wrong.

**Corrected:** DexScreener offers a free, no-API-key public REST API suitable for indie/agent builds. Free-tier rate limits: ~60 requests/minute for the token-profiles, token-boosts, orders, ads, community-takeovers, and metas/trending endpoints; ~300 requests/minute for the DEX data endpoints (latest/dex/pairs, latest/dex/search, tokens, token-pairs). Contrary to the claim, DexScreener DOES offer a paid version of the API Services in addition to the free version — its API Terms & Conditions state users can "choose between a free and paid version of the API Services," with higher rate limiting and requests-per-second specified at the API Services checkout stage. So a paid API-access tier exists, separate from the (also-paid) token-profile/boost promotional listings.

**Sources:**
- https://docs.dexscreener.com/api/reference
- https://docs.dexscreener.com/api/api-terms-and-conditions
- https://github.com/openSVM/dexscreener-mcp-server


## 5. [REFUTED] Repo "coinpaprika/dexpaprika-mcp" claimed 40 stars, active (2026-06-22), license MIT, recommendation adopt-as-dependency. It is the official (CoinPaprika) MCP s…

**Evidence:** Most of the claim is CONFIRMED via primary sources, but two hard numbers ("14 tools", "33 networks") are stale/incorrect against the current code and live API, so the overall claim as stated is refuted. CONFIRMED: GitHub API for coinpaprika/dexpaprika-mcp returns stargazers_count=40 (exact match), license MIT (key=mit, spdx=MIT, plus LICENSE file and package.json "license":"MIT"), archived=false/disabled=false, fork=false, owner.login=coinpaprika owner.type=Organization (official CoinPaprika org, blog coinpaprika.com; npm maintainers it_coinpaprika/0xmattsroka). Maintained/active: pushed_at=2026-06-22T08:16:18Z (8 days before the claim's stated 2026-06-30), recent commits May-June 2026 incl. "Sync self-host package to hosted worker v2.0.0", "Add CI (node matrix + MCP smoke test)", current version 2.0.0. README + CHANGELOG confirm it IS an official MCP server over the DexPaprika DEX-data API; tool families match exactly: getPoolDetails (price, volume, TVL, tokens), getPoolOHLCV (OHLCV candles), getPoolTransactions (txns), getTokenDetails/getTokenMultiPrices (token details/pricing), and DEX comparisons across Uniswap/SushiSwap/Raydium (sample prompts explicitly name these). README "Rate Limits & Performance" states Response Time 100-500ms and Data Freshness updated every 15-30s, matching the claim. REFUTED specifics: (1) Tool count is NOT 14. The current src/index.js (v2.0.0) registers 16 read tools via registerReadTool() [getNetworks, getCapabilities, getNetworkDexes, getNetworkPools, getDexPools, getNetworkPoolsFilter, getPoolDetails, getPoolOHLCV, getPoolTransactions, getTokenDetails, getTokenPools, getTokenMultiPrices, filterNetworkTokens, getTopTokens, search, getStats] plus a 17th write tool submitFeedback; CHANGELOG explicitly states tools_count: 17. The README header still says "14 tools" and its table omits filterNetworkTokens, getTopTokens, and submitFeedback. (2) Network count is NOT 33. The live DexPaprika API (https://api.dexpaprika.com/networks, HTTP 200) returns 35 networks; the CHANGELOG explicitly states: 'Stale "33 networks" corrected to 35.' The README still says "33 supported blockchain networks". So adopt-as-dependency is reasonable, but the "14 tools for 33 networks" figures are outdated (actual: 17 tools, 35 networks).

**Corrected:** coinpaprika/dexpaprika-mcp is a real, official CoinPaprika MCP server (MIT, 40 stars, actively maintained — last push 2026-06-22, current version 2.0.0) over the DexPaprika DEX-data API. It currently exposes 17 tools (16 read tools + submitFeedback), NOT 14, and supports 35 blockchain networks, NOT 33 (the README header still cites the stale "14 tools"/"33 networks" figures, but the source code and live API, and the CHANGELOG which says 'Stale "33 networks" corrected to 35' and 'tools_count: 17', show 17 and 35). All other claimed facts (pool details with price/volume/TVL/tokens/txns/OHLCV, token details/pricing, DEX comparisons across Uniswap/SushiSwap/Raydium, ~15-30s data freshness, 100-500ms responses, MIT license, official ownership, adopt-as-dependency) are accurate.

**Sources:**
- https://api.github.com/repos/coinpaprika/dexpaprika-mcp
- https://api.github.com/repos/coinpaprika/dexpaprika-mcp/commits?per_page=5
- https://api.github.com/repos/coinpaprika/dexpaprika-mcp/readme
- https://raw.githubusercontent.com/coinpaprika/dexpaprika-mcp/main/src/index.js
- https://raw.githubusercontent.com/coinpaprika/dexpaprika-mcp/main/CHANGELOG.md
- https://raw.githubusercontent.com/coinpaprika/dexpaprika-mcp/main/package.json
- https://api.github.com/orgs/coinpaprika
- https://api.dexpaprika.com/networks
- https://registry.npmjs.org/dexpaprika-mcp

