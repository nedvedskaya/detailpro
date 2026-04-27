import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Users, CheckSquare, Calendar as CalendarIcon, Calendar, PieChart, Plus, Search, 
  ChevronRight, ArrowUpRight, ArrowDownRight, CheckCircle2, Clock, 
  Car, ChevronLeft, ChevronDown, Phone, MessageSquare, MapPin, Info, 
  Trash2, Edit3, X, Circle, AlertOctagon, CalendarDays, Copy, Wallet,
  Save, Wrench, Maximize2, History, CalendarX, Check, Tag, AlertCircle, 
  UserPlus, Coins, CheckSquare2, User, ArrowDownLeft, TrendingUp,
  TrendingDown, DollarSign, RotateCcw
} from 'lucide-react';
const FinanceView = React.lazy(() => import('@/app/components/FinanceView').then(m => ({ default: m.FinanceView })));
const LazyTasksView = React.lazy(() => import('@/app/components/TasksView'));
const LazyCalendarView = React.lazy(() => import('@/app/components/CalendarView').then(m => ({ default: m.CalendarView })));
const LazyAdminPanel = React.lazy(() => import('@/app/components/AdminPanel').then(m => ({ default: m.AdminPanel })));
import { Button } from '@/app/components/ui/Button';
import { Modal } from '@/app/components/ui/Modal';
import { ToggleGroup } from '@/app/components/ui/ToggleGroup';
import { Badge, ActionButton, TabButton, ContactButtons } from '@/app/components/ui';
import { ClientCard, ClientListCard } from '@/app/components/clients';
import { ClientAvatar } from '@/app/components/ui/ClientAvatar';
import { BookingCard } from '@/app/components/bookings';
import { FormField, TaskFormFields, BookingFormFields, AppointmentInputs } from '@/app/components/forms';
import { ClientsView as ClientsViewComponent } from '@/app/views';
import { CalendarGrid } from '@/app/components/CalendarGrid';
import { LoginScreen } from '@/app/components/LoginScreen';
import { ResetPasswordPage } from '@/app/components/ResetPasswordPage';
import { ProfilePage } from '@/app/components/ProfilePage';
import { UserMenu } from '@/app/components/UserMenu';
import { ClientDetails } from '@/app/components/ClientDetails';
import { AutocompleteInput } from '@/app/components/ui/AutocompleteInput';
import { PaymentBadge } from '@/app/components/ui/PaymentBadge';
import { useOnlineStatus } from '@/app/hooks/useOnlineStatus';
import { usePaymentReturn } from '@/app/hooks/usePaymentReturn';
import { ToastContainer, showToast } from '@/app/components/ui/Toast';
import { NetworkIndicator } from '@/app/components/ui/NetworkIndicator';
import { saveAllData, loadAllData } from '@/app/utils/offlineCache';

// Импорт утилит и констант
import {
  BTN_METAL, BTN_METAL_DARK, CARD_METAL,
  TASK_URGENCY,
  CAR_DATABASE, CAR_ALIASES, CITIES_DATABASE,
  INITIAL_CLIENTS, INITIAL_TASKS, INITIAL_TRANSACTIONS
} from '@/utils/constants';
import { formatMoney, formatDate, getDateStr, toDateStr, safeCategoryId, buildRecordPayload, buildClientPayload, buildTaskPayload, normalizeRecord, normalizeTask, normalizeClient, normalizeTransaction, matchId } from '@/utils/helpers';
import { isTempId, isRealId, updateById, removeById, replaceById, handleApiError } from '@/utils/stateHelpers';
import { safeLocalStorage } from '@/utils/safeStorage';
import { sanitizePhone, sanitizeWhatsAppUrl, sanitizeTelUrl, safeOpenLink } from '@/utils/sanitize';
import { 
  getInitialTaskState, getInitialRecordState, 
  getInitialClientState, getInitialCalendarEntryState 
} from '@/utils/initialStates';
import { Header } from '@/app/components/ui/Header';
import { bootstrap as authBootstrap, getUser, getStudio, setSession, logout, isAuthenticated } from '@/utils/auth';
import type { Studio, UserData, Role } from '@/utils/types';
import { hasPermission, canAccessTab, getAvailableTabs, isAdmin, canEditEntities, canEditTasks, canViewFinance } from '@/utils/permissions';
import { api } from '@/utils/api';

// --- HELPER COMPONENTS ---

// MiniBranchSwitcher удалён вместе с понятием филиала (SaaS multi-tenant модель).

// AutocompleteInput вынесен в отдельный файл: /src/app/components/ui/AutocompleteInput.tsx
// AppointmentInputs вынесен в отдельный файл: /src/app/components/forms/AppointmentInputs.tsx

const TabBar = ({ activeTab, setActiveTab, userRole = 'owner', financeFlag, onTabChange = null }) => {
  const allTabs = [
    { id: 'clients', icon: Users, label: 'Клиенты' },
    { id: 'tasks', icon: CheckSquare, label: 'Задачи' },
    { id: 'calendar', icon: CalendarIcon, label: 'Календарь' },
    { id: 'finance', icon: PieChart, label: 'Финансы' },
  ];

  // Фильтруем вкладки по правам.
  // financeFlag — users.can_view_finance (или undefined для не-мигрированных БД).
  // canAccessTab возвращает false для master на 'finance' и для manager без флага,
  // см. permissions.ts.
  const tabs = allTabs.filter(tab => canAccessTab(userRole as Role, tab.id, financeFlag));
  
  const handleTabClick = (tabId) => {
    setActiveTab(tabId);
    if (onTabChange) onTabChange(tabId);
  };
  
  return (
    <div className="desktop-tabbar fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-xl border-t border-zinc-200 z-[250] shrink-0" style={{paddingBottom: 'env(safe-area-inset-bottom, 0px)', minHeight: '64px'}}>
      <div className="flex justify-between items-center max-w-lg mx-auto px-4 py-2">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => handleTabClick(tab.id)} className={`flex flex-col items-center justify-center w-full transition-all active:scale-90 ${activeTab === tab.id ? 'text-black' : 'text-zinc-400'}`}>
            <tab.icon size={24} strokeWidth={activeTab === tab.id ? 2.5 : 2} />
            <span className="text-[10px] font-bold mt-1 uppercase tracking-tighter">{String(tab.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// --- 4. FORM COMPONENT (FIXED SCROLL) ---

const ClientForm = ({ onSave, onCancel, client, title = "Новый клиент", readOnlyIdentity = false, categories = [], tags = [], users = [] }) => {
  const [formData, setFormData] = useState(client || getInitialClientState());
  const [newTasks, setNewTasks] = useState([]);
  const [taskInput, setTaskInput] = useState(() => getInitialTaskState());
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false);
  const [newRecords, setNewRecords] = useState([]);
  const [recordInput, setRecordInput] = useState(getInitialRecordState());
  const [isRecordFormOpen, setIsRecordFormOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const models = formData.carBrand && CAR_DATABASE[formData.carBrand] ? CAR_DATABASE[formData.carBrand] : [];
    setAvailableModels(models);
  }, [formData.carBrand]);
  
  const handleSave = async () => {
    if (isSaving) return;
    if (formData.name && formData.name.trim() !== '') {
      setIsSaving(true);
      try {
        await onSave(formData, newTasks, newRecords, true);
      } finally {
        setIsSaving(false);
      }
    }
  };
  
  // Закрытие без сохранения
  const handleClose = () => {
    onCancel();
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'phone') {
        let digits = value.replace(/\D/g, '');
        if (digits.length === 0) {
            setFormData(prev => ({ ...prev, [name]: '' }));
            return;
        }
        if (digits.startsWith('8')) digits = '7' + digits.slice(1);
        if (!digits.startsWith('7')) digits = '7' + digits;
        digits = digits.slice(0, 11);
        let formatted = '+7';
        if (digits.length > 1) formatted += ' (' + digits.slice(1, 4);
        if (digits.length >= 4) formatted += ')';
        if (digits.length > 4) formatted += ' ' + digits.slice(4, 7);
        if (digits.length > 7) formatted += '-' + digits.slice(7, 9);
        if (digits.length > 9) formatted += '-' + digits.slice(9, 11);
        setFormData(prev => ({ ...prev, [name]: formatted }));
        return;
    }
    if (name === 'birthDate') {
        // Автоматическое форматирование даты рождения ДД.ММ.ГГГГ
        let input = value.replace(/[^0-9]/g, ''); // Только цифры
        let formatted = '';
        
        if (input.length > 0) {
            formatted = input.substring(0, 2); // ДД
            if (input.length >= 3) {
                formatted += '.' + input.substring(2, 4); // ММ
            }
            if (input.length >= 5) {
                formatted += '.' + input.substring(4, 8); // ГГГГ
            }
        }
        
        setFormData(prev => ({ ...prev, [name]: formatted }));
        return;
    }
    if (name === 'carBrand') {
        setFormData(prev => ({ ...prev, carBrand: value, carModel: '' }));
        return;
    }
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  return (
    // На десктопе .desktop-card-modal перебивает inset-0 и превращает в центр.карточку.
    // На мобилке остаётся полноэкранный лист, slide-in снизу — без изменений.
    <div className="fixed inset-0 z-[200] bg-zinc-50 flex flex-col overflow-hidden animate-in slide-in-from-bottom-5 desktop-card-modal md:bg-white" style={{height: '100dvh', minHeight: '-webkit-fill-available'}}>
        <div className="px-6 pt-safe pb-4 bg-white border-b border-zinc-200 flex items-center justify-between shrink-0 md:!pt-5" style={{paddingTop: 'max(env(safe-area-inset-top, 12px), 48px)'}}>
            <Button variant="ghost" size="md" onClick={handleClose} className="text-base">Назад</Button>
            <span className="text-xl font-black">{String(title)}</span>
            <div className="w-[72px]"></div>
        </div>
        
        <div className="flex-1 overflow-y-auto px-6 pt-6 space-y-8 overscroll-contain -webkit-overflow-scrolling-touch" style={{paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 20px)'}}>
            <div className="space-y-4">
                <div className="flex justify-between items-center"><h3 className="text-xs font-black text-zinc-400 uppercase tracking-widest">Данные клиента</h3>{!readOnlyIdentity && <span className="text-[10px] font-bold text-zinc-400 bg-zinc-100 px-2 py-1 rounded-md">{formatDate(formData.createdAt)}</span>}</div>
                <div className="flex justify-center">
                    <ClientAvatar
                        name={formData.name}
                        avatar={formData.avatar}
                        size="lg"
                        editable
                        onAvatarChange={(avatar) => setFormData(prev => ({ ...prev, avatar }))}
                    />
                </div>
                <div className="space-y-3">
                    <input type="text" name="name" value={String(formData.name || '')} onChange={handleChange} placeholder="Имя Фамилия" className="w-full bg-white border border-zinc-300 rounded-xl p-4 text-lg font-bold outline-none focus:border-orange-500" disabled={readOnlyIdentity} />
                    <div className="flex gap-3">
                        <input type="tel" name="phone" value={String(formData.phone || '')} onChange={handleChange} placeholder="Телефон" className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold outline-none shadow-sm" disabled={readOnlyIdentity} />
                        <input type="text" name="birthDate" value={String(formData.birthDate || '')} onChange={handleChange} placeholder="ДД.ММ.ГГГГ" className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold outline-none shadow-sm" />
                    </div>
                    <AutocompleteInput name="city" value={formData.city} onChange={handleChange} options={CITIES_DATABASE} placeholder="Город" className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold outline-none shadow-sm" />
                </div>
                <div className="flex gap-3">
                    <div className="w-1/2 relative"><AutocompleteInput name="carBrand" value={formData.carBrand} onChange={handleChange} options={Object.keys(CAR_DATABASE)} aliases={CAR_ALIASES} placeholder="Марка" className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold outline-none shadow-sm" disabled={readOnlyIdentity} /><ChevronDown size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" /></div>
                    <div className="w-1/2 relative">
                        <AutocompleteInput name="carModel" value={formData.carModel} onChange={handleChange} options={availableModels} placeholder="Модель" className={`w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold outline-none shadow-sm ${!formData.carBrand ? 'opacity-50' : ''}`} disabled={!formData.carBrand || readOnlyIdentity} />
                        <ChevronDown size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                    </div>
                </div>
                <textarea name="comment" value={String(formData.comment || '')} onChange={handleChange} placeholder="Комментарий..." rows={3} className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium outline-none focus:border-orange-500 resize-none shadow-sm"/>
            </div>
            <div className="space-y-4">
                <div className="flex items-center justify-between"><h3 className="text-xs font-black text-zinc-400 uppercase tracking-widest">Задачи</h3><ActionButton variant="metal" size="md" onClick={() => setIsTaskFormOpen(!isTaskFormOpen)}>+ Задача</ActionButton></div>
                {isTaskFormOpen && (
                    <div className="bg-zinc-100 p-4 rounded-xl space-y-3 shadow-inner">
                        <TaskFormFields
                            taskData={{
                                title: String(taskInput.title || ''),
                                date: String(taskInput.date || ''),
                                time: String(taskInput.time || ''),
                                isUrgent: taskInput.isUrgent,
                                assigned_to: taskInput.assigned_to ?? null,
                            }}
                            onChange={(e: any) => setTaskInput({...taskInput, [e.target.name]: e.target.value})}
                            onToggleUrgent={() => setTaskInput({...taskInput, isUrgent: !taskInput.isUrgent})}
                            users={users}
                        />
                        <button onClick={() => { if(taskInput.title) { setNewTasks([...newTasks, {...taskInput, urgency: taskInput.isUrgent ? 'high' : 'low', id: `temp_task_${Date.now()}`}]); setTaskInput(getInitialTaskState()); setIsTaskFormOpen(false); } }} className={`w-full py-3 rounded-lg text-sm font-bold ${BTN_METAL_DARK}`}>Добавить задачу</button>
                    </div>
                )}
                <div className="space-y-2">
                    {newTasks.map(t => (
                        <div key={t.id} className="bg-white p-3 rounded-xl border border-zinc-200 flex items-center justify-between shadow-sm">
                            <div><p className="text-sm font-bold text-zinc-800">{String(t.title || '')}</p><span className="text-[10px] text-zinc-400">{formatDate(t.date)} {String(t.time || '')}</span></div>
                            <button onClick={() => { setNewTasks(newTasks.filter(item => item.id !== t.id)); }} className="text-zinc-300 hover:text-red-500 transition-colors"><X size={16}/></button>
                        </div>
                    ))}
                </div>
            </div>
            <div className="space-y-4 pt-2 border-t border-zinc-200">
                <div className="flex items-center justify-between">
                    <h3 className="text-xs font-black text-zinc-400 uppercase tracking-widest">Бронь</h3>
                    <ActionButton variant="metal" size="md" onClick={() => setIsRecordFormOpen(!isRecordFormOpen)}>+ Бронь</ActionButton>
                </div>
                {isRecordFormOpen && (
                    <div className="bg-zinc-100 p-4 rounded-xl space-y-3 shadow-inner">
                        <AppointmentInputs
                            data={recordInput}
                            onChange={(e) => {
                                if (e.target.name === '_batch') {
                                    setRecordInput(prev => ({...prev, ...e.target.value}));
                                } else {
                                    setRecordInput(prev => ({...prev, [e.target.name]: e.target.value}));
                                }
                            }}
                            categories={categories}
                            tags={tags}
                            masters={users}
                        />
                        <button 
                            onClick={() => { 
                                if(recordInput.service && recordInput.amount) { 
                                    setNewRecords([...newRecords, {...recordInput, id: `temp_rec_${Date.now()}`}]); 
                                    setRecordInput(getInitialRecordState()); 
                                    setIsRecordFormOpen(false); 
                                } 
                            }} 
                            className={`w-full py-3 rounded-lg text-sm font-bold ${BTN_METAL_DARK}`}
                        >
                            Добавить бронь
                        </button>
                    </div>
                )}
                <div className="space-y-2">
                    {newRecords.map(r => (
                        <div key={r.id} className="bg-white p-3 rounded-xl border border-zinc-200 flex items-center justify-between shadow-sm">
                            <div>
                                <p className="text-sm font-bold text-zinc-800">{String(r.service || '')}</p>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-zinc-400">{formatDate(r.date)} {String(r.time || '')}</span>
                                    <span className="text-[10px] font-bold text-orange-500">{formatMoney(r.amount)} ₽</span>
                                    {r.paymentStatus && r.paymentStatus !== 'none' && <PaymentBadge status={r.paymentStatus} size="xs" />}
                                </div>
                            </div>
                            <button onClick={() => { setNewRecords(newRecords.filter(item => item.id !== r.id)); }} className="text-zinc-300 hover:text-red-500 transition-colors"><X size={16}/></button>
                        </div>
                    ))}
                </div>
            </div>
            
            {/* Кнопка сохранения внизу */}
            <div className="pt-6 pb-4">
                <button 
                    onClick={handleSave}
                    disabled={isSaving || !formData.name || !formData.name.trim()}
                    className={`w-full py-4 rounded-xl text-lg font-bold transition-all ${isSaving ? 'bg-zinc-300 text-zinc-500 cursor-wait' : formData.name && formData.name.trim() ? 'bg-orange-500 text-white hover:bg-orange-600 active:scale-[0.98]' : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'}`}
                >
                    {isSaving ? 'Сохранение...' : 'Сохранить клиента'}
                </button>
            </div>
        </div>
    </div>
  );
};

// --- 5. MAIN VIEWS ---
// ClientDetails вынесен в отдельный файл: /src/app/components/ClientDetails.tsx


// ClientsView вынесен в отдельный файл: /src/app/views/ClientsView.tsx
const ClientsView = ClientsViewComponent;




// --- 6. MAIN APP ---

const App = () => {
  // /reset?token=... — отдельная страница сброса пароля. Маршрутизатора нет,
  // поэтому проверяем pathname вручную ДО auth bootstrap'а: на эту страницу
  // приходят разлогиненные пользователи из Telegram-сообщения, и им не нужен
  // splash/LoginScreen. Захватываем pathname один раз — если внутри
  // ResetPasswordPage редиректнут на /, это уже history.replaceState + reload.
  const [pathname] = useState(() => {
    try { return window.location.pathname; } catch (_) { return '/'; }
  });
  if (pathname === '/reset') {
    return <ResetPasswordPage />;
  }

  // Состояние авторизации.
  // bootstrapState:
  //   'pending' — делаем GET /api/auth/me; ничего не показываем (или splash)
  //   'guest'   — пользователь не залогинен → LoginScreen
  //   'authed'  — кэш user/studio заполнен, рендерим основное приложение
  // Один-единственный источник правды для guard'а — bootstrapState. user/studio
  // в стейте дублируются для реактивности (auth.ts хранит их в модульном кэше).
  const [bootstrapState, setBootstrapState] = useState<'pending' | 'guest' | 'authed'>('pending');
  const [user, setUser] = useState<UserData | null>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const isOnline = useOnlineStatus();

  // Bootstrap: один раз при маунте узнаём, есть ли валидная сессия.
  // Нужно отдельным useEffect (не useState-инициализатор), т.к. это async.
  useEffect(() => {
    let cancelled = false;
    authBootstrap()
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setUser(result.user);
          setStudio(result.studio);
          setBootstrapState('authed');
        } else {
          setBootstrapState('guest');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Сетевая ошибка — показываем LoginScreen, юзер сам нажмёт «Войти»,
        // и тогда либо успешно залогинится, либо увидит ошибку. Это лучше,
        // чем висящий splash без таймаута.
        setBootstrapState('guest');
      });
    return () => { cancelled = true; };
  }, []);

  // Все производные хуки должны быть вызваны ДО любого условного return.
  const [activeTab, setActiveTab] = useState('clients');
  const [clients, setClients] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const events = useMemo(() => {
    const derived: any[] = [];
    clients.forEach(client => {
      (client.records || []).forEach(record => {
        derived.push({
          id: `event_${record.id}`,
          clientId: client.id,
          recordId: record.id,
          date: record.date,
          endDate: record.endDate,
          time: record.time,
          service: record.service,
          title: `${client.carBrand || ''} (${record.service || ''})`,
          type: 'work',
          isCompleted: record.isCompleted || false
        });
      });
    });
    return derived;
  }, [clients]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState(null);
  const [editingClient, setEditingClient] = useState(null);
  const [avatarSavingId, setAvatarSavingId] = useState<any>(null);
  
  
  
  // Категории и теги (загружаются через API)
  const [categories, setCategories] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  // Сотрудники студии — для дропдаунов «Мастер» / «Исполнитель» в формах.
  // Загружаются через api.getUsers() (маршрут /users возвращает StudioUser[]).
  const [studioUsers, setStudioUsers] = useState<any[]>([]);
  
  // Защита от двойного клика (Set содержит recordId которые сейчас обрабатываются)
  const [processingRecords, setProcessingRecords] = useState<Set<number>>(new Set());

  // Загрузка данных из API при монтировании
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const [clientsData, tasksData, transactionsData, categoriesData, tagsData, recordsData, usersData] = await Promise.all([
          api.getClients().catch(() => []),
          api.getTasks().catch(() => []),
          api.getTransactions().catch(() => []),
          api.getCategories().catch(() => []),
          api.getTags().catch(() => []),
          api.getClientRecords().catch(() => []),
          api.getUsers().catch(() => []),
        ]);
        
        const processedTransactions = (transactionsData || []).map(normalizeTransaction);
        
        const recordsByClient = {};
        (recordsData || []).forEach(record => {
          const clientId = record.client_id;
          if (!recordsByClient[clientId]) {
            recordsByClient[clientId] = [];
          }
          recordsByClient[clientId].push(normalizeRecord(record));
        });
        
        const clientsWithRecords = (clientsData || []).map(client => 
          normalizeClient(client, recordsByClient[client.id] || [])
        );
        
        setClients(clientsWithRecords);
        const processedTasks = (tasksData || []).map(normalizeTask);
        setTasks(processedTasks);
        setTransactions(processedTransactions);
        setCategories(categoriesData || []);
        setTags(tagsData || []);
        setStudioUsers(usersData || []);
        saveAllData({
          clients: clientsWithRecords,
          tasks: processedTasks,
          transactions: processedTransactions,
          categories: categoriesData || [],
          tags: tagsData || [],
        });
      } catch (error) {
        console.error('Error loading data:', error);
        const cached = loadAllData();
        if (cached.clients) {
          setClients(cached.clients);
          setTasks(cached.tasks || []);
          setTransactions(cached.transactions || []);
          setCategories(cached.categories || []);
          setTags(cached.tags || []);
          showToast('Загружены данные из кэша. Некоторые изменения могут быть неактуальны.', 'warning');
        }
      } finally {
        setIsLoading(false);
      }
    };
    
    if (bootstrapState === 'authed') {
      loadData();
    } else if (bootstrapState !== 'pending') {
      setIsLoading(false);
    }
  }, [bootstrapState]);

  // Установка мета-тегов для iOS и мобильных устройств
  useEffect(() => {
    // Viewport для корректной адаптации на iPhone
    let viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta) {
      viewportMeta = document.createElement('meta');
      viewportMeta.setAttribute('name', 'viewport');
      document.head.appendChild(viewportMeta);
    }
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');

    // iOS Web App мета-теги
    const metaTags = [
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: 'CRM Автосервис' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'theme-color', content: '#f97316' }
    ];

    metaTags.forEach(({ name, content }) => {
      let meta = document.querySelector(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name);
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', content);
    });

    // Добавляем класс для iOS
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      document.documentElement.classList.add('ios-device');
    }
  }, []);

  // Сохранение категорий через API (с debounce через ref)
  const categoriesRef = useRef(categories);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);
  

  // После успешного login/signup LoginScreen отдаёт {user, studio} как они
  // пришли с бэка. Кладём в auth-кэш + в локальный стейт + переключаемся в 'authed'.
  const handleLogin = (payload: { user: any; studio: Studio }) => {
    const normalized = setSession(payload.user, payload.studio);
    setUser(normalized);
    setStudio(payload.studio);
    setBootstrapState('authed');
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setStudio(null);
    setBootstrapState('guest');
  };

  // Возврат браузера со страницы оплаты Prodamus (?payment=success|failed).
  // Хук:
  //   • показывает тост,
  //   • поллит /api/auth/me каждые 1.5 сек (до 12 сек), пока не увидит,
  //     что webhook долетел и подписка активна,
  //   • кладёт свежий user+studio в state, чтобы в Профиле сразу была актуальная
  //     дата окончания и плашка тарифа.
  // currentPlan берём прямо из state, чтобы хук понимал «был trial → стал solo».
  usePaymentReturn({
    enabled: bootstrapState === 'authed',
    currentPlan: studio?.plan ?? null,
    onPaymentConfirmed: ({ user: u, studio: s }) => {
      setUser(u);
      setStudio(s);
    },
  });

  // Bootstrap ещё идёт — короткий splash, чтобы не мигнуло LoginScreen-ом
  // и тут же не сменилось на основное приложение, если cookie валиден.
  if (bootstrapState === 'pending') {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="animate-pulse text-zinc-400 font-bold">Загрузка...</div>
      </div>
    );
  }

  if (bootstrapState === 'guest') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (showProfile) {
    return <ProfilePage onBack={() => setShowProfile(false)} />;
  }

  // ── Subscription gate ──────────────────────────────────────────────
  // Синхронизация доступа: менеджер/мастер видят систему ровно столько,
  // сколько и собственник. Платит собственник, а сотрудники просто работают.
  // Раньше была lock-страница «Оплатите подписку» только для не-owner — это
  // ломало рабочий процесс: пока owner шёл оплачивать, менеджер не мог
  // принять клиента. Теперь блок снят: статус подписки видно в /profile,
  // там же кнопка оплаты. На сервере `requireActiveStudio` тоже ослаблен —
  // 402 не возвращается, чтобы не было асимметрии «UI пускает, API нет».

  if (showAdmin) {
    return <React.Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-pulse text-zinc-400 font-bold">Загрузка...</div></div>}><LazyAdminPanel onBack={() => setShowAdmin(false)} /></React.Suspense>;
  }

  // ── Permissions для CRM-views ────────────────────────────────────────
  // canEdit: master видит CRM в режиме просмотра. Owner/manager — могут писать.
  //          Бэкенд защищён независимо (server/routes/tenant.cjs#canWrite),
  //          этот флаг — только для UI: скрыть кнопки «Добавить», «Удалить»,
  //          и открыть модалки в read-only.
  // viewerCanViewFinance: учитывает роль + per-user флаг. Используется для
  //          фильтрации вкладок в TabBar и для рендера FinanceView.
  const userRole = (user?.role || 'owner') as Role;
  const canEdit = canEditEntities(userRole);
  // Задачи — единственный блок, где мастер тоже пишет. См. canEditTasks().
  const canEditTasksFlag = canEditTasks(userRole);
  const viewerCanViewFinance = canViewFinance(userRole, user?.canViewFinance);

  // Если активная вкладка — finance, но текущий пользователь её не видит
  // (master или manager со снятым флагом), молча переключаемся на clients.
  // Происходит, например, если owner снял у менеджера can_view_finance,
  // и тот переоткрыл /me — в кэше ещё стояла финансовая вкладка.
  if (activeTab === 'finance' && !viewerCanViewFinance) {
    // Используем setTimeout (микро-deferred), чтобы не делать setState прямо
    // в render-фазе. На следующем тике activeTab уйдёт на 'clients'.
    setTimeout(() => setActiveTab('clients'), 0);
  }

  const createAndSaveTransaction = async (data: {
      description: string;
      amount: number;
      type: string;
      category?: string;
      date?: string;
      time?: string;
      client_record_id?: number | null;
      tags?: string[];
  }) => {
      const tempId = `temp_tx_${Date.now()}`;
      const transactionDate = data.date || getDateStr(0);
      const now = new Date();
      const transactionTime = data.time || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const payload = {
          description: data.description,
          amount: Number(data.amount),
          type: data.type,
          category: data.category || '',
          date: transactionDate,
          time: transactionTime,
          client_record_id: data.client_record_id || null,
          tags: data.tags || []
      };

      const tempTransaction = {
          id: tempId,
          ...payload,
          createdDate: transactionDate
      };
      setTransactions(prev => [tempTransaction, ...prev]);

      try {
          const saved = await api.createTransaction(payload);
          setTransactions(prev => replaceById(prev, tempId, normalizeTransaction(saved)));
      } catch (error) {
          setTransactions(prev => removeById(prev, tempId));
          handleApiError(error, 'Ошибка сохранения транзакции', 'createTransaction');
      }
  };

  const addTransaction = async (amount, title, sub, type = 'income', clientName = '', category = '', customDate = null, clientRecordId = null, recordTags = []) => {
      const fullDescription = [title, clientName ? `${clientName} • ${sub}` : sub].filter(Boolean).join(' — ');
      await createAndSaveTransaction({
          description: fullDescription,
          amount: Number(amount),
          type,
          category: category || '',
          date: customDate || getDateStr(0),
          client_record_id: clientRecordId,
          tags: recordTags
      });
  };

  const createRecordTransactions = async (rec: any, client: any, savedRecordId: any) => {
      const carInfo = `${client.carBrand || ''} ${client.carModel || ''}`.trim();
      const service = rec.service || 'Услуга';
      const category = rec.category || '';
      const tags = rec.tags || [];

      if (rec.advance && parseFloat(rec.advance) > 0) {
        await addTransaction(rec.advance, `Аванс: ${service}`, carInfo, 'income', client.name, category, rec.advanceDate || rec.date, savedRecordId, tags);
      }

      if (rec.paymentStatus === 'paid' && rec.amount && parseFloat(rec.amount) > 0) {
        const remaining = parseFloat(rec.amount) - (parseFloat(rec.advance) || 0);
        if (remaining > 0) {
          await addTransaction(remaining, `Оплата: ${service}`, carInfo, 'income', client.name, category, null, savedRecordId, tags);
        }
      }
  };

  const createEditRecordTransactions = async (rec: any, oldRecord: any, client: any, savedRecordId: any) => {
      const carInfo = `${client.carBrand || ''} ${client.carModel || ''}`.trim();
      const service = rec.service || 'Услуга';
      const category = rec.category || '';
      const tags = rec.tags || [];
      const newAdvance = parseFloat(rec.advance) || 0;
      const oldAdvance = parseFloat(oldRecord?.advance) || 0;
      const newAmount = parseFloat(rec.amount) || 0;
      const oldAmount = parseFloat(oldRecord?.amount) || 0;
      const wasPaid = oldRecord?.isPaid || oldRecord?.paymentStatus === 'paid';

      if (newAdvance > oldAdvance) {
        await addTransaction(newAdvance - oldAdvance, `Аванс: ${service}`, carInfo, 'income', client.name, category, rec.advanceDate || rec.date, savedRecordId, tags);
      } else if (newAdvance < oldAdvance) {
        await addTransaction(oldAdvance - newAdvance, `Корректировка аванса: ${service}`, carInfo, 'expense', client.name, category, rec.advanceDate || rec.date, savedRecordId, tags);
      }

      if (rec.paymentStatus === 'paid' && !wasPaid) {
        const remaining = newAmount - newAdvance;
        if (remaining > 0) {
          await addTransaction(remaining, `Оплата: ${service}`, carInfo, 'income', client.name, category, null, savedRecordId, tags);
        }
      } else if (wasPaid && rec.paymentStatus === 'paid' && newAmount !== oldAmount) {
        const diff = newAmount - oldAmount;
        if (diff !== 0) {
          await addTransaction(Math.abs(diff), `Корректировка: ${service}`, carInfo, diff > 0 ? 'income' : 'expense', client.name, category, null, savedRecordId, tags);
        }
      }
  };

  const handleAddClient = async (data, tks, recs) => {
      const now = Date.now();
      const tempId = `temp_${now}`;

      const recordsWithIds = (recs || []).map((rec, idx) => ({
        ...rec,
        id: `temp_rec_${now}_${idx}`
      }));

      const tasksWithIds = (tks || []).map((t, idx) => ({
        ...t,
        id: `temp_task_${now}_${idx}`,
        clientId: tempId,
        clientName: data.name,
        completed: false
      }));

      const entry = {
        ...data,
        id: tempId,
        createdDate: getDateStr(0),
        records: recordsWithIds
      };

      setClients(prev => [entry, ...prev]);

      if (tasksWithIds.length > 0) {
        setTasks(prev => [...tasksWithIds, ...prev]);
      }

      try {
        const savedClient = await api.createClient(buildClientPayload(data));
        const realId = savedClient.id;

        setClients(prev => updateById(prev, tempId, { id: realId }));
        // Tasks ссылаются на клиента через clientId (не первичный ключ),
        // поэтому здесь ручной map — updateById смотрит только на item.id.
        setTasks(prev => prev.map(t => t.clientId === tempId ? { ...t, clientId: realId } : t));

        for (const rec of recordsWithIds) {
          try {
            const recordData = buildRecordPayload(rec, realId);

            const savedRecord = await api.createClientRecord(recordData);
            const oldRecId = rec.id;
            setClients(prev => updateById(prev, realId, {
              records: ((prev.find(cl => cl.id === realId)?.records) || [])
                .map(r => r.id === oldRecId ? { ...r, id: savedRecord.id } : r)
            } as any));

            await createRecordTransactions(rec, data, savedRecord.id);
          } catch (e) {
            handleApiError(e, `Ошибка сохранения записи "${rec.service}". Попробуйте сохранить позже.`, 'createRecord');
            setClients(prev => updateById(prev, realId, {
              records: ((prev.find(cl => cl.id === realId)?.records) || [])
                .map(r => r.id === rec.id ? { ...r, saveError: true } : r)
            } as any));
          }
        }

        for (const task of tasksWithIds) {
          try {
            const savedTask = await api.createTask(buildTaskPayload(task, { client_id: realId }));
            setTasks(prev => updateById(prev, task.id, { id: savedTask.id, clientId: realId } as any));
          } catch (e) {
            console.error('[createTask]', e);
            setTasks(prev => updateById(prev, task.id, { saveError: true } as any));
          }
        }
      } catch (error) {
        console.error('[createClient]', error);
        showToast('Нет связи с сервером. Данные клиента сохранены локально.', 'offline');
      }
  };

  const handleAddRecord = async (clientId, rec) => {
      const c = clients.find(cl => cl.id === clientId);
      if (!c) return;
      
      const tempRecordId = `temp_rec_${Date.now()}`;
      const newRecord = { ...rec, id: tempRecordId };
      const isClientNew = isTempId(clientId);

      setClients(prev => updateById(prev, clientId, {
        records: [...((prev.find(cl => cl.id === clientId)?.records) || []), newRecord]
      } as any));

      // Если клиент ещё не сохранён в БД - запись и транзакции создадутся после сохранения клиента
      if (isClientNew) return;

      try {
        const recordData = buildRecordPayload(rec, clientId);
        const saved = await api.createClientRecord(recordData);

        setClients(prev => updateById(prev, clientId, {
          records: ((prev.find(cl => cl.id === clientId)?.records) || [])
            .map(r => r.id === tempRecordId ? { ...r, id: saved.id } : r)
        } as any));

        await createRecordTransactions(rec, c, saved.id);
        return true;
      } catch (error) {
        // Откат оптимистичного добавления — убираем temp-запись
        setClients(prev => updateById(prev, clientId, {
          records: ((prev.find(cl => cl.id === clientId)?.records) || [])
            .filter(r => r.id !== tempRecordId)
        } as any));
        handleApiError(error, 'Ошибка сохранения брони', 'createClientRecord');
        return false;
      }
  };

  const handleEditRecord = async (clientId, recordId, rec) => {
      const c = clients.find(cl => cl.id === clientId);
      if (!c) return;
      
      const oldRecord = (c.records || []).find(r => r.id === recordId);
      const newAdvance = parseFloat(rec.advance) || 0;
      const newAmount = parseFloat(rec.amount) || 0;

      setClients(prev => updateById(prev, clientId, {
        records: ((prev.find(cl => cl.id === clientId)?.records) || [])
          .map(r => r.id === recordId ? { ...rec, id: recordId } : r)
      } as any));

      const isTempRecord = isTempId(recordId);
      const isClientTemp = isTempId(clientId);

      try {
        let savedRecordId = recordId;

        if (isTempRecord && !isClientTemp) {
          const saved = await api.createClientRecord(buildRecordPayload(rec, clientId, { amount: newAmount, advance: newAdvance }));
          savedRecordId = saved.id;
          setClients(prev => updateById(prev, clientId, {
            records: ((prev.find(cl => cl.id === clientId)?.records) || [])
              .map(r => r.id === recordId ? { ...r, id: saved.id } : r)
          } as any));
        } else if (!isTempRecord) {
          const payload = buildRecordPayload(rec, clientId, { amount: newAmount, advance: newAdvance });
          delete payload.client_id;
          await api.updateClientRecord(recordId, payload);
        }

        await createEditRecordTransactions(rec, oldRecord, c, savedRecordId);
        return true;
      } catch (error) {
        // Откат оптимистичного редактирования — возвращаем старую запись
        if (oldRecord) {
          setClients(prev => updateById(prev, clientId, {
            records: ((prev.find(cl => cl.id === clientId)?.records) || [])
              .map(r => r.id === recordId ? oldRecord : r)
          } as any));
        }
        handleApiError(error, 'Ошибка обновления брони', 'updateClientRecord');
        return false;
      }
  };

  const handleCompleteRecord = async (clientId, recordId) => {
      const c = clients.find(cl => cl.id === clientId);
      if (!c) return;
      const record = (c.records || []).find(r => r.id === recordId);
      if (!record) return;
      
      // Защита от двойного клика
      if (processingRecords.has(recordId)) {
        console.log('Record is already being processed:', recordId);
        return;
      }
      
      const alreadyPaid = record.isPaid || record.paymentStatus === 'paid';
      
      // Помечаем запись как обрабатываемую
      setProcessingRecords(prev => new Set(prev).add(recordId));
      
      // СНАЧАЛА обновляем статус локально
      setClients(prev => updateById(prev, clientId, {
        records: ((prev.find(cl => cl.id === clientId)?.records) || [])
          .map(r => r.id === recordId ? { ...r, isPaid: true, isCompleted: true, paymentStatus: 'paid' } : r)
      } as any));

      const totalAmount = parseFloat(record.amount) || 0;
      const advanceAmount = parseFloat(record.advance) || 0;
      const remainingAmount = totalAmount - advanceAmount;

      const isTempRecord = isTempId(recordId);
      const isClientTemp = isTempId(clientId);

      try {
        let realRecordId = recordId;

        if (isTempRecord && !isClientTemp) {
          const saved = await api.createClientRecord(buildRecordPayload(record, clientId, {
            amount: totalAmount,
            advance: advanceAmount,
            payment_status: 'paid',
            is_paid: true,
            is_completed: true
          }));
          realRecordId = saved.id;
          setClients(prev => updateById(prev, clientId, {
            records: ((prev.find(cl => cl.id === clientId)?.records) || [])
              .map(r => r.id === recordId ? { ...r, id: saved.id } : r)
          } as any));
        } else if (!isClientTemp) {
          await api.updateClientRecord(recordId, {
            is_paid: true,
            is_completed: true,
            payment_status: 'paid'
          });
        }

        if (!alreadyPaid && remainingAmount > 0 && !isClientTemp) {
            try {
              await addTransaction(
                  remainingAmount,
                  `Оплата: ${record.service || 'Услуга'}`,
                  `${c.carBrand} ${c.carModel}`,
                  'income',
                  c.name,
                  record.category || '',
                  null,
                  realRecordId,
                  record.tags || []
              );
            } catch (txError) {
              handleApiError(txError, 'Запись отмечена как оплаченная, но транзакция не создана. Добавьте вручную.', 'createLinkedTransaction', 'warning');
            }
        }
      } catch (error) {
        // Откат: возвращаем флаги оплаты к исходным.
        setClients(prev => updateById(prev, clientId, {
          records: ((prev.find(cl => cl.id === clientId)?.records) || [])
            .map(r => r.id === recordId ? { ...r, isPaid: false, isCompleted: false, paymentStatus: record.paymentStatus || 'none' } : r)
        } as any));
        handleApiError(error, 'Ошибка при сохранении. Попробуйте снова.', 'completeRecord');
      } finally {
        setProcessingRecords(prev => {
          const newSet = new Set(prev);
          newSet.delete(recordId);
          return newSet;
        });
      }
  };
  
  const deleteLinkedTransactions = async (recordId) => {
      const linked = transactions.filter(t => t.client_record_id === recordId);
      for (const tx of linked) {
          try {
              await api.deleteTransaction(tx.id);
              setTransactions(prev => removeById(prev, tx.id));
          } catch (error) {
              console.error('[deleteLinkedTransaction]', error);
          }
      }
  };

  const handleRestoreRecord = async (clientId, recordId) => {
      const c = clients.find(cl => cl.id === clientId);
      if (!c) return;
      const record = (c.records || []).find(r => r.id === recordId);
      if (!record) return;
      
      await deleteLinkedTransactions(recordId);
      
      setClients(prev => updateById(prev, clientId, {
        records: ((prev.find(cl => cl.id === clientId)?.records) || [])
          .map(r => r.id === recordId ? { ...r, isPaid: false, isCompleted: false, paymentStatus: 'none' } : r)
      } as any));

      if (!isTempId(recordId)) {
        try {
          await api.updateClientRecord(recordId, {
            is_paid: false,
            is_completed: false,
            payment_status: 'none'
          });
        } catch (error) {
          console.error('[restoreRecord]', error);
        }
      }
  };
  
  const handleDeleteRecord = async (clientId, recordId) => {
      const c = clients.find(cl => cl.id === clientId);
      if (!c) return;
      const record = (c.records || []).find(r => r.id === recordId);
      if (!record) return;

      const prevClients = clients.map(cl => ({...cl, records: [...(cl.records || [])]}));
      const prevTransactions = [...transactions];

      const linkedTxIds = transactions.filter(t => t.client_record_id === recordId).map(t => t.id);
      setTransactions(prev => prev.filter(t => !linkedTxIds.includes(t.id)));
      setClients(prev => updateById(prev, clientId, {
        records: ((prev.find(cl => cl.id === clientId)?.records) || []).filter(r => r.id !== recordId)
      } as any));

      if (!isTempId(recordId)) {
          try {
              await api.deleteClientRecord(recordId);
              for (const txId of linkedTxIds) {
                  try { await api.deleteTransaction(txId); } catch {}
              }
          } catch (error) {
              setClients(prevClients);
              setTransactions(prevTransactions);
              handleApiError(error, 'Не удалось удалить запись — нет связи с сервером', 'deleteClientRecord');
          }
      }
  };

  // handleUpdateClientBranch удалён — нет больше понятия филиала.

  const handleUpdateClientAvatar = async (clientId, avatar) => {
      const prevAvatar = clients.find(cl => cl.id === clientId)?.avatar || null;
      setClients(prev => updateById(prev, clientId, { avatar } as any));
      setAvatarSavingId(clientId);
      try {
        await api.updateClientAvatar(clientId, avatar);
        showToast('Фото сохранено', 'success');
      } catch (error) {
        setClients(prev => updateById(prev, clientId, { avatar: prevAvatar } as any));
        handleApiError(error, 'Не удалось сохранить фото — нет связи с сервером', 'updateClientAvatar');
      } finally {
        setAvatarSavingId(null);
      }
  };
  
  const handleDeleteClient = async (id) => {
      // Подтверждение перед удалением — операция необратимая: вместе с
      // клиентом снесутся его задачи (фильтр ниже), история визитов и
      // привязка авто (cascade на бэке). Раньше клик по корзинке сразу
      // удалял — пользователь жаловался на случайные потери карточек.
      const target = clients.find(c => c.id === id);
      const nameForConfirm = target?.name?.trim() || 'этого клиента';
      const ok = window.confirm(
        `Удалить клиента «${nameForConfirm}»?\n\n` +
        'Вместе с карточкой пропадут его задачи и история визитов. ' +
        'Восстановить нельзя.'
      );
      if (!ok) return;

      const prevClients = [...clients];
      const prevTasks = [...tasks];

      setClients(removeById(clients, id));
      setTasks(tasks.filter(t => t.clientId !== id));

      if (isTempId(id)) return;

      try {
        await api.deleteClient(id);
      } catch (error) {
        setClients(prevClients);
        setTasks(prevTasks);
        handleApiError(error, 'Не удалось удалить клиента — нет связи с сервером', 'deleteClient');
      }
  };

  const handleToggleTask = async (id) => {
      const task = tasks.find(t => t.id === id);
      if (!task) return;

      const updatedTask = { ...task, completed: !task.completed };
      setTasks(prev => updateById(prev, id, { completed: updatedTask.completed } as any));

      if (isRealId(id)) {
        try {
          await api.updateTask(id, buildTaskPayload(updatedTask));
        } catch (error) {
          // Откат: возвращаем completed к прежнему значению
          setTasks(prev => updateById(prev, id, { completed: task.completed } as any));
          handleApiError(error, 'Не удалось обновить задачу', 'toggleTask');
        }
      }
  };

  const handleDeleteTask = async (id) => {
      const deletedTask = tasks.find(t => t.id === id);
      setTasks(removeById(tasks, id));

      if (isRealId(id)) {
        try {
          await api.deleteTask(id);
        } catch (error) {
          if (deletedTask) {
            setTasks(prev => [...prev, deletedTask]);
            handleApiError(error, 'Не удалось удалить задачу — нет связи с сервером', 'deleteTask');
          }
        }
      }
  };

  const handleEditTask = async (updatedTask) => {
      const oldTask = tasks.find(t => t.id === updatedTask.id);
      setTasks(prev => updateById(prev, updatedTask.id, updatedTask));

      if (!isRealId(updatedTask.id)) return;

      try {
        await api.updateTask(updatedTask.id, buildTaskPayload(updatedTask));
      } catch (error) {
        // Откат: возвращаем старую задачу
        if (oldTask) setTasks(prev => updateById(prev, updatedTask.id, oldTask));
        handleApiError(error, 'Не удалось обновить задачу', 'updateTask');
      }
  };

  const handleAddTask = async (task) => {
      const tempId = `temp_task_${Date.now()}`;
      const newTask = { ...task, id: tempId };

      // Добавляем в локальное состояние сразу (оптимистичное обновление)
      setTasks(prev => [newTask, ...prev]);

      // Если клиент ещё не сохранён - задача сохранится вместе с клиентом.
      if (task.clientId && isTempId(task.clientId)) return;

      try {
        const saved = await api.createTask(buildTaskPayload(task));
        setTasks(prev => updateById(prev, tempId, { id: saved.id, clientId: task.clientId || null } as any));
      } catch (error) {
        // Откат: убираем temp-задачу
        setTasks(prev => removeById(prev, tempId));
        handleApiError(error, 'Не удалось добавить задачу', 'createTask');
      }
  };

  const handleSaveClient = async (updatedClient) => {
      const previousClients = [...clients];
      setClients(prev => updateById(prev, updatedClient.id, {
        ...updatedClient,
        records: prev.find(cl => cl.id === updatedClient.id)?.records || updatedClient.records || []
      } as any));
      try {
        await api.updateClient(updatedClient.id, buildClientPayload(updatedClient));
      } catch (error) {
        setClients(previousClients);
        handleApiError(error, 'Нет связи с сервером. Изменения не сохранены.', 'updateClient', 'warning');
      }
  };
  
  const handleAddCategory = async (category) => {
      const tempId = `temp_cat_${Date.now()}`;
      const newCategory = { ...category, id: tempId };
      setCategories(prev => [...prev, newCategory]);
      
      try {
        const saved = await api.createCategory({ name: category.name, type: category.type, color: category.color });
        setCategories(prev => updateById(prev, tempId, { id: saved.id } as any));
      } catch (error) {
        console.error('[createCategory]', error);
        setCategories(prev => removeById(prev, tempId));
      }
  };

  const handleEditCategory = async (id, updates) => {
      const previousCategories = [...categories];
      setCategories(prev => updateById(prev, id, updates));

      try {
        await api.updateCategory(id, updates);
      } catch (error) {
        console.error('[updateCategory]', error);
        setCategories(previousCategories);
      }
  };

  const handleDeleteCategory = async (id) => {
      const previousCategories = [...categories];
      const previousTransactions = [...transactions];
      setCategories(prev => removeById(prev, id));
      setTransactions(prev => prev.map(t => matchId(t.category, id) ? {...t, category: ''} : t));

      try {
        await api.deleteCategory(id);
      } catch (error) {
        setCategories(previousCategories);
        setTransactions(previousTransactions);
        handleApiError(error, 'Не удалось удалить категорию — нет связи с сервером', 'deleteCategory');
      }
  };

  const handleAddTag = async (tag) => {
      const tempId = `temp_tag_${Date.now()}`;
      const newTag = { ...tag, id: tempId };
      setTags(prev => [...prev, newTag]);

      try {
        // type: 'all' — общий пул (теги клиентов/записей), 'income'/'expense'
        // — теги финансовых операций. FinanceView передаёт type явно;
        // остальные места создают теги без type → бэк дефолтит на 'all'.
        const saved = await api.createTag({ name: tag.name, color: tag.color, type: tag.type });
        setTags(prev => updateById(prev, tempId, { id: saved.id, type: saved.type } as any));
      } catch (error) {
        console.error('[createTag]', error);
        setTags(prev => removeById(prev, tempId));
      }
  };

  const handleDeleteTag = async (id) => {
      const previousTags = [...tags];
      const previousTransactions = [...transactions];
      setTags(prev => removeById(prev, id));
      setTransactions(prev => prev.map(t => ({
          ...t,
          tags: t.tags ? t.tags.filter(tagId => !matchId(tagId, id)) : []
      })));

      try {
        await api.deleteTag(id);
      } catch (error) {
        setTags(previousTags);
        setTransactions(previousTransactions);
        handleApiError(error, 'Не удалось удалить тег — нет связи с сервером', 'deleteTag');
      }
  };
  
  const handleAddManualTransaction = async (transactionData) => {
      const description = [transactionData.title, transactionData.sub].filter(Boolean).join(' — ');
      await createAndSaveTransaction({
          description,
          amount: Number(transactionData.amount),
          type: transactionData.type,
          category: transactionData.category || '',
          date: transactionData.date || getDateStr(0),
          time: transactionData.time || undefined,
          tags: transactionData.tags || []
      });
  };
  
  const handleEditTransaction = async (updatedTransaction) => {
      const previousTransactions = transactions;
      const description = [updatedTransaction.title, updatedTransaction.sub].filter(Boolean).join(' — ') || updatedTransaction.description || '';
      const normalized = { ...updatedTransaction, description };
      setTransactions(prev => replaceById(prev, normalized.id, normalized));
      try {
        await api.updateTransaction(normalized.id, {
          description,
          amount: normalized.amount,
          type: normalized.type,
          category: normalized.category || '',
          date: normalized.date || getDateStr(0),
          time: normalized.time || null,
          tags: normalized.tags || []
        });
      } catch (error) {
        setTransactions(previousTransactions);
        handleApiError(error, 'Не удалось обновить операцию — нет связи с сервером', 'editTransaction');
      }
  };

  const handleDeleteTransaction = async (id) => {
      const previousTransactions = transactions;
      setTransactions(prev => removeById(prev, id));
      try {
        await api.deleteTransaction(id);
      } catch (error) {
        setTransactions(previousTransactions);
        handleApiError(error, 'Не удалось удалить операцию — нет связи с сервером', 'deleteTransaction');
      }
  };

  return (
    <div className="app-container w-full bg-white flex flex-col overflow-hidden">
      <ToastContainer />
      <UserMenu onLogout={handleLogout} onShowProfile={() => setShowProfile(true)} onShowAdmin={() => setShowAdmin(true)} networkIndicator={<NetworkIndicator isOnline={isOnline} />} />
      
      <div className="flex-1 min-h-0 relative overflow-hidden bg-zinc-50">
          {activeTab === 'clients' && <ClientsView allClients={clients} onAddClient={handleAddClient} onDeleteClient={handleDeleteClient} onOpenClient={setSelectedClient} onEditClient={setEditingClient} ClientForm={ClientForm} categories={categories} tags={tags} users={studioUsers} isOnline={isOnline} canEdit={canEdit} />}
          {activeTab === 'tasks' && <React.Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-pulse text-zinc-400 font-bold">Загрузка...</div></div>}><LazyTasksView tasks={tasks} onToggleTask={handleToggleTask} onAddTask={handleAddTask} onDeleteTask={handleDeleteTask} onEditTask={handleEditTask} clients={clients} onOpenClient={setSelectedClient} canEdit={canEditTasksFlag} /></React.Suspense>}
          {activeTab === 'calendar' && <React.Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-pulse text-zinc-400 font-bold">Загрузка...</div></div>}><LazyCalendarView events={events} clients={clients} onAddRecord={handleAddRecord} onOpenClient={setSelectedClient} categories={categories} tags={tags} users={studioUsers} canEdit={canEdit} onAddClient={handleAddClient} ClientForm={ClientForm} /></React.Suspense>}
          {activeTab === 'finance' && viewerCanViewFinance && <React.Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-pulse text-zinc-400 font-bold">Загрузка...</div></div>}><FinanceView transactions={transactions} onAddTransaction={handleAddManualTransaction} onEditTransaction={handleEditTransaction} onDeleteTransaction={handleDeleteTransaction} categories={categories} onAddCategory={handleAddCategory} onEditCategory={handleEditCategory} onDeleteCategory={handleDeleteCategory} tags={tags} onAddTag={handleAddTag} onDeleteTag={handleDeleteTag} canEdit={canEdit} /></React.Suspense>}

          {selectedClient && <ClientDetails client={clients.find(c => c.id === selectedClient.id) || selectedClient} tasks={tasks} onBack={() => setSelectedClient(null)} onEdit={() => setEditingClient({ client: selectedClient, mode: 'full' })} onDelete={() => {handleDeleteClient(selectedClient.id); setSelectedClient(null);}} onAddTask={handleAddTask} onToggleTask={handleToggleTask} onAddRecord={handleAddRecord} onEditRecord={handleEditRecord} onCompleteRecord={handleCompleteRecord} onRestoreRecord={handleRestoreRecord} onDeleteRecord={handleDeleteRecord} onDeleteTask={handleDeleteTask} onEditTask={handleEditTask} onUpdateAvatar={handleUpdateClientAvatar} avatarSavingId={avatarSavingId} categories={categories} tags={tags} users={studioUsers} userRole={userRole} canEdit={canEdit} />}
          {editingClient && canEdit && <ClientForm client={editingClient.client} onSave={async (upd) => {await handleSaveClient(upd); setEditingClient(null); if(selectedClient?.id === upd.id) setSelectedClient({...selectedClient, ...upd});}} onCancel={() => setEditingClient(null)} title={'Редактирование'} categories={categories} tags={tags} users={studioUsers} />}
      </div>
      <TabBar activeTab={activeTab} setActiveTab={setActiveTab} userRole={userRole} financeFlag={user?.canViewFinance} onTabChange={() => setSelectedClient(null)} />
      {/* Глобальные правила (html/body/#root height + overflow + scrollbar)
          перенесены в client/src/styles/mobile.css, чтобы применяться ВСЕГДА —
          в т.ч. при early-return App для AdminPanel/ProfilePage. Раньше они
          жили здесь и пропадали из DOM при переключении на админку, ломая
          h-full и внутренний overflow-y-auto. */}
      <style>{`
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        :root {
          --app-height: 100vh;
          --safe-bottom: env(safe-area-inset-bottom, 0px);
          --safe-top: env(safe-area-inset-top, 0px);
        }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background-color: #ffffff;
          /* НЕ ставим padding-top/bottom из safe-area здесь: при box-sizing:
             border-box + height: 100dvh это ужимает body content-area, и
             #root/.app-container (height: 100%) становятся меньше 100dvh,
             что ломает тач-скролл во вьюхах. Safe-area обрабатывают
             UserMenu (top) и TabBar (bottom) самостоятельно. */
        }
        /* .app-container — приколачиваем к viewport через position: fixed,
           inset: 0. Это снимает любую зависимость от height-chain html → body
           → #root: какие бы у них ни были height/min-height/padding, у
           .app-container всегда чёткий размер = visual viewport (top:0
           bottom:0 left:0 right:0). На iPhone Safari это особенно важно,
           потому что 100dvh / -webkit-fill-available по-разному резолвятся
           в зависимости от состояния URL-бара, а dim flex-цепочка
           UserMenu/.flex-1/TabBar требует у родителя ОДНОЗНАЧНОЙ высоты,
           иначе внутренний overflow-y-auto перестаёт обнаруживать overflow
           и тач-скролл «не листает страницу». На десктопе медиа-запрос ниже
           перебивает inset на margin: auto — центрированная колонка. */
        .app-container {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          height: auto;
          min-height: 0;
          /* width НЕ задаём — top/bottom/left/right уже однозначно
             зафиксировали бокс. Если поставить width: 100% или auto, оно
             перебьёт логику @media (min-width:768px), где для десктопа
             колонка центрируется через left/right + transform. */
        }
        .pb-safe { padding-bottom: calc(20px + var(--safe-bottom)); }
        .animate-fade-in { animation: fadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        .animate-slide-down { animation: slideDown 0.3s ease-out forwards; }

        @supports (height: 100dvh) {
          :root { --app-height: 100dvh; }
          /* НЕ ставим body { height: 100dvh } здесь — иначе body становится
             фиксированной высотой и не может расти под длинный контент в
             гостевых экранах (LoginScreen — но этот блок и так не рендерится
             до bootstrap, поэтому риск низкий, оставляем для App-режима).
             В App-режиме .app-container { position: fixed; inset: 0 } всё
             равно не зависит от body.height — выставляем только переменную
             --app-height для консьюмеров (CalendarView и т.п.). */
          body { min-height: 100dvh; }
        }
      `}</style>
    </div>
  );
};

export default App;