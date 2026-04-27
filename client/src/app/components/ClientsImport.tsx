/**
 * Импорт базы клиентов из .xlsx — модалка-визард.
 *
 * Поток:
 *   1. idle      — две кнопки: «Скачать шаблон» и «Загрузить заполненный файл».
 *                  Скачка шаблона срабатывает сразу через downloadClientsImportTemplate().
 *                  Загрузка открывает <input type="file"/>.
 *   2. parsing   — короткий промежуточный стейт пока exceljs читает файл.
 *   3. preview   — таблица с найденными строками (первые ~20), счётчики
 *                  «N всего, M с ошибками», селектор стратегии (skip / overwrite /
 *                  create_new) и кнопка «Загрузить N клиентов».
 *   4. uploading — спиннер пока POST /clients/bulk идёт.
 *   5. result    — итоговый отчёт: created/updated/skipped + первые 20 ошибок
 *                  от сервера. Кнопка «Готово» закрывает модалку.
 *
 * Почему всё в одном компоненте: каждый шаг — это просто другой блок
 * внутри Modal'а, общий state маленький (≤8 полей), ради этого выносить
 * под-компоненты избыточно. Если вырастет — разнесём.
 *
 * Контракт пермишенов: компонент рендерится только если canEditEntities(role)
 * (т.е. owner или manager). Master не должен видеть кнопку «Импорт» вообще —
 * это решается на стороне ProfilePage.
 */

import { useRef, useState } from 'react';
import { Upload, Download, AlertCircle, CheckCircle2, Loader2, FileSpreadsheet } from 'lucide-react';
import { Modal } from '@/app/components/ui/Modal';
import { api } from '@/utils/api';
import {
  downloadClientsImportTemplate,
  parseClientsImportFile,
  type ParsedRow,
} from '@/utils/clientsImport';

type Strategy = 'skip' | 'overwrite' | 'create_new';

type Stage = 'idle' | 'parsing' | 'preview' | 'uploading' | 'result';

interface ServerResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

interface ClientsImportProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Колбэк, который ProfilePage может использовать чтобы перезагрузить
   * счётчик клиентов или показать тост в основном интерфейсе.
   */
  onImported?: (result: ServerResult) => void;
}

/** Лимит, согласованный с серверным /clients/bulk (см. tenant.cjs). */
const ROW_LIMIT = 5000;

/** Сколько строк рендерим в превью, чтобы не повесить DOM на 5000 строк. */
const PREVIEW_LIMIT = 20;

/** Сколько ошибок от сервера показываем; остальные сворачиваем в «и ещё N». */
const SERVER_ERRORS_LIMIT = 20;

const STRATEGY_OPTIONS: Array<{ value: Strategy; title: string; desc: string }> = [
  {
    value: 'skip',
    title: 'Пропустить дубликаты',
    desc: 'Если клиент с таким телефоном уже есть — оставляем как есть. Безопасный вариант по умолчанию.',
  },
  {
    value: 'overwrite',
    title: 'Перезаписать',
    desc: 'Если клиент с таким телефоном уже есть — заменяем его поля на значения из файла. Старые поля, которых нет в файле, остаются.',
  },
  {
    value: 'create_new',
    title: 'Создать новых',
    desc: 'Создать каждую строку как нового клиента, даже если телефон уже есть в базе. Получите дубли — используйте, только если уверены.',
  },
];

export function ClientsImport({ isOpen, onClose, onImported }: ClientsImportProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [fileName, setFileName] = useState<string>('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [fatalErrors, setFatalErrors] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<Strategy>('skip');
  const [serverResult, setServerResult] = useState<ServerResult | null>(null);
  const [serverError, setServerError] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Сброс всех состояний — нужен и при закрытии, и при «Загрузить ещё».
  const reset = () => {
    setStage('idle');
    setFileName('');
    setRows([]);
    setFatalErrors([]);
    setStrategy('skip');
    setServerResult(null);
    setServerError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // ── Шаг 1: скачать шаблон ─────────────────────────────────────
  const handleDownloadTemplate = async () => {
    setDownloading(true);
    try {
      await downloadClientsImportTemplate();
    } catch (e) {
      // Очень маловероятно (ExcelJS падает только если браузер совсем древний),
      // но всё равно покажем человеку, чем пахнет.
      setServerError('Не удалось сформировать шаблон. Обновите страницу и попробуйте ещё раз.');
    } finally {
      setDownloading(false);
    }
  };

  // ── Шаг 2: пользователь выбрал файл ──────────────────────────
  const handleFilePicked = async (file: File) => {
    setFileName(file.name);
    setStage('parsing');
    setFatalErrors([]);

    const result = await parseClientsImportFile(file);

    if (result.fatalErrors.length) {
      setFatalErrors(result.fatalErrors);
      setRows([]);
      setStage('preview'); // показываем preview-экран, но с ошибкой и без таблицы
      return;
    }

    if (result.rows.length === 0) {
      setFatalErrors(['В файле не нашлось ни одной заполненной строки. Проверьте, что вы заполняли лист «Клиенты», и сохраните файл.']);
      setRows([]);
      setStage('preview');
      return;
    }

    if (result.rows.length > ROW_LIMIT) {
      setFatalErrors([`В файле ${result.rows.length} строк, а за один импорт можно загрузить не больше ${ROW_LIMIT}. Разбейте файл на несколько и загрузите по очереди.`]);
      setRows([]);
      setStage('preview');
      return;
    }

    setRows(result.rows);
    setStage('preview');
  };

  // ── Шаг 3: подтвердить и отправить на сервер ─────────────────
  const handleConfirmUpload = async () => {
    // На сервер отправляем ТОЛЬКО валидные строки (errors.length === 0).
    // Строки с локальными ошибками не блокируют импорт остальных — это
    // частый случай у пользователя «1 строка кривая, остальные ок».
    const validRows = rows
      .filter(r => r.errors.length === 0)
      .map(r => ({ client: r.client, vehicle: r.vehicle ?? null }));

    if (validRows.length === 0) {
      setServerError('В файле нет ни одной валидной строки — исправьте ошибки и загрузите снова.');
      return;
    }

    setStage('uploading');
    setServerError('');

    try {
      const res = await api.bulkImportClients({ rows: validRows, strategy });
      const result: ServerResult = {
        created: res.created,
        updated: res.updated,
        skipped: res.skipped,
        errors: res.errors,
      };
      setServerResult(result);
      setStage('result');
      onImported?.(result);
    } catch (e: any) {
      // На бэке могут вернуться: 413 (>5000 — на самом деле уже отсекли выше,
      // но на всякий случай), 403 (мастер кейс — но мы не должны были рендериться),
      // 500 (что-то поломалось в транзакции). Всё показываем человеку как есть.
      setServerError(e?.message || 'Что-то пошло не так на сервере. Попробуйте ещё раз через минуту.');
      setStage('preview');
    }
  };

  // ── Подсчёты для превью ───────────────────────────────────────
  const errorRowsCount = rows.filter(r => r.errors.length > 0).length;
  const validRowsCount = rows.length - errorRowsCount;

  // ──────────────────────────────────────────────────────────────
  // Рендер по этапам
  // ──────────────────────────────────────────────────────────────

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Импорт базы клиентов" maxWidth="xl" position="bottom">
      {/* ── Этап 1: idle ─────────────────────────────────────── */}
      {stage === 'idle' && (
        <div className="space-y-5">
          <p className="text-sm text-zinc-600 leading-relaxed">
            Загрузите базу из Excel-файла. Скачайте шаблон, заполните своими клиентами
            (имя обязательно, телефон желательно — по нему ищем дубликаты), сохраните и
            загрузите обратно. Лимит — {ROW_LIMIT.toLocaleString('ru-RU')} строк за один импорт.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              disabled={downloading}
              className="flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-zinc-100 hover:bg-zinc-200 transition-colors text-zinc-900 font-semibold disabled:opacity-50 min-h-[56px]"
            >
              {downloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
              <span>{downloading ? 'Готовим…' : 'Скачать шаблон'}</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-orange-500 hover:bg-orange-600 transition-colors text-white font-semibold min-h-[56px]"
            >
              <Upload size={18} />
              <span>Загрузить файл</span>
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFilePicked(f);
            }}
          />

          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900 leading-relaxed">
            <strong className="font-semibold block mb-1">Перед загрузкой:</strong>
            Удалите строку-пример (Иван Иванов) из шаблона — она показана только для образца.
            Колонки можно переставлять местами, заголовки переименовывать нельзя.
          </div>

          {serverError && (
            <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex gap-2">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <span>{serverError}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Этап 2: parsing ─────────────────────────────────── */}
      {stage === 'parsing' && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <Loader2 size={32} className="animate-spin text-orange-500" />
          <p className="text-sm text-zinc-600">Читаем файл «{fileName}»…</p>
        </div>
      )}

      {/* ── Этап 3: preview ─────────────────────────────────── */}
      {stage === 'preview' && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-sm text-zinc-600">
            <FileSpreadsheet size={16} className="text-zinc-400" />
            <span className="truncate">{fileName}</span>
            <button
              type="button"
              onClick={() => {
                reset();
              }}
              className="ml-auto text-orange-600 hover:text-orange-700 font-medium"
            >
              Выбрать другой файл
            </button>
          </div>

          {/* Фатальные ошибки файла — показываем вместо таблицы */}
          {fatalErrors.length > 0 && (
            <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 space-y-1">
              {fatalErrors.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}

          {/* Сводка и таблица — только если файл не отбит как fatal */}
          {fatalErrors.length === 0 && rows.length > 0 && (
            <>
              <div className="rounded-2xl bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm space-y-1">
                <div>
                  Всего строк: <strong className="font-semibold">{rows.length}</strong>
                </div>
                <div className="text-emerald-700">
                  Валидных к загрузке: <strong className="font-semibold">{validRowsCount}</strong>
                </div>
                {errorRowsCount > 0 && (
                  <div className="text-red-700">
                    Со ошибками (пропустим): <strong className="font-semibold">{errorRowsCount}</strong>
                  </div>
                )}
              </div>

              {/* Превью первых N строк */}
              <div className="rounded-2xl border border-zinc-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">№</th>
                        <th className="text-left px-3 py-2 font-medium">Имя</th>
                        <th className="text-left px-3 py-2 font-medium">Телефон</th>
                        <th className="text-left px-3 py-2 font-medium">Авто</th>
                        <th className="text-left px-3 py-2 font-medium">Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, PREVIEW_LIMIT).map(r => {
                        const isError = r.errors.length > 0;
                        const carText = r.vehicle?.brand
                          ? `${r.vehicle.brand}${r.vehicle.model ? ' ' + r.vehicle.model : ''}`
                          : '—';
                        return (
                          <tr
                            key={r.rowNum}
                            className={`border-b border-zinc-100 last:border-b-0 ${isError ? 'bg-red-50' : ''}`}
                          >
                            <td className="px-3 py-2 text-zinc-500">{r.rowNum}</td>
                            <td className="px-3 py-2 font-medium text-zinc-900">{r.client.name || '—'}</td>
                            <td className="px-3 py-2 text-zinc-700">{r.client.phone || '—'}</td>
                            <td className="px-3 py-2 text-zinc-700">{carText}</td>
                            <td className="px-3 py-2">
                              {isError ? (
                                <span className="text-red-700 text-xs" title={r.errors.join('; ')}>
                                  {r.errors[0]}
                                </span>
                              ) : (
                                <span className="text-emerald-700 text-xs flex items-center gap-1">
                                  <CheckCircle2 size={14} />
                                  ок
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {rows.length > PREVIEW_LIMIT && (
                  <div className="px-3 py-2 text-center text-xs text-zinc-500 bg-zinc-50 border-t border-zinc-200">
                    Показаны первые {PREVIEW_LIMIT} из {rows.length}. Остальные обработаются при загрузке.
                  </div>
                )}
              </div>

              {/* Стратегия */}
              <div className="space-y-2">
                <div className="text-sm font-semibold text-zinc-900">Что делать с дубликатами по телефону:</div>
                <div className="space-y-2">
                  {STRATEGY_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      className={`flex gap-3 p-3 rounded-2xl border cursor-pointer transition-colors ${
                        strategy === opt.value
                          ? 'border-orange-500 bg-orange-50'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <input
                        type="radio"
                        name="strategy"
                        value={opt.value}
                        checked={strategy === opt.value}
                        onChange={() => setStrategy(opt.value)}
                        className="mt-1 accent-orange-500"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-zinc-900">{opt.title}</div>
                        <div className="text-xs text-zinc-600 mt-0.5 leading-relaxed">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {serverError && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex gap-2">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <span>{serverError}</span>
                </div>
              )}

              <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-5 py-3 rounded-2xl bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-semibold min-h-[48px]"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={handleConfirmUpload}
                  disabled={validRowsCount === 0}
                  className="flex-1 px-5 py-3 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px]"
                >
                  {validRowsCount > 0
                    ? `Загрузить ${validRowsCount} ${pluralizeRows(validRowsCount)}`
                    : 'Нет валидных строк'}
                </button>
              </div>
            </>
          )}

          {/* Если файл отбит fatal-ом — единственная кнопка «попробовать снова» */}
          {fatalErrors.length > 0 && (
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={reset}
                className="px-5 py-3 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-semibold min-h-[48px]"
              >
                Попробовать другой файл
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Этап 4: uploading ───────────────────────────────── */}
      {stage === 'uploading' && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <Loader2 size={32} className="animate-spin text-orange-500" />
          <p className="text-sm text-zinc-600">Загружаем клиентов в базу…</p>
          <p className="text-xs text-zinc-400">Это может занять до минуты на больших файлах.</p>
        </div>
      )}

      {/* ── Этап 5: result ──────────────────────────────────── */}
      {stage === 'result' && serverResult && (
        <div className="space-y-5">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-5 text-center">
            <CheckCircle2 size={36} className="text-emerald-600 mx-auto mb-2" />
            <div className="text-lg font-semibold text-emerald-900 mb-1">Импорт завершён</div>
            <div className="text-sm text-emerald-800 space-y-0.5">
              <div>Создано новых клиентов: <strong>{serverResult.created}</strong></div>
              {serverResult.updated > 0 && (
                <div>Обновлено существующих: <strong>{serverResult.updated}</strong></div>
              )}
              {serverResult.skipped > 0 && (
                <div>Пропущено (дубликаты): <strong>{serverResult.skipped}</strong></div>
              )}
            </div>
          </div>

          {serverResult.errors.length > 0 && (
            <div className="rounded-2xl bg-red-50 border border-red-200 p-4">
              <div className="text-sm font-semibold text-red-900 mb-2 flex items-center gap-2">
                <AlertCircle size={16} />
                Ошибки на стороне сервера: {serverResult.errors.length}
              </div>
              <ul className="text-xs text-red-800 space-y-1 max-h-48 overflow-y-auto">
                {serverResult.errors.slice(0, SERVER_ERRORS_LIMIT).map((e, i) => (
                  <li key={i}>
                    Строка {e.row}: {e.reason}
                  </li>
                ))}
              </ul>
              {serverResult.errors.length > SERVER_ERRORS_LIMIT && (
                <div className="text-xs text-red-700 mt-2">
                  …и ещё {serverResult.errors.length - SERVER_ERRORS_LIMIT}.
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
            <button
              type="button"
              onClick={reset}
              className="px-5 py-3 rounded-2xl bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-semibold min-h-[48px]"
            >
              Загрузить ещё файл
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-5 py-3 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-semibold min-h-[48px]"
            >
              Готово
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Склонение «строка»/«строки»/«строк» по правилам русского языка.
 * Используется один раз для лейбла кнопки «Загрузить N строк».
 */
function pluralizeRows(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строку';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'строки';
  return 'строк';
}
