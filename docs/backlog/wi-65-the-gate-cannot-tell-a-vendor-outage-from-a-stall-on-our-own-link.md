---
id: WI-65
type: work-item
status: done
opened_at: 2026-08-24
slug: wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link
effort: S
value: 'stops a stall on our own uplink from being filed as several simultaneous vendor incidents, and stops a real one from being dismissed as weather'
source: measured while closing WI-63/WI-64, 2026-08-24
resolved_at: 2026-08-24
resolved_by: 'eval/link-probe.mjs + probes.json linkProbes + TC-UNIT-17/18; owner decision on the measurement rule'
---

# WI-65 — the gate cannot tell a vendor outage from a stall on our own link

> **Закрыто 2026-08-24** — решение владельца по трём вопросам того же дня: (1б) мерить канал **во
> время** прогона и записывать вердикт рядом с вердиктом гейта; (2б) граница — максимум по **двум**
> подряд прогонам на измеренно стабильном канале; (3а) настоящую деградацию вендора принимать
> поднятием границы до `reviewBy`, а не оставленным заблокированным гейтом.
>
> **Инструмент.** `eval/link-probe.mjs`: три хоста из `probes.json` → `linkProbes`
> (`www.cloudflare.com`, `api.github.com`, `www.google.com`), проба каждые 30 с всё время прогона,
> вердикт в отчёте, в артефакте и в строке журнала. Проба стартует первой и останавливается
> последней, поэтому измеренное окно совпадает с окном, в котором звали вендоров, — ручная проба
> 2026-08-24 оставляла ровно эту щель.
>
> **Мерится TCP-connect, а не время ответа, и это выбор по замеру.** Время ответа смешивает сеть с
> работой самого сервера — именно поэтому провал того дня выглядел как одинаковый ПОЛ в ~1.6 с, а не
> как чистый сигнал. Connect почти чистая сеть: 6–17 мс на здоровом канале против 215–502 мс на
> провале, разница в двадцать пять раз, тогда как времена ответа отличались втрое. Второе основание —
> `fetch` в Node вообще не отдаёт транспортных таймингов, так что HTTP-проба была бы вынуждена
> выводить connect из общего времени, то есть ровно из той смеси, которой мы избегаем. Третье —
> TCP-рукопожатие ничего не просит у хоста: ни приложения, ни квоты, ни данных, поэтому проба раз в
> 30 секунд вежлива к хостам, которые нам ничего не должны.
>
> **Хосты — данные и намеренно вне движка** (`probes.json`, то же правило, что у `referenceSources`):
> хост под тестом не может быть контролем для теста, и `mempool.space` исключён отдельно — его зовёт
> сам eval, так что его медленный ответ читался бы как медленный канал. `TC-UNIT-18` проверяет оба
> запрета механически, против `adapterRegistrations` и против `referenceSources`.
>
> **Порог 100 мс — оборонительный, не измеренный потолок**, и на него нельзя ссылаться как на
> вендорский предел: он на порядок выше здоровых показаний и втрое-впятеро ниже провальных, так что
> оба наблюдавшихся состояния ложатся однозначно по свои стороны.
>
> **`unknown` и `degraded` разведены намеренно.** Оба запрещают ставить границу, но первое говорит
> «никто не смотрел», а второе — «канал был плохой», и это отправляет читателя в разные места.
>
> **Вердикт ничего не подавляет** — запрет из тела записи соблюдён буквально: строка печатается
> РЯДОМ с отказами, а не вместо них. Гейт, который сам решает, когда перестать себе верить, — это
> гейт, который нельзя проверить.
>
> Правила (2б) и (3а) записаны в `$comment` файла `eval/acknowledged.json` — там же, где живёт
> контракт границ, — вместе с ограничением: почти полная авария вендора деградацией не считается и
> возвращается к трём выходам (вендор поднялся, способность снята с рекламы, её обслуживает второй
> адаптер).

**What is missing.** A blocked gate names the vendors whose rows failed. It says nothing about the
one condition that makes several unrelated vendors fail at once: our own egress.

**Measured 2026-08-24, and it changed a verdict.** A gate run reported four `capability deadline
exceeded` rows across `protocol.tvl.history` and `chain.tvl.history`, and pushed both blockscout
acknowledgements over their bounds — three vendors at once, which the report presented as three
independent facts. Probing five unrelated hosts in the same minute:

```
200 1.64s (conn 0.42s)  api.llama.fi
200 1.57s (conn 0.35s)  api.dexscreener.com
200 1.74s (conn 0.50s)  api.coingecko.com
200 1.64s (conn 0.22s)  mcp.blockscout.com
200 1.83s (conn 0.25s)  mempool.space
```

A uniform ~1.6 s floor with slow CONNECT times across five companies and five CDNs is not five
incidents. Ninety seconds later the same hosts answered in 0.39–0.53 s with 0.012 s connects, from
the same machine, unchanged code — so the stall was ours and transient. The gate had measured our
link and reported it as vendor drift.

**Why this matters more than it sounds.** The acknowledgement mechanism's whole discipline is that
raising a bound is an act of MEASUREMENT (RF-10). A bound raised on a run taken during a local stall
bakes weather into the record permanently, and the next real widening then arrives inside the slack
that stall bought. The error runs the other way too: a genuine vendor outage gets dismissed as "the
link was probably bad" by whoever remembers this note.

**The shape a fix has to have.** The gate already fetches an independent reference source
(`probes.json` → `referenceSources.btcTipHeight`) that is deliberately not an engine adapter. The
same idea, applied to latency: probe a small set of unrelated hosts at the START and END of a run,
record the floor and the spread in the artifact and the ledger line, and print one line above the
failures. A run whose own floor moved by an order of magnitude is a run whose vendor verdicts are
not evidence.

**What must NOT be done.** Auto-suppressing failures when the link looks slow. The number belongs
next to the verdict so a human reads both; a gate that decides on its own when to stop believing
itself is a gate nobody can audit. And the probe set has to stay outside the adapters, for the same
reason `btcTipHeight` does — a source we answer from cannot be the check on that answer.

**Acceptance.** A blocked gate run states what our own egress was doing while it ran, in the report
and in the ledger line, so a reader can tell a vendor incident from a local one without re-measuring
by hand hours later.
