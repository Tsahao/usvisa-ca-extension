// Synthetic jQuery UI/AJAX contract. No portal code or authenticated data.
// Deliberately binds date loading only to onSelect, never native change.
export function installPortalCalendar(options: { times?: string[]; businessTimes?: string[]; delay?: number; blank?: boolean;
  facilityDelay?: number; facilityDays?: unknown } = {}) {
  const date = document.getElementById('appointments_consulate_appointment_date') as HTMLInputElement;
  const time = document.getElementById('appointments_consulate_appointment_time') as HTMLSelectElement;
  const facility = document.getElementById('appointments_consulate_appointment_facility_id') as HTMLSelectElement;
  type Ajax = { status: number; responseJSON?: unknown };
  type Settings = { url: string; type: string; method?: string };
  type Handler = (event: unknown, xhr: Ajax, settings: Settings) => void;
  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, xhr: Ajax, settings: Settings) => {
    for (const [name, listeners] of handlers) if (name.split('.')[0] === event) {
      for (const listener of listeners) listener({}, xhr, settings);
    }
  };
  let calls = 0;
  let businessTimes: string[] = [];
  let businessDays = ['2026-11-19'];
  let facilityRequest: Ajax | undefined;
  facility.onchange = () => {
    businessDays = [];
    date.value = ''; time.value = '';
    const requestFacility = facility.value;
    const xhr: Ajax = { status: 0 };
    facilityRequest = xhr;
    const settings = { url: `${new URL(location.href).pathname}/days/${requestFacility}.json?appointments[expedite]=false`, type: 'GET' };
    emit('ajaxSend', xhr, settings);
    const complete = () => {
      const days = options.facilityDays ?? [{ date: '2026-11-19', business_day: true }];
      businessDays = Array.isArray(days) ? days.filter(day => day?.business_day === true).map(day => day.date) : [];
      date.value = ''; time.value = '';
      xhr.status = 200; xhr.responseJSON = days;
      emit('ajaxComplete', xhr, settings);
    };
    if (options.facilityDelay) setTimeout(complete, options.facilityDelay);
    else complete();
  };
  const onSelect = () => {
    calls++;
    businessTimes = [];
    const requestDate = date.value;
    const requestFacility = facility.value;
    const dayWarning = document.getElementById('non-consulate-business-day-message');
    if (dayWarning) dayWarning.hidden = businessDays.includes(requestDate);
    const complete = () => {
      const available = options.blank ? [] : options.times ?? ['09:15', '10:30'];
      businessTimes = options.businessTimes ?? available;
      time.replaceChildren(new Option('Select', ''), ...available.map(value => new Option(value, value)));
      const xhr = { status: 200, responseJSON: { available_times: available, business_times: businessTimes } };
      const settings = { url: `${new URL(location.href).pathname}/times/${requestFacility}.json?date=${requestDate}&appointments[expedite]=false`, type: 'GET' };
      emit('ajaxComplete', xhr, settings);
    };
    if (options.delay) setTimeout(complete, options.delay);
    else complete();
  };
  const jquery = (node: Element | Document) => node === date ? {
    datepicker: (command: string, value: string) => {
      if (command === 'option' && value === 'onSelect') return onSelect;
      if (command === 'setDate') date.value = value;
    },
    data: () => ({}),
  } : {
    on: (event: string, handler: Handler) => {
      const listeners = handlers.get(event) ?? new Set<Handler>();
      listeners.add(handler); handlers.set(event, listeners);
    },
    off: (event: string, handler: Handler) => handlers.get(event)?.delete(handler),
  };
  Object.defineProperty(window, 'jQuery', { configurable: true, writable: true, value: jquery });
  time.addEventListener('change', () => {
    const warning = document.getElementById('non-consulate-business-time-message');
    if (warning) warning.hidden = time.value === '' || businessTimes.includes(time.value);
  });
  return { get calls() { return calls; }, get listenerCount() { return [...handlers.values()].reduce((total, listeners) => total + listeners.size, 0); },
    get facilityRequest() { return facilityRequest; },
    complete: (xhr: Ajax, url: string, type = 'GET') => emit('ajaxComplete', xhr, { url, type }),
    send: (xhr: Ajax, url: string, type = 'GET') => emit('ajaxSend', xhr, { url, type }),
  };
}
