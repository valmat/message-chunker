# MessageChunker — План разработки

## Стадия 1: Инфраструктура и типы
- [x] Установить зависимости (markdown-it)
- [x] Определить все типы и интерфейсы (IR-ноды, TransportProfile, PlanRequest, PlannedChunk, DeliveryPlan, диагностика и т.д.)
- [x] Определить структуру модулей (parser, normalizer, renderer, planner, public API)

## Стадия 2: Парсер и нормализатор
- [x] Реализовать парсинг markdown → IR (на базе markdown-it)
- [x] Нормализация: поддерживаемые блоки (paragraph, heading, list, list_item, quote, code_block, thematic_break)
- [x] Нормализация: инлайн-типы (text, strong, emphasis, inline_code, link, soft_break, hard_break)
- [x] Обработка неподдерживаемых конструкций (таблицы → plain text, raw HTML → literal text, images → text)
- [x] Underscore emphasis (_/__) → literal text (решение из RFC 9.1)
- [x] Тесты парсера/нормализатора (36 тестов)

## Стадия 3: Рендереры
- [x] rich-html рендерер (safe HTML subset: b, i, code, pre, a)
- [x] plain-text рендерер
- [x] Каноническое форматирование блоков (spacing, quote prefix, list markers и т.д.)
- [x] Тесты рендереров (49 тестов)

## Стадия 4: Планировщик (planDelivery)
- [x] Greedy packing алгоритм
- [x] Стратегия preserve
- [x] Стратегия split-blocks
- [x] Стратегия split-blocks-soft (сплит параграфов, list_item, quote)
- [x] Стратегия plain-text
- [x] Стратегия forced-plain-text (Unicode-safe split)
- [x] Эскалация стратегий
- [x] Формирование SourceRange
- [x] Диагностика
- [x] Тесты планировщика (28 тестов)

## Стадия 5: Replanning (replanTail)
- [x] Реализация replanTail()
- [x] Восстановление хвоста из нормализованной IR по sourceRange
- [x] Эскалация стратегий при replanning
- [x] Рефакторинг: вынос planFromIr() из planner.js для переиспользования
- [x] Тесты replanning (17 тестов)

## Стадия 6: Комплексные тесты
- [x] Golden tests (4 теста)
- [x] Property-like тесты: бюджет, always-returns, forced-plain-text, replan prefix, text preservation (33 теста)
- [x] Nasty cases: giant paragraph, giant code block, long line without spaces, giant URL, giant inline code, broken markdown, raw HTML, emoji/ZWJ/combining, nested lists, quote+code+link, reject mid-sequence (26 тестов)

## Стадия 7: Публичный API и документация
- [x] Экспорт публичного API (planDelivery, replanTail, helpers)
- [x] Тесты экспорта через index.js
- [x] README с описанием модуля, API, примерами и ограничениями

## Стадия 8: Финальное ревью — исторический контекст
- [x] splitInlineOnce() — максимально плотное заполнение чанка (partial text node)
- [x] Исторически: `class="language-*"` был убран из rich-html code block; позже RFC был обновлён, и теперь это поведение нужно вернуть на следующей итерации
- [x] Исторически: в `replanTail()` была добавлена runtime-валидация `rejectReason`; после обновления RFC контракт нужно заново синхронизировать
- [x] Задокументированы осознанные ограничения v1 → [docs/known-limitations.md](docs/known-limitations.md)

## Стадия 9: Актуальные задачи следующей итерации
_Источник истины до синхронизации кода: `docs/rfc.md`. По итогам комплексного ревью см. также `rfc_violations.md`, `issues.md` и добавленные regression-тесты в `packages/message-chunker/test/planner.test.js` и `packages/message-chunker/test/replan.test.js`._

### Открытые задачи — в порядке важности

#### Критично
- [x] Исправить возврат oversized-чанка для длинного continuation-блока внутри `list_item`: `planDelivery()` не должен возвращать чанки длиннее `safeTextBudget`; см. `rfc_violations.md` (п. 1) и `issues.md` (пп. 1–2).
- [x] Добавить финальную runtime-валидацию собранного плана в `planDelivery()/planFromIr()`: каждый итоговый чанк должен повторно проверяться по `content.length <= safeTextBudget`, чтобы локальная ошибка в splitter'е не пробивала публичный инвариант; см. `issues.md` (п. 1).
- [x] Исправить обработку длинного `heading`: заголовок должен корректно деградировать по RFC и не ломать `sourceRange`/`replanTail()`; см. `rfc_violations.md` (п. 2) и `issues.md` (п. 3).
- [x] Исправить `sourceRange` для forced-split `heading`, чтобы соседние фрагменты имели разные `sourceRange.start`, а `replanTail()` не переотправлял уже доставленный префикс; см. `rfc_violations.md` (п. 2) и `issues.md` (п. 3).

#### Высоко
- [ ] Явно валидировать входные `strategy` и `preferredMode` в `planDelivery()`, чтобы API не принимал мусорные значения молча и не падал общей internal error; см. `issues.md` (п. 4).
- [ ] Довести diagnostics до полного соответствия RFC для unsupported markdown: raw HTML / tables / другие lowered-to-text конструкции должны выставлять `hadDegradation = true`; см. `rfc_violations.md` (п. 3) и `issues.md` (п. 5).

#### Средне
- [ ] После исправления проблем синхронизировать/расширить regression-тесты так, чтобы новые найденные кейсы оставались закрытыми навсегда: oversized `list_item`, forced-split `heading`, `replanTail()` по заголовку, degradation diagnostics, validation errors; см. `issues.md` и текущие красные тесты.

#### Nice-to-have
- [ ] Улучшить soft-splitting для oversized не-параграфных children внутри `list_item` (`quote`, nested `list`, `code_block`): сейчас они корректно эскалируют стратегию, но могут деградировать раньше, чем строго необходимо.

### Выполнено в предыдущей итерации

#### Контракт RFC → код и документация
- [x] Синхронизировать `RejectReason` с RFC: для модуля каноничны только `too-long` и `invalid-markup`; transport-level ошибки остаются за интеграцией
- [x] Синхронизировать валидацию `TransportProfile` с RFC: `safeTextBudget < 200` должен считаться invalid profile
- [x] Синхронизировать rich-html code block с RFC: вернуть `class="language-*"` для сохранения language info fenced block
- [x] Обновить README: привести описания контракта в соответствие RFC и добавить/обновить сценарии использования (`too-long`, `invalid-markup`, rich-html code block with language info)

#### Синхронизация тестов под обновлённый контракт
- [x] Обновить/добавить тесты для `RejectReason` по новому контракту RFC
- [x] Обновить/добавить тесты для минимального `safeTextBudget >= 200`
- [x] Обновить/добавить тесты на rich-html code block с language info

#### Критичная функциональная доработка, уже завершённая ранее
- [x] Исправить `SourceRange`/`replanTail()` так, чтобы reject внутри split-блока не переотправлял уже доставленный префикс → [docs/refactoring-sourcerange.md](docs/refactoring-sourcerange.md)
- [x] Реализовать точный `SourceRange` для split-fragments по плану из `docs/refactoring-sourcerange.md`
- [x] Научить `replanTail()` восстанавливать хвост по полному `path` + `offsetUtf16`, а не только по `path[0]`
- [x] Добавить регрессионные тесты: reject во 2-м чанке длинного paragraph/list item/quote/code block не должен дублировать уже доставленный префикс

### Уже зафиксированные решения — не переоткрывать без явной причины
- [x] Policy после reject определяется клиентом; библиотека предоставляет ручки (`preferredMode`, `nextStrategy`, `transport.safeTextBudget`, diagnostics), но не хардкодит orchestration
- [x] Модуль различает только `too-long` и `invalid-markup`; прочие transport-level ошибки остаются вне спецификации модуля
- [x] Unreasonable budgets не поддерживаются; в RFC введён минимальный `safeTextBudget` для v1
- [x] Для unsupported markdown достаточно документации/логирования; обязательной продуктовой реакции в v1 не требуется
- [x] Iterator / streaming API — возможное расширение после v1, не задача текущей итерации

### Отложенный техдолг релиза
- [ ] Пересмотреть семантику diagnostics для unsupported markdown после закрытия критичных багов: сейчас это уже оформлено как конкретная открытая задача выше, поэтому сюда относится только возможная последующая полировка структуры diagnostics и observability.

### Definition of done для следующей итерации
- [ ] Ни один путь планирования не возвращает чанк длиннее `safeTextBudget`.
- [ ] `heading` не вызывает дублирование уже доставленного текста при `replanTail()`.
- [ ] `sourceRange` корректен для forced-split фрагментов, в том числе для длинных заголовков.
- [ ] `planDelivery()` явно валидирует `strategy` и `preferredMode`.
- [ ] `hadDegradation` отражает понижение unsupported markdown до текстового представления.
- [ ] Все добавленные regression-тесты становятся зелёными и остаются в suite.
- [ ] После закрытия текущих функциональных проблем добрать недостающее тестовое покрытие по списку из `missing-tests.md`.
