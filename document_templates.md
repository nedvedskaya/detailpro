# Шаблоны документов для DetailPro CRM
## Задача для Клод Кода

Создай два HTML-шаблона документов для генерации PDF через Puppeteer.
Шаблоны должны подключаться к данным из БД и рендериться на бэкенде.

---

## Общие требования

### Технический стек генерации
- Библиотека: **Puppeteer** (Node.js)
- Формат вывода: PDF, A4, книжная ориентация
- Поля страницы: 15mm сверху/снизу, 20mm слева/справа
- Шрифт: system-ui, sans-serif (не подключать внешние шрифты — нет интернета при рендере)
- Все данные подставляются через шаблонизатор (Handlebars, EJS или простая замена строк — на твой выбор)

### Данные из БД которые подставляются автоматически
Из таблицы `studios` (настройки студии):
- `studio.name` — название студии
- `studio.inn` — ИНН
- `studio.ogrn` — ОГРН или ОГРНИП
- `studio.address` — адрес
- `studio.phone` — телефон
- `studio.email` — email

Из таблицы `orders` (заказ-наряд/бронь):
- `order.number` — номер ЗН (автоинкремент внутри студии)
- `order.created_at` — дата и время создания
- `order.delivery_date` — плановая дата выдачи
- `order.delivery_time` — плановое время выдачи
- `order.master_name` — имя мастера
- `order.payment_method` — способ оплаты (cash/card/transfer)
- `order.payment_status` — статус оплаты (unpaid/partial/paid)
- `order.discount` — скидка в рублях
- `order.total` — итого к оплате
- `order.items[]` — массив услуг { name, quantity, price }
- `order.guarantee_text` — текст гарантии (из настроек студии или вручную)
- `order.notes` — комментарий к заказу

Из таблицы `clients`:
- `client.full_name` — ФИО
- `client.phone` — телефон

Из таблицы `vehicles`:
- `vehicle.brand` — марка
- `vehicle.model` — модель
- `vehicle.year` — год выпуска
- `vehicle.color` — цвет
- `vehicle.plate` — госномер
- `vehicle.vin` — VIN

Из таблицы `acceptance_acts` (акт приёмки, привязан к order_id):
- `act.number` — номер акта = номер ЗН
- `act.created_at` — дата и время приёмки
- `act.mileage` — пробег при приёмке
- `act.zones` — JSON объект состояния зон кузова (см. ниже)
- `act.damage_description` — текстовое описание повреждений
- `act.valuables` — ценности в авто (текст или "не заявлены")
- `act.photos_count` — количество прикреплённых фото (только цифра, фото в PDF не идут)
- `act.master_name` — кто принимал

### Важно: фотографии НЕ вставляются в PDF
Фото хранятся в S3, привязаны к `order_id` в таблице `order_photos`.
В документе только указывается их количество: «Фотофиксация: X фото сохранено в системе».
Максимум фото на бронь: 30. Минимум для акта: рекомендовать мастеру 8.

---

## Документ 1: Акт приёмки-передачи автомобиля

### HTML шаблон акта приёмки

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; font-size: 11px; color: #1a1a1a; }
  
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1.5px solid #1a1a1a; }
  .header-left .studio-name { font-size: 14px; font-weight: 600; }
  .header-left .studio-details { font-size: 9px; color: #555; margin-top: 3px; line-height: 1.5; }
  .header-right { text-align: right; }
  .header-right .doc-title { font-size: 14px; font-weight: 600; }
  .header-right .doc-subtitle { font-size: 9px; color: #555; margin-top: 3px; }
  .legal-ref { font-size: 9px; color: #777; margin-top: 2px; font-style: italic; }

  .section { margin-bottom: 12px; }
  .section-title { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: #555; margin-bottom: 6px; }
  
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  
  .field { border: 0.5px solid #ccc; border-radius: 4px; padding: 5px 8px; }
  .field-label { font-size: 8px; color: #777; }
  .field-value { font-weight: 500; margin-top: 1px; }

  .zones-table { width: 100%; border-collapse: collapse; }
  .zones-table th { font-size: 9px; font-weight: 600; text-align: left; padding: 5px 6px; background: #f5f5f5; border: 0.5px solid #ccc; }
  .zones-table td { font-size: 10px; padding: 5px 6px; border: 0.5px solid #ccc; }
  .zones-table td.zone-name { color: #333; }
  .zones-table td.status-ok { color: #2d6a2d; font-weight: 500; }
  .zones-table td.status-dmg { color: #b85000; font-weight: 500; }

  .text-field { border: 0.5px solid #ccc; border-radius: 4px; padding: 6px 8px; min-height: 36px; }
  .text-field-label { font-size: 8px; color: #777; margin-bottom: 3px; }

  .photos-block { border: 0.5px solid #ccc; border-radius: 4px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; }
  .photos-note { font-size: 9px; color: #777; font-style: italic; }

  .legal-block { background: #f8f8f8; border: 0.5px solid #ddd; border-radius: 4px; padding: 8px 10px; margin-top: 10px; }
  .legal-block p { font-size: 9px; color: #444; line-height: 1.5; margin-bottom: 4px; }
  .legal-block p:last-child { margin-bottom: 0; }

  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 14px; }
  .signature-block .sig-label { font-size: 9px; color: #555; margin-bottom: 4px; }
  .signature-block .sig-line { border-bottom: 0.5px solid #333; padding-bottom: 22px; margin-bottom: 3px; }
  .signature-block .sig-name { font-size: 9px; color: #555; }

  .link-ref { font-size: 9px; color: #333; margin-top: 10px; text-align: center; }
</style>
</head>
<body>

<!-- ШАПКА -->
<div class="header">
  <div class="header-left">
    <div class="studio-name">{{ studio.name }}</div>
    <div class="studio-details">
      ИНН {{ studio.inn }} · ОГРН {{ studio.ogrn }}<br>
      {{ studio.address }}<br>
      {{ studio.phone }} · {{ studio.email }}
    </div>
  </div>
  <div class="header-right">
    <div class="doc-title">Акт приёмки-передачи автомобиля</div>
    <div class="doc-subtitle">№ {{ act.number }} от {{ act.created_at | date }} · {{ act.created_at | time }}</div>
    <div class="legal-ref">Является приложением к Заказ-наряду № {{ order.number }}</div>
  </div>
</div>

<!-- ЗАКАЗЧИК -->
<div class="section">
  <div class="section-title">Заказчик</div>
  <div class="grid-2">
    <div class="field">
      <div class="field-label">ФИО</div>
      <div class="field-value">{{ client.full_name }}</div>
    </div>
    <div class="field">
      <div class="field-label">Телефон</div>
      <div class="field-value">{{ client.phone }}</div>
    </div>
  </div>
</div>

<!-- АВТОМОБИЛЬ -->
<div class="section">
  <div class="section-title">Автомобиль</div>
  <div class="grid-3">
    <div class="field">
      <div class="field-label">Марка и модель</div>
      <div class="field-value">{{ vehicle.brand }} {{ vehicle.model }}</div>
    </div>
    <div class="field">
      <div class="field-label">Год выпуска</div>
      <div class="field-value">{{ vehicle.year }}</div>
    </div>
    <div class="field">
      <div class="field-label">Цвет</div>
      <div class="field-value">{{ vehicle.color }}</div>
    </div>
    <div class="field">
      <div class="field-label">Госномер</div>
      <div class="field-value">{{ vehicle.plate }}</div>
    </div>
    <div class="field">
      <div class="field-label">VIN</div>
      <div class="field-value" style="font-size: 10px;">{{ vehicle.vin }}</div>
    </div>
    <div class="field">
      <div class="field-label">Пробег, км</div>
      <div class="field-value">{{ act.mileage }}</div>
    </div>
  </div>
</div>

<!-- СОСТОЯНИЕ ПО ЗОНАМ КУЗОВА -->
<div class="section">
  <div class="section-title">Состояние кузова по зонам</div>
  <table class="zones-table">
    <thead>
      <tr>
        <th style="width: 30%;">Зона</th>
        <th style="width: 23%;">Царапины / сколы</th>
        <th style="width: 23%;">Вмятины</th>
        <th style="width: 24%;">Состояние</th>
      </tr>
    </thead>
    <tbody>
      <!-- Рендерится из act.zones — массив объектов { zone_name, scratches, dents, condition } -->
      <!-- Значения: "Нет" / "Есть" / "Норма" / "Повреждения" -->
      {{#each act.zones}}
      <tr>
        <td class="zone-name">{{ this.zone_name }}</td>
        <td class="{{ if this.scratches 'status-dmg' else 'status-ok' }}">{{ this.scratches_label }}</td>
        <td class="{{ if this.dents 'status-dmg' else 'status-ok' }}">{{ this.dents_label }}</td>
        <td class="{{ if this.damaged 'status-dmg' else 'status-ok' }}">{{ this.condition_label }}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  <!-- Зоны кузова по умолчанию (захардкодить в интерфейсе приёмки):
    Бампер передний, Капот, Крыло переднее левое, Крыло переднее правое,
    Дверь передняя левая, Дверь передняя правая, Дверь задняя левая,
    Дверь задняя правая, Крыша, Крыло заднее левое, Крыло заднее правое,
    Бампер задний, Крышка багажника, Стёкла, Диски (4 шт.), Салон
  -->
</div>

<!-- ОПИСАНИЕ ПОВРЕЖДЕНИЙ И ЦЕННОСТИ -->
<div class="section">
  <div class="grid-2" style="gap: 8px;">
    <div>
      <div class="text-field-label">Описание повреждений (свободный текст)</div>
      <div class="text-field">{{ act.damage_description }}</div>
    </div>
    <div>
      <div class="text-field-label">Ценности в автомобиле</div>
      <div class="text-field">{{ act.valuables }}</div>
    </div>
  </div>
</div>

<!-- ФОТОФИКСАЦИЯ -->
<div class="section">
  <div class="section-title">Фотофиксация</div>
  <div class="photos-block">
    <div>
      <div style="font-weight: 500;">Фотографий при приёмке: {{ act.photos_count }} шт.</div>
      <div class="photos-note">Фотографии сохранены в системе DetailPro, доступны в карточке заказа</div>
    </div>
    <div style="font-size: 9px; color: #777;">Заказ № {{ order.number }}</div>
  </div>
</div>

<!-- ЮРИДИЧЕСКИЙ БЛОК -->
<div class="legal-block">
  <p>Настоящий акт составлен в соответствии с требованиями Гражданского кодекса РФ и является неотъемлемой частью Заказ-наряда № {{ order.number }}.</p>
  <p>Заказчик подтверждает, что лично осмотрел автомобиль совместно с представителем студии и согласен с зафиксированным состоянием на момент приёмки. Студия не несёт ответственности за повреждения, зафиксированные в настоящем акте.</p>
  <p>Заказчик даёт согласие на обработку персональных данных (ФИО, телефон, данные автомобиля) в соответствии с Федеральным законом № 152-ФЗ «О персональных данных» и Политикой конфиденциальности исполнителя.</p>
</div>

<!-- ПОДПИСИ -->
<div class="signatures">
  <div class="signature-block">
    <div class="sig-label">Автомобиль принял (мастер)</div>
    <div class="sig-line"></div>
    <div class="sig-name">{{ act.master_name }} &nbsp;&nbsp;&nbsp; /подпись/</div>
  </div>
  <div class="signature-block">
    <div class="sig-label">Автомобиль сдал (заказчик)</div>
    <div class="sig-line"></div>
    <div class="sig-name">{{ client.full_name }} &nbsp;&nbsp;&nbsp; /подпись/</div>
  </div>
</div>

<div class="link-ref">Дата и время приёмки: {{ act.created_at | datetime }}</div>

</body>
</html>
```

---

## Документ 2: Заказ-наряд

### HTML шаблон заказ-наряда

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; font-size: 11px; color: #1a1a1a; }

  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1.5px solid #1a1a1a; }
  .header-left .studio-name { font-size: 14px; font-weight: 600; }
  .header-left .studio-details { font-size: 9px; color: #555; margin-top: 3px; line-height: 1.5; }
  .header-right { text-align: right; }
  .header-right .doc-title { font-size: 14px; font-weight: 600; }
  .header-right .doc-number { font-size: 11px; color: #333; margin-top: 2px; }
  .legal-ref { font-size: 9px; color: #777; margin-top: 2px; font-style: italic; }

  .section { margin-bottom: 12px; }
  .section-title { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: #555; margin-bottom: 6px; }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .grid-4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; }

  .field { border: 0.5px solid #ccc; border-radius: 4px; padding: 5px 8px; }
  .field-label { font-size: 8px; color: #777; }
  .field-value { font-weight: 500; margin-top: 1px; }

  .services-table { width: 100%; border-collapse: collapse; }
  .services-table th { font-size: 9px; font-weight: 600; padding: 6px 8px; background: #f5f5f5; border: 0.5px solid #ccc; text-align: left; }
  .services-table th.right { text-align: right; }
  .services-table td { font-size: 10px; padding: 7px 8px; border: 0.5px solid #ccc; }
  .services-table td.right { text-align: right; font-weight: 500; }
  .services-table td.muted { color: #777; }

  .totals { margin-top: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .total-row { display: flex; gap: 40px; font-size: 11px; }
  .total-row.final { font-size: 13px; font-weight: 600; padding-top: 6px; border-top: 1px solid #333; margin-top: 3px; }
  .total-label { color: #555; }

  .payment-row { display: flex; gap: 8px; align-items: center; }
  .payment-badge { padding: 3px 10px; border: 0.5px solid #ccc; border-radius: 3px; font-size: 10px; color: #555; }
  .payment-badge.active { border-color: #1a1a1a; color: #1a1a1a; font-weight: 500; }
  .status-badge { padding: 3px 10px; border-radius: 3px; font-size: 10px; font-weight: 500; }
  .status-unpaid { background: #fff4e5; color: #b85000; }
  .status-partial { background: #e5f0ff; color: #0047b8; }
  .status-paid { background: #e5f5e5; color: #1a6b1a; }

  .legal-block { background: #f8f8f8; border: 0.5px solid #ddd; border-radius: 4px; padding: 8px 10px; margin-top: 10px; }
  .legal-block p { font-size: 9px; color: #444; line-height: 1.5; margin-bottom: 4px; }
  .legal-block p:last-child { margin-bottom: 0; }

  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 14px; }
  .signature-block .sig-label { font-size: 9px; color: #555; margin-bottom: 4px; }
  .signature-block .sig-line { border-bottom: 0.5px solid #333; padding-bottom: 22px; margin-bottom: 3px; }
  .signature-block .sig-name { font-size: 9px; color: #555; }
</style>
</head>
<body>

<!-- ШАПКА -->
<div class="header">
  <div class="header-left">
    <div class="studio-name">{{ studio.name }}</div>
    <div class="studio-details">
      ИНН {{ studio.inn }} · ОГРН {{ studio.ogrn }}<br>
      {{ studio.address }}<br>
      {{ studio.phone }} · {{ studio.email }}
    </div>
  </div>
  <div class="header-right">
    <div class="doc-title">Заказ-наряд № {{ order.number }}</div>
    <div class="doc-number">от {{ order.created_at | date }}</div>
    <div class="legal-ref">Договор возмездного оказания услуг (ст. 779 ГК РФ)</div>
  </div>
</div>

<!-- СТОРОНЫ -->
<div class="section">
  <div class="section-title">Стороны</div>
  <div class="grid-2">
    <div>
      <div class="field">
        <div class="field-label">Исполнитель</div>
        <div class="field-value">{{ studio.name }}</div>
      </div>
    </div>
    <div class="grid-2" style="gap: 6px;">
      <div class="field">
        <div class="field-label">Заказчик (ФИО)</div>
        <div class="field-value">{{ client.full_name }}</div>
      </div>
      <div class="field">
        <div class="field-label">Телефон</div>
        <div class="field-value">{{ client.phone }}</div>
      </div>
    </div>
  </div>
</div>

<!-- АВТОМОБИЛЬ -->
<div class="section">
  <div class="section-title">Автомобиль</div>
  <div class="grid-4">
    <div class="field">
      <div class="field-label">Марка и модель</div>
      <div class="field-value">{{ vehicle.brand }} {{ vehicle.model }}</div>
    </div>
    <div class="field">
      <div class="field-label">Год / цвет</div>
      <div class="field-value">{{ vehicle.year }}, {{ vehicle.color }}</div>
    </div>
    <div class="field">
      <div class="field-label">Госномер</div>
      <div class="field-value">{{ vehicle.plate }}</div>
    </div>
    <div class="field">
      <div class="field-label">VIN</div>
      <div class="field-value" style="font-size: 9px;">{{ vehicle.vin }}</div>
    </div>
  </div>
</div>

<!-- СРОКИ И МАСТЕР -->
<div class="section">
  <div class="grid-4">
    <div class="field">
      <div class="field-label">Дата приёмки</div>
      <div class="field-value">{{ order.created_at | date }}</div>
    </div>
    <div class="field">
      <div class="field-label">Время приёмки</div>
      <div class="field-value">{{ order.created_at | time }}</div>
    </div>
    <div class="field">
      <div class="field-label">Плановая выдача</div>
      <div class="field-value">{{ order.delivery_date | date }}</div>
    </div>
    <div class="field">
      <div class="field-label">Мастер</div>
      <div class="field-value">{{ order.master_name }}</div>
    </div>
  </div>
</div>

<!-- ПЕРЕЧЕНЬ РАБОТ -->
<div class="section">
  <div class="section-title">Перечень работ</div>
  <table class="services-table">
    <thead>
      <tr>
        <th style="width: 28px;">№</th>
        <th>Наименование услуги</th>
        <th style="width: 60px; text-align: center;">Кол-во</th>
        <th style="width: 100px;" class="right">Стоимость, ₽</th>
      </tr>
    </thead>
    <tbody>
      {{#each order.items}}
      <tr>
        <td class="muted">{{ @index_plus_1 }}</td>
        <td>{{ this.name }}</td>
        <td style="text-align: center;">{{ this.quantity }}</td>
        <td class="right">{{ this.price | currency }}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="totals">
    <div class="total-row">
      <span class="total-label">Итого:</span>
      <span>{{ order.subtotal | currency }} ₽</span>
    </div>
    {{#if order.discount}}
    <div class="total-row">
      <span class="total-label">Скидка:</span>
      <span>− {{ order.discount | currency }} ₽</span>
    </div>
    {{/if}}
    <div class="total-row final">
      <span>Итого к оплате:</span>
      <span>{{ order.total | currency }} ₽</span>
    </div>
  </div>
</div>

<!-- ОПЛАТА -->
<div class="section">
  <div class="section-title">Оплата</div>
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <div>
      <div style="font-size: 9px; color: #777; margin-bottom: 5px;">Способ оплаты</div>
      <div class="payment-row">
        <span class="payment-badge {{ if order.payment_method == 'cash' }}active{{/if}}">Наличные</span>
        <span class="payment-badge {{ if order.payment_method == 'card' }}active{{/if}}">Карта</span>
        <span class="payment-badge {{ if order.payment_method == 'transfer' }}active{{/if}}">Перевод</span>
      </div>
    </div>
    <div>
      <div style="font-size: 9px; color: #777; margin-bottom: 5px;">Статус оплаты</div>
      {{#if_eq order.payment_status 'unpaid'}}
        <span class="status-badge status-unpaid">Не оплачен</span>
      {{/if_eq}}
      {{#if_eq order.payment_status 'partial'}}
        <span class="status-badge status-partial">Частично оплачен</span>
      {{/if_eq}}
      {{#if_eq order.payment_status 'paid'}}
        <span class="status-badge status-paid">Оплачен</span>
      {{/if_eq}}
    </div>
  </div>
</div>

<!-- ГАРАНТИЯ И УСЛОВИЯ -->
<div class="legal-block">
  <p><strong>Гарантия:</strong> {{ order.guarantee_text }}</p>
  <p>Настоящий заказ-наряд является договором возмездного оказания услуг в соответствии со ст. 779 ГК РФ. Подписывая документ, заказчик подтверждает ознакомление с перечнем, стоимостью работ и даёт согласие на их выполнение.</p>
  <p>Заказчик даёт согласие на обработку персональных данных (ФИО, телефон, данные автомобиля) в соответствии с Федеральным законом № 152-ФЗ «О персональных данных» и Политикой конфиденциальности исполнителя.</p>
  <p>Споры решаются путём переговоров. При недостижении согласия — в соответствии с действующим законодательством РФ. Права потребителя регулируются Законом РФ № 2300-1 «О защите прав потребителей».</p>
</div>

<!-- ПОДПИСИ -->
<div class="signatures">
  <div class="signature-block">
    <div class="sig-label">Работы выполнил (мастер)</div>
    <div class="sig-line"></div>
    <div class="sig-name">{{ order.master_name }} &nbsp;&nbsp;&nbsp; /подпись/</div>
  </div>
  <div class="signature-block">
    <div class="sig-label">Автомобиль получил, работы проверил, качеством удовлетворён, претензий не имею (заказчик)</div>
    <div class="sig-line"></div>
    <div class="sig-name">{{ client.full_name }} &nbsp;&nbsp;&nbsp; /подпись/ &nbsp;&nbsp;&nbsp; дата выдачи: ____________</div>
  </div>
</div>

</body>
</html>
```

---

## Таблица БД для акта приёмки

```sql
CREATE TABLE acceptance_acts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id UUID NOT NULL REFERENCES studios(id),
  order_id UUID NOT NULL REFERENCES orders(id) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  master_name TEXT,
  mileage INTEGER,
  zones JSONB NOT NULL DEFAULT '[]',
  damage_description TEXT,
  valuables TEXT DEFAULT 'Не заявлены',
  photos_count INTEGER DEFAULT 0,
  pdf_url TEXT,
  CONSTRAINT rls_studio CHECK (true)
);

-- RLS политика
ALTER TABLE acceptance_acts ENABLE ROW LEVEL SECURITY;
CREATE POLICY acceptance_acts_studio ON acceptance_acts
  USING (studio_id = current_setting('app.current_studio_id')::uuid);
```

### Структура поля zones (JSONB)

```json
[
  { "zone_name": "Бампер передний", "scratches": true, "dents": false, "condition": "damaged",
    "scratches_label": "Есть", "dents_label": "Нет", "condition_label": "Повреждения" },
  { "zone_name": "Капот", "scratches": false, "dents": false, "condition": "ok",
    "scratches_label": "Нет", "dents_label": "Нет", "condition_label": "Норма" }
]
```

### Зоны кузова по умолчанию (все 16)

```js
const DEFAULT_ZONES = [
  'Бампер передний', 'Капот', 'Крыло переднее левое', 'Крыло переднее правое',
  'Дверь передняя левая', 'Дверь передняя правая', 'Дверь задняя левая',
  'Дверь задняя правая', 'Крыша', 'Крыло заднее левое', 'Крыло заднее правое',
  'Бампер задний', 'Крышка багажника', 'Стёкла', 'Диски (комплект)', 'Салон'
];
```

---

## Таблица для хранения фотографий

```sql
CREATE TABLE order_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id UUID NOT NULL REFERENCES studios(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  s3_url TEXT NOT NULL,
  thumbnail_url TEXT,
  photo_type TEXT DEFAULT 'acceptance',  -- 'acceptance' | 'progress' | 'result'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

-- Максимум 30 фото на бронь — проверка на уровне приложения, не БД
-- RLS политика
ALTER TABLE order_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_photos_studio ON order_photos
  USING (studio_id = current_setting('app.current_studio_id')::uuid);
```

---

## Puppeteer: генерация PDF

```js
// generatePdf.js
const puppeteer = require('puppeteer');
const Handlebars = require('handlebars');
const fs = require('fs');

// Регистрируем хелпер форматирования даты
Handlebars.registerHelper('date', (val) =>
  new Date(val).toLocaleDateString('ru-RU'));
Handlebars.registerHelper('time', (val) =>
  new Date(val).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
Handlebars.registerHelper('datetime', (val) =>
  new Date(val).toLocaleString('ru-RU'));
Handlebars.registerHelper('currency', (val) =>
  Number(val).toLocaleString('ru-RU'));
Handlebars.registerHelper('index_plus_1', function() {
  return this['@index'] + 1;
});

async function generatePdf(templateName, data) {
  const templateSrc = fs.readFileSync(`./templates/${templateName}.html`, 'utf8');
  const template = Handlebars.compile(templateSrc);
  const html = template(data);

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '15mm', bottom: '15mm', left: '20mm', right: '20mm' }
  });

  await browser.close();
  return pdf;
}

module.exports = { generatePdf };
```

---

## API эндпоинты

```
POST /api/orders/:orderId/acceptance-act/generate
  → генерирует PDF акта, сохраняет в S3, возвращает { pdf_url }

POST /api/orders/:orderId/work-order/generate
  → генерирует PDF заказ-наряда, сохраняет в S3, возвращает { pdf_url }

GET  /api/orders/:orderId/acceptance-act/download
  → отдаёт PDF для скачивания (Content-Disposition: attachment)

GET  /api/orders/:orderId/work-order/download
  → отдаёт PDF заказ-наряда для скачивания

POST /api/orders/:orderId/photos
  → загружает фото в S3, записывает в order_photos
  → body: multipart/form-data, поле photo_type: 'acceptance'|'progress'|'result'
  → проверять: photos_count <= 30

GET  /api/orders/:orderId/photos
  → список фото привязанных к заказу
```

---

## Кнопки в UI (на странице брони)

```
[Акт приёмки ↓]   [Заказ-наряд ↓]

При нажатии:
1. Показываем лоадер
2. POST на /generate
3. PDF открывается в новой вкладке через window.open(pdf_url)
4. Рядом кнопка "Скачать" (Content-Disposition: attachment)

Если PDF уже сгенерирован → сразу открываем сохранённый pdf_url
Если данные изменились → перегенерируем по запросу
```

---

## Важные ограничения

- Фото в PDF **не вставляются** — только указывается количество
- Фото хранятся в S3, привязаны к `order_id` через таблицу `order_photos`
- Максимум фото на бронь: **30 штук** (проверка на бэкенде при загрузке)
- Рекомендуемый минимум для акта приёмки: **8 фото** (подсказка в UI)
- PDF пересохраняется при перегенерации, старый URL перезаписывается
- Все данные студии (ИНН, ОГРН, адрес) берутся из таблицы `studios`
- Никакого хардкода названия студии в шаблонах
