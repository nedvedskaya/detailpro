# Дашборд аналитики — дизайн-спецификация для разработки

## Контекст

Раздел «Аналитика» в админ-панели собственника студии DetailPro.
Доступен только роли `owner`. Меню: Дашборд → Клиенты → Заказы → Финансы → **Аналитика** → Настройки.

---

## Цветовая схема (строго соблюдать)

Акцентный цвет продукта — оранжевый. Все интерактивные элементы, графики и выделения используют эту палитру.

```css
--accent:        #E8480A;   /* основной оранжевый — кнопки, активные состояния */
--accent-light:  #FF8C5A;   /* средний оранжевый — второй ряд данных */
--accent-pale:   #FFB38A;   /* светлый оранжевый — третий ряд */
--accent-ghost:  #FFD9C2;   /* очень светлый — четвёртый ряд, фон */
--accent-bg:     #FFF0EB;   /* фоновый тинт — бейджи, подложки */
--accent-text:   #B03500;   /* текст на светлом оранжевом фоне */
```

Нейтральные цвета — стандартные CSS-переменные темы:
```css
--color-background-primary     /* белый / тёмный фон карточек */
--color-background-secondary   /* поверхность, метрик-карточки */
--color-text-primary           /* основной текст */
--color-text-secondary         /* подписи, метки */
--color-border-tertiary        /* 0.5px границы */
```

---

## Структура страницы (сверху вниз)

```
[Заголовок + переключатель периода]
[4 метрик-карточки]
[График выручки] [График заказов и клиентов]
[График среднего чека] [Пончик структуры выручки]
[Топ-5 услуг] [Клиентская база]
```

---

## 1. Шапка страницы

```
Аналитика студии          [3 мес] [6 мес ●] [Год]
```

- Заголовок: 18px, font-weight 500
- Переключатель периода: три кнопки-пилюли (border-radius: 20px)
- Неактивная: прозрачный фон, 0.5px border, текст secondary
- Активная: фон `#E8480A`, текст белый, без border
- Переключение меняет данные во ВСЕХ виджетах одновременно
- Периоды: 3 месяца / 6 месяцев / 12 месяцев (год)
- По умолчанию активен: 6 мес

---

## 2. Метрик-карточки (4 штуки, одна строка)

Grid: `repeat(4, 1fr)`, gap 10px.

### Карточка 1 — Выручка за месяц (АКЦЕНТНАЯ)
- Фон: `#E8480A`
- Лейбл (12px): `rgba(255,255,255,0.75)`
- Значение (22px, 500): `#ffffff`
- Дельта (11px): `rgba(255,255,255,0.8)` — всегда белая, знак + или −

### Карточки 2, 3, 4 — Заказы / Новые клиенты / Средний чек
- Фон: `var(--color-background-secondary)`
- Лейбл (12px): `var(--color-text-secondary)`
- Значение (22px, 500): `var(--color-text-primary)`
- Дельта (11px): зелёная если рост (`var(--color-text-success)`), красная если падение (`var(--color-text-danger)`)

Все карточки: border-radius: 8px, padding 14px 16px, без border.

---

## 3. График: Выручка по месяцам (Bar chart)

Размер: половина ширины, высота canvas 180px.

**Chart.js, тип: bar**

Цвета столбцов:
- Текущий (последний) месяц: `#E8480A` (насыщенный)
- Все предыдущие: `#FFB38A` (бледный оранжевый)
- Определяется через `backgroundColor: data.map((_, i) => i === data.length - 1 ? '#E8480A' : '#FFB38A')`

Столбцы: borderRadius 5, borderSkipped false.

Оси:
- Цвет меток: `var(--color-text-secondary)` через `getComputedStyle`
- Сетка: `rgba(128,128,128,0.1)`
- Ось Y: значения в формате `Nк` (тысячи), например `480к`
- Граница осей: скрыта (`border: { display: false }`)

Тултип: значение в формате `482 000 ₽` (toLocaleString ru-RU).
Легенда: отключена (display: false).

---

## 4. График: Заказы и клиенты (Bar chart, grouped)

Размер: половина ширины, высота canvas 148px.

**Chart.js, тип: bar**

Два датасета:
- «Заказы»: цвет `#E8480A`
- «Новые клиенты»: цвет `#D3D1C7`

Столбцы: borderRadius 4, borderSkipped false.

Легенда кастомная (HTML над canvas):
```html
<div style="display:flex;gap:12px;font-size:11px;color:var(--color-text-secondary);margin-bottom:10px;">
  <span><span style="width:10px;height:10px;border-radius:2px;background:#E8480A;display:inline-block;margin-right:4px;"></span>Заказы</span>
  <span><span style="width:10px;height:10px;border-radius:2px;background:#D3D1C7;display:inline-block;margin-right:4px;"></span>Новые клиенты</span>
</div>
```

Chart.js legend: `display: false`.

---

## 5. График: Средний чек (Line chart)

Размер: половина ширины, высота canvas 160px.

**Chart.js, тип: line**

Линия:
- borderColor: `#E8480A`
- borderWidth: 2
- pointBackgroundColor: `#E8480A`
- pointRadius: 4
- tension: 0.35
- fill: true
- backgroundColor: `rgba(232, 72, 10, 0.07)` (лёгкая заливка под линией)

Ось Y: значения в формате `Nк`.
Тултип: `12 684 ₽`.
Легенда: отключена.

---

## 6. График: Структура выручки (Doughnut chart)

Размер: половина ширины, высота canvas 128px.

**Chart.js, тип: doughnut**

4 сегмента, оранжевая гамма от насыщенного к светлому:
```js
backgroundColor: ['#E8480A', '#FF8C5A', '#FFB38A', '#FFD9C2']
```

cutout: '65%' (толстый пончик).
borderWidth: 0 (без зазоров между сегментами).
Легенда Chart.js: отключена.

Кастомная легенда HTML (над canvas, flex-wrap):
```html
<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--color-text-secondary);margin-bottom:10px;">
  <span>■ Керамика 38%</span>
  <span>■ Полировка 27%</span>
  <span>■ Плёнка 20%</span>
  <span>■ Химчистка 15%</span>
</div>
```
Цвет каждого ■ соответствует сегменту (inline style на квадрате 10×10px).

---

## 7. Топ-5 услуг (список с прогресс-барами)

Карточка: белый фон, 0.5px border, border-radius-lg, padding 16px.

Каждая строка: flex, gap 10px, padding 8px 0, border-bottom 0.5px (последняя без).

Структура строки:
```
[№]  [Название услуги]  [====прогресс-бар====]  [Сумма ₽]
```

- Номер: 11px, secondary, ширина 16px
- Название: 12px, primary, flex: 1
- Прогресс-бар: обёртка 70px × 4px, фон secondary, border-radius 2px. Заливка: `#E8480A`, ширина в % от максимума (1-е место = 100%)
- Сумма: 12px, font-weight 500, min-width 72px, text-align right

---

## 8. Клиентская база (таблица показателей)

Карточка: белый фон, 0.5px border, border-radius-lg, padding 16px.

Строки: flex space-between, padding 7px 0, border-bottom 0.5px (последняя без).

Левая часть: 12px, secondary.
Правая часть: 13px, font-weight 500, primary.

Некоторые строки содержат бейдж рядом со значением:

Типы бейджей (font-size 10px, padding 2px 8px, border-radius 3px):
- `good`: `background: var(--color-background-success)`, `color: var(--color-text-success)` — «Хорошо»
- `warn`: `background: var(--color-background-warning)`, `color: var(--color-text-warning)` — «Внимание», «Низко»
- `accent`: `background: #FFF0EB`, `color: #B03500` — «Активны»

---

## Данные (API)

Все данные приходят с бэкенда. Один эндпоинт:

```
GET /api/analytics?period=6m&studio_id=...
```

Параметр period: `3m` / `6m` / `year`

Ответ:
```json
{
  "current_month": {
    "revenue": 482000,
    "revenue_delta_pct": 12,
    "orders": 38,
    "orders_delta": 5,
    "new_clients": 14,
    "new_clients_delta": -2,
    "avg_check": 12684,
    "avg_check_delta_pct": 7
  },
  "by_month": [
    { "label": "Ноя", "revenue": 310000, "orders": 22, "new_clients": 8, "avg_check": 11000 }
  ],
  "categories": [
    { "name": "Керамика", "revenue": 182000, "pct": 38 }
  ],
  "top_services": [
    { "name": "Керамика 2 слоя", "revenue": 182000 }
  ],
  "retention": {
    "total_clients": 147,
    "repeat_pct": 63,
    "inactive_3m": 31,
    "upcoming_next_month": 12,
    "avg_interval_months": 4.2,
    "conversion_30d_pct": 18
  }
}
```

При переключении периода — новый запрос к API, данные перерисовываются.
Показывать скелетон-лоадер пока данные грузятся.

---

## Поведение при переключении периода

1. Пользователь нажимает кнопку периода
2. Активная кнопка меняется (оранжевая)
3. Все 4 метрик-карточки обновляются
4. Все 4 графика перерисовываются (destroy → new Chart)
5. Топ услуг и клиентская база обновляются
6. Анимация Chart.js стандартная (duration: 400ms)

---

## Важные детали реализации

- Canvas не поддерживает CSS-переменные → цвета осей и сетки брать через `getComputedStyle` в момент инициализации
- Каждый Chart уничтожать перед пересозданием (`chart.destroy()`) — иначе memory leak
- Все числа форматировать через `toLocaleString('ru-RU')`
- Суммы в ₽ — через `Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })`
- Дельты: если положительная → ставить `+`, если отрицательная → число само несёт `−`
- Все canvas оборачивать в `<div style="position:relative; height: Npx">` — высоту ставить только на обёртку, не на canvas
- Chart.js: `responsive: true, maintainAspectRatio: false` обязательно

---

## Что НЕ делать

- НЕ использовать тёмные фоны на контейнерах (только карточка «Выручка» оранжевая)
- НЕ добавлять градиенты и тени на карточки
- НЕ ставить стандартную легенду Chart.js — только кастомный HTML
- НЕ смешивать цвета — только оранжевая гамма + нейтральные CSS-переменные
- НЕ добавлять лишних метрик сверх описанных
- НЕ делать горизонтальную прокрутку — всё помещается на экран
