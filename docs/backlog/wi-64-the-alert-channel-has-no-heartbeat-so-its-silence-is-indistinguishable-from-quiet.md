---
id: WI-64
type: work-item
status: done
opened_at: 2026-08-24
slug: wi-64-the-alert-channel-has-no-heartbeat-so-its-silence-is-indistinguishable-from-quiet
effort: S
value: 'makes an alert-channel outage visible on the day it starts instead of whenever somebody happens to look'
source: L-21, reclassified 2026-08-24
resolved_at: 2026-08-24
resolved_by: 'onchain-verify + onchain-error-alert: Record delivery → Write delivery, read daily against AlertHeartbeatMaxAgeMs'
---

# WI-64 — the alert channel has no heartbeat, so its silence is indistinguishable from quiet

> **Закрыто 2026-08-24.** Каждая ПОДТВЕРЖДЁННАЯ доставка в Telegram пишет строку `alert.delivered`
> в `onchain.diagnostics`, а `onchain-verify` ежедневно сообщает возраст свежайшей строки против
> `AlertHeartbeatMaxAgeMs` из своего узла `Set Parameters` (26 ч).
>
> **Набросок этой записи был неполон, и это выяснилось при реализации.** Она предлагала писать
> строку только из `onchain-error-alert`. Но обработчик запускается лишь тогда, когда что-то упало,
> поэтому его строки в одиночку не отличают «инцидентов не было» от «канал мёртв» — то есть не
> закрывают ровно тот вопрос, который вынесен в заголовок. Поэтому регулярный пульс даёт ЕЖЕДНЕВНЫЙ
> отчёт `onchain-verify`, а отправки обработчика — дополнительные. Неделя без инцидентов теперь всё
> равно оставляет строку в сутки, и её отсутствие означает «не ушло», а не «ничего не случилось».
>
> **Запись — ребро, а не соседний узел.** `Report → Record delivery → Write delivery` сцеплены
> цепочкой, поэтому строка появляется только если Telegram принял сообщение; веер рядом с узлом
> отправки записывал бы её и при неудачной доставке. Порядок тоже намеренный — Telegram первым: при
> недоступной БД оповещение всё равно уходит, теряется только пульс.
>
> **Проверяющий — не сам канал.** БД на той же VM и не требует egress, поэтому остаётся достижимой
> ровно тогда, когда исходящий путь недоступен. Второй мессенджер без собственного пульса был бы
> двумя молчаниями вместо одного — тело записи это запрещало, и запрет соблюдён.
>
> **Порог живёт в узле-параметре, а не в запросе и не в рендерере** (L-3). Он обязан превышать сутки:
> запрос выполняется ДО сегодняшней отправки и читает строку предыдущего цикла, так что здоровый
> возраст — около 24 ч, а 26 ч оставляют запас на дрожание расписания. Отсутствующий порог и
> отсутствующая строка оба считаются дефектом, а не «нормой» (M6): пульс без границы не под
> наблюдением, а «доставок не было ни разу» — это именно то состояние, которое проверка называет, и
> оно снимается само на следующем прогоне.
>
> **Доказано доставкой, а не запросом** (L-4). Живьём 2026-08-24:
> - прогон 1 — `📵 alert channel: no confirmed delivery on record`, Telegram вернул `ok: true`,
>   `message_id: 39`; в `onchain.diagnostics` появилась строка `01M0T3520X2ADVF1WHRWZV2BS6`;
> - прогон 2 — `📡 alert channel: 0h since last confirmed delivery (bound 26h)`, то есть обе ветки
>   проверки пройдены, а не одна;
> - путь отказа — одноразовый workflow `onchain-probe-wi64` с настоящим падением узла, запущенный в
>   режиме production; в БД легла строка
>   `{"workflow":"onchain-error-alert","channel":"telegram","about":"onchain-probe-wi64"}`; проба
>   удалена с инстанса.
>
> **Два побочных факта, найденных по дороге, записаны в `CLAUDE.n8n.md`:** `errorWorkflow` НЕ
> вызывается для ручного запуска (ручная проба не доказывает ничего о пути оповещения), и ручные
> запуски идут через `task-runners-main`, который на этом инстансе молчит с 2026-08-13 — два ручных
> прогона умерли по «Task request timed out after 60 seconds», тогда как production-прогон занял 1.1 с.
>
> **Импортёр перестал терять третье имя учётки.** Строку пишет наименее привилегированная
> `Onchain engine state`, а `import_with_relink.py` знал только два имени — то есть три workflow'а
> уехали бы на чужой инстанс с чужим id учётки. Имя добавлено (`--engine-cred-id`), а неизвестное имя
> теперь ОТКАЗ, а не предупреждение. Собственная проверка этой правки поймала, что патч осиротил цикл
> подстановки `ChatID` внутрь ветки `raise` — `ast.parse` этого не видит (M3).

**What is missing.** Nothing tells anyone that `onchain-error-alert` has stopped delivering. It is
the terminal reader for every health signal this project produces — the snapshotter's
`Check dropped`, `onchain-verify`'s report, `onchain-retention`'s `Check outcomes` — and it is the
one workflow whose own failure it cannot report, because it IS the reporter.

**Why this is worth doing even though the outage that surfaced it was not a defect.**
[L-21](../issues/l-21-nine-consecutive-telegram-alerts-failed-over-five-days-and-nothing-reported-it.md)
recorded nine consecutive undelivered alerts across five days. The cause turned out to be the laptop
hosting the VM having no internet — no repair needed anywhere in the engine. That makes the gap
MORE worth closing, not less: a laptop going offline is a routine event, so the same five-day
silence will recur on a cause nobody will call a defect either. It was noticed by accident, during
an unrelated acceptance.

**The shape a fix has to have.** The checker cannot be the alert channel. `onchain-verify` runs
daily and sends Telegram through the same credential and the same egress, so it goes down with it —
a second silent channel rather than a check. The signal has to land somewhere the same failure does
not reach.

The cheapest candidate: `onchain-error-alert` writes one row to `onchain.diagnostics` on a
SUCCESSFUL send, and the daily freshness gate reads that row's age. The database is on the same VM
and needs no egress, so it stays reachable exactly when the outbound path does not. A missing row
then means "the last alert did not get out", which is the fact nobody has today.

**What must NOT be done.** Moving alerts to a second transport without keeping this one measured.
Two channels with no heartbeat is two silences instead of one.

**Acceptance.** An alert-channel outage lasting more than one daily cycle produces a visible signal
that does not itself depend on the alert channel.
