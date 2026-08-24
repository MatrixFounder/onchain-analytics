---
id: WI-63
type: work-item
status: done
opened_at: 2026-08-24
slug: wi-63-the-shared-limiter-rate-is-not-measurable-from-outside-with-todays-probe-set
effort: M
value: 'turns UC-2 from an assertion about session plumbing into a measurement of the vendor rate two sessions actually produce'
source: task 014-33, the http-shared-limiter case
resolved_at: 2026-08-24
resolved_by: 'eval/cases/http-shared-limiter-rate.mjs + TC-UNIT-16'
---

# WI-63 — the shared-limiter RATE is not measurable from outside with today's probe set

> **Закрыто 2026-08-24** новым кейсом `eval/cases/http-shared-limiter-rate.mjs` — пятой строкой
> транспортного набора. Живой гейт: `transport:http-shared-limiter-rate ✅ 17796` (2026-08-24).
>
> **Ось аргументов найдена не там, где запись предлагала искать.** Три кандидата тела проверены по
> коду, и два отпали замером, а не вкусом: `protocol.tvl` с тех пор, как L-7 увёл его на общий
> каталог, вообще не делает запроса на слаг, а `protocol.tvl.history` его делает — но документ
> одного протокола доходит до 27.57 МиБ, и два десятка таких на каждый прогон гейта это не цена
> измерения, это новая проблема. Взят четвёртый: `wallet.balances.native` на `rpc-evm`, где ось —
> адреса, а не курируемый список сетей. Спросить у ноды баланс адреса без средств — не ложь вендору:
> ноль там законный ответ, и `probes.json` уже стоит на этом же основании для своего нулевого
> адреса. Адреса начинаются с `0x1000`, чтобы не попасть в прекомпайлы `0x01..0x0a`.
>
> **Утверждение выведено, а не вписано.** Ковш читается из `adapterRegistrations` — того же объекта,
> который в рантайме читает `adapters/rpc-evm/call-rpc.ts`, — поэтому второй копии
> `{capacity, refillPerSec}` в кейсе нет, и запрет тела соблюдён буквально. Размер пробы тоже
> производная: при `n` различных вызовах, разложенных поровну на две сессии, один общий ковш
> навязывает `(n − capacity)/refill` секунд ожидания, а два по-сессионных — `(n/2 − capacity)/refill`,
> так что расстояние между гипотезами ровно `n / (2 × refill)` секунд. Отсюда `n` выбирается так,
> чтобы расстояние превышало 2 с; при сегодняшних `{5, 1}` это `n = 12`, пол общего ковша 7000 мс
> против 1000 мс по-сессионного, решающая середина 4000 мс.
>
> **Шум измерен, а не предположен.** Контрольное плечо в `capacity` вызовов помещается внутрь ковша,
> то есть меряет только задержку вендора, и вычитается из основного — в ту же минуту, на том же
> хосте. Перед каждым плечом кейс ждёт полный долив (`capacity/refill`), поэтому результат не зависит
> от того, что расходовало ковш до него. Один разогревочный вызов оплачивает DNS и TLS, чтобы
> завышенный контроль не вычел настоящее ожидание и не объявил здоровый лимитер по-сессионным.
>
> **Первая редакция вердикта была неверна, и её поймал собственный гейт.** Кейс сначала вычитал
> контрольное плечо из основного и сравнивал разность с серединой между гипотезами. Вычитание
> выглядит аккуратным — оно убирает задержку вендора, — но наследует весь её шум, причём знаком не в
> ту сторону: ЗАВЫШЕННЫЙ контроль вычитает настоящее ожидание лимитера и объявляет здоровую систему
> по-сессионной. На пятом прогоне 2026-08-24 так и вышло: `measureMs = 7088` при поле общего ковша
> 7000 — лимитер отработал ровно как должен, — а контрольное плечо показало 4420 мс, потому что
> RPC-эндпойнт в те секунды тормозил; разность дала 2668 мс, и кейс сообщил о дефекте, которого нет.
>
> Вердикт переделан в ОДНОСТОРОННЮЮ границу: `measureMs >= sharedFloorMs`, без вычитания. При общем
> ковше это верно по построению при любой задержке вендора, потому что затраченное время — это
> навязанное ожидание ПЛЮС задержка. При двух по-сессионных ковшах это может оказаться верным только
> если одна задержка перекрывает расстояние между гипотезами, — и такой прогон НЕ проходит молча:
> контрольное плечо по-прежнему измеряется, и когда его хватает, чтобы объяснить результат само по
> себе, кейс сообщает НЕОПРЕДЕЛЁННЫЙ исход. Проверка, которая не может решить, обязана это сказать;
> «не могу решить», читаемое как «всё хорошо», — это форма L-10. То наблюдение (7088/4420) пришпилено
> отдельным случаем в `TC-UNIT-16`, так что вычитание не вернётся незаметно.
>
> **Отказ измерять оставлен видимым.** Если ковш перенастроят так, что разделить гипотезы можно
> только 24+ вызовами к бесплатному вендору, кейс не проходит молча — он сообщает, что мерить не
> может, и называет, что менять. Пустое «мерить нечем» неотличимо от «померили и всё хорошо», а это
> ровно тот класс, ради которого RF-5 существует.
>
> **Проверяемо офлайн.** Кейс экспортирует `PLAN`, и `TC-UNIT-16` (7 случаев) заново выводит все
> числа из `adapterRegistrations`, проверяет, что гипотезы разделимы, и прогоняет `check()` по
> подставленным наблюдениям — включая случай неполного плеча, где вердикт по времени намеренно НЕ
> выносится: отказ вендора не должен подаваться как дефект разделения ковша.
>
> Соседний `http-shared-limiter.mjs` оставлен как есть — он проверяет другое (различие session id и
> то, что обслужен каждый вызов) и стоит один круг; его докстринг теперь указывает на новый файл
> вместо ссылки на эту запись.

**What is missing.** `eval/cases/http-shared-limiter.mjs` asserts that two HTTP sessions work
concurrently — distinct session ids, every call served, no cross-session interference. It does not
assert what UC-2 is finally about: that the AGGREGATE rate two sessions produce stays inside the
bucket the adapter declares.

**Why it was left out rather than approximated.** Two measurements, both taken 2026-08-24 while the
case was written.

1. **The bucket does not bite inside the reachable range.** `defillama` carries
   `{capacity: 10, refillPerSec: 5}` (`providers.config.ts`), so the first ten calls pass without
   waiting. Distinguishing a shared bucket from a per-session one needs each arm of a comparison to
   exceed ten calls, hence at least twenty-two distinct requests.
2. **A repeat is not a request.** The cache answers a repeated argument without reaching the limiter,
   so the calls have to be twenty-two DISTINCT ones. `eval/probes.json` curates twelve chains in
   total.

An earlier version of the case compared six calls on one session against six split across two, and
reported `9ms versus 312ms`. The second arm was reading the cache the first arm had filled. The case
would have reported a healthy limiter as broken, on evidence that measured the cache.

**What a fix needs.** An argument axis wider than the chain set, on a free capability, whose values
miss the cache by construction. Candidates worth measuring before choosing:

- a capability keyed on something with many valid values (a protocol slug rather than a chain);
- a deliberately cache-missing argument, if any capability has one that is not a lie to the vendor;
- a per-run cache bypass for the transport phase only — which has to be a real seam and not an
  environment key that could be set in production.

**What must NOT be done.** Duplicating `{capacity: 10, refillPerSec: 5}` into the case as a
threshold. It is a second source for a number `providers.config.ts` owns, it goes stale the day that
file is tuned, and the resulting assertion would be resolvable only within noise — a vendor call
costs about 300 ms and the forced wait for twelve calls is 400 ms.

**Acceptance.** The case measures an aggregate rate across two sessions, on enough distinct
arguments that a per-session bucket and a shared one give different answers, and the assertion is
derived rather than pinned.

**Related.** Task 014-33 shipped the case in its narrower form and states the limit in the file
itself, so a later reader finds the reason next to the assertion rather than only here.
