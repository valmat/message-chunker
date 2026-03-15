# Missing tests / пробелы в покрытии

Этот файл фиксирует важные тестовые сценарии, которые ещё стоит добавить,
но которые **не являются текущим фокусом итерации**.

Текущий порядок работы:
1. Сначала исправить открытые функциональные проблемы из `todo.md`, `rfc_violations.md` и `issues.md`.
2. Затем отдельной задачей добить недостающее тестовое покрытие из этого файла.

---

## Высокий приоритет

### 1. [x] Markdown line breaks (`soft_break` / `hard_break`)

**Почему важно**
- В RFC line breaks входят в поддерживаемый inline-subset.
- Сейчас есть тесты на raw HTML `<br>`, но почти нет прямых тестов именно на markdown-переносы строки.

**Что стоит проверить**
- normalizer корректно строит `soft_break` и `hard_break`;
- rich-html renderer сохраняет переносы ожидаемым образом;
- plain-text renderer сохраняет переносы ожидаемым образом;
- split/planning не ломают переносы внутри paragraph.

**Полезные тесты**
- один paragraph с soft break;
- один paragraph с hard break;
- paragraph с несколькими переносами и последующим split.

---

### 2. [x] Приоритеты split для paragraph по RFC

**Почему важно**
- RFC задаёт строгий порядок границ split:
  1. конец предложения,
  2. `;`,
  3. `,`,
  4. whitespace,
  5. forced split.
- Также есть правило: при одинаковом приоритете выбирать **самую правую** границу, которая влезает в budget.

**Что стоит проверить**
- split предпочитает `;` перед whitespace;
- split предпочитает `,` перед whitespace;
- при нескольких `.` / `!` / `?` выбирается правейшая допустимая граница;
- forced split используется только когда более мягких границ нет.

**Полезные тесты**
- синтетические строки, в которых можно однозначно проверить выбор split-point;
- отдельные тесты на `;`, `,`, sentence end и rightmost boundary.

---

### 3. [x] Семантика continuation у `list_item`

**Почему важно**
- RFC требует по возможности повторять marker в continuation fragment.
- Если это невозможно без нарушения структуры/бюджета, continuation может деградировать до paragraph.
- Сейчас уже есть regression-тест на oversized continuation, но не на полную семантику continuation.

**Что стоит проверить**
- marker сохраняется в continuation, когда это возможно;
- continuation остаётся читаемым при split многоабзацного list item;
- в случае деградации continuation поведение явно зафиксировано тестом.

**Полезные тесты**
- длинный `list_item`, split на несколько чанков с сохранением marker;
- `list_item`, где continuation невозможно сохранить без переполнения, и поведение деградирует ожидаемо.

---

### 4. [x] End-to-end сценарий `invalid-markup` для `replanTail()`

**Почему важно**
- Это один из двух канонических `rejectReason` по RFC.
- Сейчас есть тесты на enum/validation и общие mode-тесты, но не хватает явного сценария “rich-html rejected → tail rebuilt as plain-text”.

**Что стоит проверить**
- исходный план строится в rich-html;
- при `rejectReason: 'invalid-markup'` tail перестраивается в plain-text;
- уже доставленный rich-html prefix не дублируется;
- tail остаётся в рамках budget.

---

## Средний приоритет

### 5. [x] Полная семаника `splitBlockTypes`

**Почему важно**
- RFC требует, чтобы `splitBlockTypes` был:
  - уникальным,
  - в порядке первого появления,
  - без ложных значений для случаев, где была только деградация без реального split.

**Что стоит проверить**
- повторный split одного типа не дублирует элемент;
- порядок соответствует первому фактическому split;
- unsupported markdown / raw HTML не попадают в `splitBlockTypes`, если split не происходил.

---

### 6. [x] Дополнительные transport/profile validation tests

**Почему важно**
- Проверки `TransportProfile` уже есть, но можно добить более явные edge cases на уровне API.

**Что стоит проверить**
- ошибки на некорректных типах полей;
- ошибки на несовместимых комбинациях флагов профиля;
- консистентность ошибок `planDelivery()` и `replanTail()`.

---

## Низкий приоритет / nice-to-have

### 7. [x] Более точные golden tests для `SourceRange`

**Почему важно**
- Сейчас есть тесты на стабильность и на некоторые intra-block cases.
- Можно усилить golden coverage для сложных структур: heading, list continuation, mixed quote/list/code cases.

**Что стоит проверить**
- [x] ожидаемые `path`/`offsetUtf16` для нескольких заранее подготовленных сложных входов;
- [x] exact `SourceRange` golden для rich-html intra-block split с inline markup/link;
- [x] golden на более сложный nested cursor-path внутри `quote -> list -> paragraph` именно вместе с `replanTail()`.

**Примечание**
- Это не релиз-блокер при текущем покрытии, а полезный дополнительный слой hardening, чтобы ещё сильнее зацементировать адресацию.
- Частично уже усилено строгими тестами; найденный gap с рассинхроном `sourceRange.start/end` в `replanTail()` уже закрыт тестами и исправлением реализации.

---

### 8. [x] Unsupported markdown: footnotes / directives / exotic nesting

**Почему важно**
- RFC явно перечисляет unsupported constructs, которые должны либо понижаться до ближайшей поддерживаемой формы, либо превращаться в plain text с сохранением порядка текста.
- Сейчас покрыты в основном `raw HTML`, `table` и `image`, но почти нет явных тестов на footnote-like syntax, directives и более экзотические вложенности.

**Что стоит проверить**
- [x] footnote-like markdown не создаёт “магической” структуры и остаётся в линейном тексте;
- [x] directive-like syntax (`::note`, `:::`, и т.п.) не ломает IR и рендерится как текст;
- [x] exotic nested constructs упрощаются детерминированно и без потери порядка текста.

**Полезные тесты**
- [x] normalizer + renderers на `note[^1]\n\n[^1]: footnote text`;
- [x] normalizer + renderers на block/inline directive-like syntax;
- [x] один смешанный case с quote/list/code + unsupported syntax внутри.

---

### 9. [x] Safe rich-html subset as a negative contract

**Почему важно**
- RFC требует, чтобы rich renderer генерировал только transport-safe HTML subset.
- Сейчас тесты хорошо проверяют позитивные примеры (`<b>`, `<i>`, `<code>`, `<a>`, `<pre>`), но почти нет негативных контрактов “каких тегов/атрибутов не должно быть никогда”.

**Что стоит проверить**
- [x] в rich-html не появляются произвольные теги вроде `<div>`, `<span>`, `<em>`, `<strong>`, `<blockquote>`, `<ul>`, `<ol>`, `<li>`;
- [x] ссылки не получают неожиданные атрибуты кроме `href`;
- [x] language-информация у code block остаётся только в `class="language-..."`.

**Полезные тесты**
- [x] whitelist-style тест по regex для mixed markdown input;
- [x] отдельный тест, что raw HTML не просачивается как HTML-теги;
- [x] отдельный тест, что `a`-тег не получает лишние атрибуты.

---

### 10. [x] Более явные tests на UTF-16 semantics для `SourceRange` и длин

**Почему важно**
- RFC нормативно фиксирует `string.length` / UTF-16 code units как семантику длины и offsets.
- Unicode split уже покрыт неплохо, но не хватает точных тестов, где одновременно проверяются `content.length`, `estimatedLength` и `sourceRange.offsetUtf16` на tricky Unicode.

**Что стоит проверить**
- [x] offsets двигаются по UTF-16 code units на emoji / surrogate pairs;
- [x] `estimatedLength === content.length` для чанков с tricky Unicode;
- [x] intra-block split и `replanTail()` сохраняют точные UTF-16 offsets в Unicode-heavy тексте.

**Полезные тесты**
- [x] golden на forced split строки из emoji и ASCII;
- [x] replan case, где reject попадает внутрь Unicode-heavy paragraph;
- [x] expected offsets на комбинации `emoji + combining marks + plain text`.

---

## Предлагаемый порядок после фикса текущих багов

1. `invalid-markup` end-to-end
2. paragraph split priority / rightmost boundary
3. line breaks (`soft_break` / `hard_break`)
4. list continuation semantics
5. `splitBlockTypes`
6. `SourceRange` goldens
7. unsupported markdown (`footnotes` / directives / exotic nesting)
8. safe rich-html subset contract
9. UTF-16 / offset hardening
