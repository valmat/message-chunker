# Нарушения RFC

## Критично

### 1. `planDelivery()` может вернуть чанк, превышающий `safeTextBudget`, для длинного continuation-блока внутри `list_item`

- **RFC**: §§13.1, 16, 19 требуют валидировать длину итогового контента каждого чанка и не превышать `transport.safeTextBudget`.
- **Что происходит**: при разбиении `list_item` функция `splitListItemIntoFragments()` не проверяет, помещается ли continuation-фрагмент в бюджет после `current = marker + indented.trimStart()`. В результате библиотека может вернуть заведомо невалидный план.
- **Где**: `packages/message-chunker/src/planner.js:560`, `packages/message-chunker/src/planner.js:606`, `packages/message-chunker/src/planner.js:617`.
- **Воспроизведение**: markdown вида `- short\n\n  ` + очень длинный абзац при `safeTextBudget = 200` возвращает чанки длиной `7` и `401` символ.
- **Почему это нарушение RFC**: модуль обязан возвращать только валидные чанки; «план с чанком длиннее бюджета» противоречит базовому контракту v1.

### 2. Длинный `heading` обрабатывается не по RFC и ломает `replanTail()`

- **RFC**: §14.3 требует, чтобы слишком длинный заголовок на более поздней стратегии обрабатывался как plain text; §§18.1 и 19 запрещают повторно отправлять уже доставленный префикс.
- **Что происходит**:
  - `heading` вообще не умеет мягко разбиваться на plain-text этапе и сразу уходит в `forced-plain-text`.
  - при forced-разбиении `blockRenderedOffsetToCursor()` не умеет маппить смещения для `heading` и возвращает один и тот же стартовый курсор для всех фрагментов.
  - из-за этого `sourceRange.start` у нескольких чанков совпадает, а `replanTail()` после reject строит хвост снова с начала заголовка.
- **Где**: `packages/message-chunker/src/planner.js:232`, `packages/message-chunker/src/planner.js:238`, `packages/message-chunker/src/planner.js:1099`.
- **Воспроизведение**: длинный markdown-заголовок (`# ` + много слов) при `safeTextBudget = 200` планируется через `usedStrategy = 'forced-plain-text'`; у первых чанков одинаковый `sourceRange.start`, а `replanTail()` дублирует уже доставленный текст.
- **Почему это нарушение RFC**: нарушается и требование по стратегии обработки заголовков, и ключевая гарантия «не пересылать уже доставленный префикс».

## Средне

### 3. `diagnostics.hadDegradation` не отражает часть деградаций, которые RFC требует сигнализировать

- **RFC**: §20 требует отражать факт деградации, в том числе когда unsupported markdown понижается до plain-text представления.
- **Что происходит**: `buildDiagnostics()` выставляет `hadDegradation` только по факту эскалации стратегии/режима. Если raw HTML, таблица или другой unsupported input были понижены до текста без смены стратегии, флаг остаётся `false`.
- **Где**: `packages/message-chunker/src/planner.js:1334`.
- **Воспроизведение**: для входов вроде `<b>x</b>` или pipe-table `diagnostics.hadDegradation === false`, хотя структура уже была упрощена на этапе normalizer/parser.
- **Почему это нарушение RFC**: диагностика теряет обязательный сигнал о деградации входа и перестаёт соответствовать контракту observability из RFC.
