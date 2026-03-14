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

## Стадия 8: Финальное ревью — исправления и документация ограничений
- [x] splitInlineOnce() — максимально плотное заполнение чанка (partial text node)
- [x] Убран class="language-..." из rich-html code block (safe subset)
- [x] Валидация rejectReason в replanTail()
- [ ] Рефакторинг SourceRange для точного адресования внутри split-блоков → [docs/refactoring-sourcerange.md](docs/refactoring-sourcerange.md)
- [x] Задокументированы осознанные ограничения v1 → [docs/known-limitations.md](docs/known-limitations.md)
