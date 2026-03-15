# Проблемы в коде

## Критично

### 1. Нет надёжной финальной валидации чанков после внутренних split-алгоритмов

- **Симптом**: даже при зелёных тестах библиотека может вернуть чанк длиннее `safeTextBudget`.
- **Корень проблемы**: `planFromIr()` доверяет `tryStrategy()` и не делает обязательный финальный проход проверки длины уже собранных чанков. Ошибка в одном внутреннем splitter'е сразу превращается в невалидный публичный результат.
- **Где это проявляется сейчас**: `packages/message-chunker/src/planner.js:55`, `packages/message-chunker/src/planner.js:57`, `packages/message-chunker/src/planner.js:560`.
- **Практический эффект**: любое локальное нарушение в логике разбиения (сейчас уже воспроизводится на `list_item`) пробивает главный инвариант библиотеки.

### 2. Разбиение `list_item` не умеет корректно обрабатывать длинные continuation-блоки

- **Симптом**: continuation-фрагмент может быть длиннее бюджета и всё равно попасть в итоговый план.
- **Корень проблемы**: во второй фазе `splitListItemIntoFragments()` continuation-блок либо просто присоединяется, либо становится новым `current`, но не рекурсивно разбивается и не проверяется как самостоятельный oversized-фрагмент.
- **Где**: `packages/message-chunker/src/planner.js:606`, `packages/message-chunker/src/planner.js:611`, `packages/message-chunker/src/planner.js:617`.
- **Практический эффект**: некорректная работа на многоабзацных элементах списка, в том числе на вполне типичных LLM-ответах с коротким первым пунктом и длинным пояснением во втором абзаце.

## Высоко

### 3. Для forced-split `heading` вычисляются некорректные `sourceRange`

- **Симптом**: у нескольких чанков одного длинного заголовка совпадает `sourceRange.start`.
- **Корень проблемы**: `blockRenderedOffsetToCursor()` умеет точно маппить только `paragraph`, `code_block`, `quote` и `list`; для остальных блоков используется fallback на «первый лист».
- **Где**: `packages/message-chunker/src/planner.js:1099`, `packages/message-chunker/src/planner.js:1112`.
- **Практический эффект**: `replanTail()` строит tail не с позиции reject, а с начала заголовка, что приводит к дублированию уже доставленного текста.

## Средне

### 4. `planDelivery()` не валидирует `strategy` и `preferredMode`

- **Симптом**: мусорный `preferredMode` принимается молча, а мусорный `strategy` в итоге падает общей ошибкой `Internal error: failed to build delivery plan`.
- **Контраст в API**: `replanTail()` аналогичные поля валидирует явно.
- **Где**: `packages/message-chunker/src/planner.js:25`, `packages/message-chunker/src/planner.js:75`; для сравнения — `packages/message-chunker/src/replan.js:45`, `packages/message-chunker/src/replan.js:55`.
- **Практический эффект**: внешний код получает либо тихую подмену поведения, либо misleading internal error вместо понятной валидационной ошибки.

### 5. Диагностика деградации семантически ненадёжна

- **Симптом**: `splitBlockTypes` может быть непустым, а `hadDegradation` — `false`; понижение unsupported markdown до текста тоже не отражается.
- **Корень проблемы**: `hadDegradation` выводится только из сравнения `requested/used strategy` и `requested/used mode`, а не из фактических преобразований документа.
- **Где**: `packages/message-chunker/src/planner.js:1334`.
- **Практический эффект**: логирование и анализ проблемных входов становятся неполными; внешняя интеграция получает слишком оптимистичную картину о качестве исходного плана.
