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
_Источник истины до синхронизации кода: `docs/rfc.md`. По критичному долгу по replanning см. `docs/refactoring-sourcerange.md`. По принятым ограничениям и уже согласованным решениям см. `docs/known-limitations.md`._

### Шаг 1. Сначала синхронизировать контракт RFC → код и документацию
- [x] Синхронизировать `RejectReason` с RFC: для модуля каноничны только `too-long` и `invalid-markup`; transport-level ошибки остаются за интеграцией
- [x] Синхронизировать валидацию `TransportProfile` с RFC: `safeTextBudget < 200` должен считаться invalid profile
- [x] Синхронизировать rich-html code block с RFC: вернуть `class="language-*"` для сохранения language info fenced block
- [x] Обновить README: привести описания контракта в соответствие RFC и добавить/обновить сценарии использования (`too-long`, `invalid-markup`, rich-html code block with language info)

### Шаг 2. Затем выполнить локальную синхронизацию тестов
- [x] Обновить/добавить тесты для `RejectReason` по новому контракту RFC
- [x] Обновить/добавить тесты для минимального `safeTextBudget >= 200`
- [x] Обновить/добавить тесты на rich-html code block с language info

### Шаг 3. Затем сделать критичную функциональную доработку
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

### Принятый техдолг релиза
- [ ] Довести diagnostics до полного соответствия RFC для unsupported markdown: сейчас RFC всё ещё требует фиксировать такую деградацию в diagnostics (`docs/rfc.md:706`, `docs/rfc.md:1031`), а текущая реализация `hadDegradation` учитывает только деградацию стратегии/режима в planner (`packages/message-chunker/src/planner.js:1334`). Это осознанно принято как нерелиз-блокирующий техдолг и должно быть пересмотрено в одной из следующих итераций.

### Definition of done для следующей итерации
- [x] RFC, README, typedef, runtime-валидация и тесты не противоречат друг другу
- [x] Клиентская ответственность за orchestration после reject явно сохранена и не размыта кодом библиотеки
- [x] Есть тест, который воспроизводит intra-block reject и подтверждает отсутствие повторной отправки уже доставленного текста
- [x] README содержит не только API-описание, но и сценарии использования для типовых reject-потоков
