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
- [ ] rich-html рендерер (safe HTML subset: b, i, code, pre, a)
- [ ] plain-text рендерер
- [ ] Каноническое форматирование блоков (spacing, quote prefix, list markers и т.д.)
- [ ] Тесты рендереров

## Стадия 4: Планировщик (planDelivery)
- [ ] Greedy packing алгоритм
- [ ] Стратегия preserve
- [ ] Стратегия split-blocks
- [ ] Стратегия split-blocks-soft (сплит параграфов, list_item, quote)
- [ ] Стратегия plain-text
- [ ] Стратегия forced-plain-text (Unicode-safe split)
- [ ] Эскалация стратегий
- [ ] Формирование SourceRange
- [ ] Диагностика
- [ ] Тесты планировщика

## Стадия 5: Replanning (replanTail)
- [ ] Реализация replanTail()
- [ ] Восстановление хвоста из нормализованной IR по sourceRange
- [ ] Эскалация стратегий при replanning
- [ ] Тесты replanning

## Стадия 6: Комплексные тесты
- [ ] Golden tests
- [ ] Property-like тесты (инварианты: бюджет, детерминизм, полнота текста)
- [ ] Nasty cases (giant paragraph, giant code block, super long line, emoji/ZWJ, nested lists, и т.д.)

## Стадия 7: Публичный API и документация
- [ ] Экспорт публичного API (planDelivery, replanTail, типы)
- [ ] README с описанием модуля, API и примерами
