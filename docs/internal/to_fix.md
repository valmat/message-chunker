# To Fix

Цель файла: фиксировать только явные баги реализации, чтобы к ним можно было быстро вернуться без повторного расследования.

Ограничения, которые надо сохранять при любых исправлениях:

- библиотека остаётся transport-agnostic;
- библиотека остаётся изолируемой и детерминированной;
- исправления должны быть проверяемы обычными unit/integration tests без SDK транспорта и без network;
- не размывать RFC v1 ради локального workaround, если проблема уже покрыта спецификацией.

## Open Bugs

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
