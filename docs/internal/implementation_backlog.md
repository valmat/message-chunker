# Implementation Backlog

Цель файла: фиксировать конкретные задачи на реализацию, которые уже вытекают либо из подтверждённых багов кода, либо из принятых уточнений RFC.

Ограничения, которые надо сохранять при любых исправлениях:

- библиотека остаётся transport-agnostic;
- библиотека остаётся изолируемой и детерминированной;
- исправления должны быть проверяемы обычными unit/integration tests без SDK транспорта и без network;
- не размывать RFC v1 ради локального workaround, если проблема уже покрыта спецификацией.

## Open Tasks

- [ ] `rich-html` soft split режет абзац посередине слова, хотя внутри fitting window есть более мягкая граница
  Суть:
  В `split-blocks-soft` для `rich-html` длинный paragraph может закончиться на середине слова, хотя RFC требует предпочитать sentence end / `;` / `,` / whitespace и использовать forced split только в самом конце.

  Подтверждение:
  Воспроизводится на кейсе из [docs/internal/ISSUES/issue-01-rich-html-soft-split-mid-word.md](docs/internal/ISSUES/issue-01-rich-html-soft-split-mid-word.md#L1).
  На текущем коде `planDelivery(...)` с `safeTextBudget: 240` даёт первый chunk, заканчивающийся на `дели`, а второй начинается с `ть`.

  Почему это баг кода, а не RFC:
  RFC уже задаёт нормативное поведение:
  [docs/rfc.md](docs/rfc.md#L620) требует искать максимальный допустимый префикс и предпочитать более мягкие границы.
  [docs/rfc.md](docs/rfc.md#L648) задаёт приоритеты для paragraph: sentence end -> `;` -> `,` -> whitespace -> forced Unicode-safe split.
  После уточнения RFC отдельно зафиксировано, что forced split допустим только если внутри maximal fitting prefix нет более мягкой допустимой границы.

  Статус spec vs implementation:
  Spec-gap по этому кейсу закрыт.
  Дальше это implementation bug и missing regression coverage.

  Вероятный root cause:
  В [src/planner.js](src/planner.js#L423) функция `splitTextNode()` для `mode === 'rich-html'`:
  1. вычисляет `maxLen` через escaped-length fitting;
  2. берёт `candidate = textValue.slice(0, maxLen)`;
  3. вызывает `splitByParagraphRules(candidate, candidate.length)`.
  Из-за этого paragraph-rule splitter видит текст, который уже "помещается", и возвращает `null`, то есть readable boundary внутри окна не выбирается.
  После этого код уходит в fallback:
  [src/planner.js](src/planner.js#L433)
  Но `unicodeSafeSplit(candidate, candidate.length)` на практике возвращает весь `candidate` без дополнительного реального сдвига split point.
  В результате граница остаётся на "жёстком" конце fitting prefix, что и даёт mid-word split.

  Что, вероятно, надо сделать:
  Разделить две задачи:
  1. найти максимальное source-text окно, которое влезает по rendered rich-html длине;
  2. внутри этого окна выбрать лучшую читаемую границу справа налево;
  3. forced Unicode-safe split использовать только если readable boundary в этом окне реально нет.

  Что нужно имплементировать:
  1. Исправить `rich-html` path в `splitTextNode()`, чтобы paragraph boundary search действительно мог выбрать более раннюю мягкую границу внутри fitting prefix.
  2. Убрать ложный fallback в forced split, если внутри fitting prefix есть `sentence end`, `;`, `,` или `whitespace`.
  3. Проверить, что исправление не меняет принятый в RFC maximal-packing подход, а только убирает преждевременный forced split.

  Ограничения на фикс:
  Не привязывать решение к Telegram или другому транспорту.
  Не ломать текущую модель `markdown -> normalized IR -> planner -> renderer -> typed chunks`.
  Сохранить детерминизм и current sourceRange semantics.

  Что с тестами сейчас:
  Базовые paragraph boundary tests уже есть, но они проверяют утилиту plain-text split, а не `rich-html` path:
  [test/splitter.test.js](test/splitter.test.js#L5)
  Интеграционные tests для `split-blocks-soft` сейчас проверяют в основном chunk count и budget, но не точную rich-html границу:
  [test/planner.test.js](test/planner.test.js#L145)

  Что надо дописать:
  1. Regression test на `planDelivery()` с realistic long paragraph в `rich-html`, который проверяет exact chunk contents.
  2. Отдельный кейс, где внутри fitting window есть whitespace, но нет sentence boundary.
  3. Кейс с escaped HTML-sensitive text (`&`, `<`, `>`) в `rich-html`, чтобы rendered-length fitting не ломал boundary selection.
  4. Явную проверку, что forced split используется только когда readable boundary действительно отсутствует.

  Связанные материалы:
  [docs/internal/ISSUES/issue-01-rich-html-soft-split-mid-word.md](docs/internal/ISSUES/issue-01-rich-html-soft-split-mid-word.md#L117)

- [ ] Добавить `hadForcedSplit` в diagnostics и довести реализацию до нового RFC-контракта
  Суть:
  После уточнения RFC diagnostics должны минимально сигнализировать, использовался ли в итоговом плане хотя бы один forced Unicode-safe split.

  Почему это не просто follow-up идея:
  Это уже принятое уточнение RFC, а значит код и тесты должны быть синхронизированы с новым контрактом.
  Нормативные места:
  [docs/rfc.md](docs/rfc.md#L844)
  [docs/rfc.md](docs/rfc.md#L1019)

  Что нужно имплементировать:
  1. Расширить runtime shape `PlanDiagnostics` полем `hadForcedSplit`.
  2. Научить planner выставлять `hadForcedSplit = true`, если хотя бы одна фактическая граница чанка в финальном плане была получена forced Unicode-safe split.
  3. Убедиться, что семантика одинакова для `planDelivery()` и `replanTail()`.
  4. Не вводить при этом per-chunk split reasons, `hadMidWordSplit` и другие более тяжёлые diagnostics, которые мы сознательно не приняли в RFC.

  Где смотреть в коде:
  Типы diagnostics:
  [src/types.js](src/types.js#L103)
  Сборка diagnostics:
  [src/planner.js](src/planner.js#L1420)
  Текущее plain-text / forced split logic:
  [src/splitter.js](src/splitter.js#L1)
  [src/planner.js](src/planner.js#L423)

  Что с тестами сейчас:
  Есть tests на boundary selection и forced split как таковой, но нет явной проверки поля `hadForcedSplit` в публичных diagnostics:
  [test/splitter.test.js](test/splitter.test.js#L1)
  [test/planner.test.js](test/planner.test.js#L305)
  [test/replan.test.js](test/replan.test.js#L206)

  Что надо дописать:
  1. Test для `planDelivery()`, где forced split действительно случается и `diagnostics.hadForcedSplit === true`.
  2. Test для `planDelivery()`, где используются только мягкие границы и `diagnostics.hadForcedSplit === false`.
  3. Test для `replanTail()`, который подтверждает ту же семантику для replanned tail.

- [ ] Усилить regression fixtures для splitting и `replanTail()` на realistic content
  Суть:
  Это не новая дыра runtime-spec и не новый алгоритмический bug сам по себе.
  Это internal engineering/testing backlog: важные пользовательские сценарии должны быть закреплены tests так, чтобы улучшения split quality и replanning не ломались тихо.

  Почему это не тащим дальше в RFC:
  Текущий runtime-контракт `replanTail()` уже достаточно силён.
  Здесь проблема в основном не в недостающей семантике API, а в том, что часть полезных пользовательских сценариев пока не закреплена достаточно жёсткими regression tests.

  Что нужно покрыть:
  1. `rich-html` paragraph split quality с проверкой exact chunk contents, а не только chunk count.
  2. Case с escaped HTML-sensitive text (`&`, `<`, `>`), где rendered-length fitting влияет на split boundary.
  3. `replanTail()` case, где `too-long` с изменённым budget и/или более агрессивной strategy реально меняет tail boundaries, а не только формально возвращает новый plan.
  4. `replanTail()` case, где `invalid-markup` явно переключает undelivered tail в `plain-text`.
  5. Reject внутри уже split block, чтобы было жёстко доказано отсутствие дублирования delivered prefix.

  Что уже частично есть:
  Есть хорошие tests на `replanTail()`, `invalid-markup`, `sourceRange` и некоторые rich-html cases, но покрытие не полностью выстроено как набор целевых regression fixtures под user-facing expectations.
  [test/replan.test.js](test/replan.test.js#L613)
  [test/complex.test.js](test/complex.test.js#L560)
  [test/planner.test.js](test/planner.test.js#L145)

  Цель:
  Не расширить спецификацию, а повысить уверенность, что принятые RFC-решения и bugfixes останутся защищены в кодовой базе.

- [ ] После стабилизации RFC синхронизировать ключевые пользовательские semantics в README
  Суть:
  Пользователи, скорее всего, читают в первую очередь `README.md`, а не полный RFC.
  После завершения текущего цикла RFC-уточнений нужно проверить, какие важные решения уже должны быть отражены в публичной документации.

  Что стоит проверить в первую очередь:
  1. Единый `usedStrategy` / `usedMode` на весь `DeliveryPlan`.
  2. Смешанный rich/plain результат допускается только через отдельный `replanTail()`, а не внутри одного плана.
  3. `hadForcedSplit` в diagnostics.
  4. Семантика выбора split boundary внутри maximal fitting prefix.
  5. Важные ограничения rich-html, связанные с final rendered length / escape overhead.
