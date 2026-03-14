# Рефакторинг: точное адресование SourceRange внутри split-блоков

## Проблема

При разбиении крупного блока (параграф, список, цитата) на несколько чанков в стратегиях `split-blocks-soft`, `plain-text` и `forced-plain-text`, все фрагменты одного блока получают одинаковый `sourceRange` — диапазон всего top-level блока.

Затем `replanTail()` использует только `sourceRange.start.path[0]` (индекс top-level блока) для определения начала хвоста. Если отказ произошёл на 2-м фрагменте длинного параграфа, replan возвращается к началу всего параграфа и повторно отправляет уже доставленный 1-й фрагмент.

### Нарушаемые требования RFC

- §6.6 — `SourceRange` должен адресовать логический диапазон внутри нормализованного IR
- §6.10 — SourceCursor включает `path` (массив индексов) и `offsetUtf16` для адресации внутри leaf-ноды
- §18.1 — хвост replanning начинается с `sourceRange.start` отказавшего чанка
- §19.7 — уже доставленный префикс не должен пересылаться повторно

### Пример

```
Markdown: "Very long paragraph with many sentences..."
Budget: 50

planDelivery → chunks:
  [0] "Very long paragraph with"     sourceRange: {start: {path:[0], offset:0}, end: {path:[0], offset:100}}
  [1] "many sentences that go on"    sourceRange: {start: {path:[0], offset:0}, end: {path:[0], offset:100}}
  [2] "and more text here..."        sourceRange: {start: {path:[0], offset:0}, end: {path:[0], offset:100}}

Чанк 1 отклонён транспортом.
replanTail → tail начинается с path[0]=0, т.е. с начала параграфа.
Результат: контент чанка 0 ("Very long paragraph with") попадает в хвост повторно.
```

## Предлагаемое решение

### 1. Уточнить SourceRange при split внутри блока

При разбиении блока на фрагменты, каждый фрагмент должен получить точный `sourceRange`:

- **Для параграфов**: `path` включает индекс inline-ребёнка, `offsetUtf16` — позицию внутри текстового узла, где произошёл split.
- **Для списков**: `path` включает индекс `list_item`, далее — позицию внутри содержимого элемента.
- **Для цитат**: `path` включает индекс внутреннего блока цитаты.
- **Для code_block**: `offsetUtf16` — позиция в `value` строке, где произошёл split.

### 2. Обновить replanTail()

`replanTail()` должен уметь:
1. Навигировать по `path` вглубь IR-дерева (не только `path[0]`)
2. Если `offsetUtf16 > 0`, «обрезать» leaf-ноду, создавая суб-IR начиная с указанной позиции
3. Собрать хвост: обрезанный текущий блок + все последующие блоки

### 3. Обновить split-функции

Функции `splitParagraphIntoParts`, `splitQuoteIntoParts`, `splitListIntoParts`, `splitCodeBlockIntoParts` должны возвращать не только rendered strings, но и метаданные о позиции split в IR-дереве.

## Затрагиваемые файлы

- `src/planner.js` — `trySplitBlocksSoft`, `doForcedPlainText`, все `split*IntoParts`, `finalizeChunks`
- `src/replan.js` — `replanTail`, навигация по path
- `test/replan.test.js` — тесты для intra-block replan
- `test/complex.test.js` — тесты "reject in the middle"

## Оценка сложности

Высокая. Требует переработки интерфейса между split-функциями и финализатором чанков, а также логики восстановления хвоста в replanTail. Рекомендуется как отдельная задача v1.1.
