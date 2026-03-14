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
_Читайте в первую очередь: именно этот раздел и блок **Handoff** ниже являются актуальным планом разработки._
- [ ] Исправить `SourceRange`/`replanTail()` так, чтобы reject внутри split-блока не переотправлял уже доставленный префикс → [docs/refactoring-sourcerange.md](docs/refactoring-sourcerange.md)
- [ ] Синхронизировать контракт `rejectReason` с обновлённым RFC: для модуля каноничны только `too-long` и `invalid-markup`; transport-level ошибки и policy после reject остаются за интеграцией
- [ ] Синхронизировать реализацию rich-html code block с обновлённым RFC: разрешён `class="language-*"` для сохранения language info fenced block
- [x] Зафиксировать, что `hadDegradation` для unsupported markdown не является обязательным требованием v1; допустимы документация и логирование как nice-to-have
- [ ] Синхронизировать валидацию `TransportProfile` с обновлённым RFC: `safeTextBudget < 200` должен считаться invalid profile


## Handoff: порядок следующей итерации

### Шаг 1. Сначала принять проектные решения
- [x] Зафиксировано: policy после reject определяется клиентом; библиотека предоставляет ручки (`preferredMode`, `nextStrategy`, `transport.safeTextBudget`, diagnostics), но не хардкодит orchestration
- [x] Зафиксировано: модуль различает только `too-long` и `invalid-markup`; прочие transport-level ошибки остаются вне спецификации модуля
- [x] Зафиксировано: unreasonable budgets не поддерживаются; в RFC введён минимальный `safeTextBudget` для v1
- [x] Зафиксировано: для unsupported markdown достаточно документации/логирования; обязательной продуктовой реакции в v1 не требуется

### Шаг 2. Затем выполнить обязательную синхронизацию RFC → код
- [ ] Вернуть поддержку rich-html fenced code block с language info согласно обновлённому RFC (`<pre><code class="language-LANG">...</code></pre>`)
- [ ] Обновить/добавить тесты на rich-html code block с language info
- [ ] Обновить README и примеры, если там описан safe subset без language metadata

### Шаг 3. Затем сделать критичную функциональную доработку
- [ ] Реализовать точный `SourceRange` для split-fragments по плану из `docs/refactoring-sourcerange.md`
- [ ] Научить `replanTail()` восстанавливать хвост по полному `path` + `offsetUtf16`, а не только по `path[0]`
- [ ] Добавить регрессионные тесты: reject во 2-м чанке длинного paragraph/list item/quote/code block не должен дублировать уже доставленный префикс

### Definition of done для следующей итерации
- [ ] Все open вопросы из Стадии 9 либо закрыты решением, либо явно перенесены в следующий milestone с обновлённым RFC/документацией
- [ ] RFC, README, typedef и runtime-валидация не противоречат друг другу
- [ ] Клиентская ответственность за orchestration после reject явно сохранена и не размыта кодом библиотеки
- [ ] Есть тест, который воспроизводит intra-block reject и подтверждает отсутствие повторной отправки уже доставленного текста
