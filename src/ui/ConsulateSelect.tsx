import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { CONSULATE_ORDER, type Consulate } from '../domain/dates';
import { CITY_DISPLAY_ORDER, cityLabel } from './model';
import styles from './ConsulateSelect.module.css';

export function ConsulateSelect({ value, change, onFocus, onBlur }: {
  value: Consulate[];
  change: (value: Consulate[]) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const pendingFocus = useRef<number | null>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (open && pendingFocus.current !== null) {
      options.current[pendingFocus.current]?.focus();
      pendingFocus.current = null;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        if (root.current?.contains(document.activeElement)) onBlur();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, onBlur]);
  const focusOption = (index: number) => options.current[index]?.focus();
  const navigate = (event: KeyboardEvent, index: number) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusOption((index + (event.key === 'ArrowDown' ? 1 : -1) + CITY_DISPLAY_ORDER.length) % CITY_DISPLAY_ORDER.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focusOption(event.key === 'Home' ? 0 : CITY_DISPLAY_ORDER.length - 1);
    }
  };
  const label = value.length === 0 ? 'Select' : value.length === 1 ? cityLabel(value[0]) : `${value.length} Selected`;
  return <div ref={root} className={styles.root} onFocus={onFocus} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); onBlur(); }
  }}>
    <span className={styles.label} id={`${id}-label`}>Consulate<span className={styles.subtitle} id={`${id}-hint`}>Select one or multiple</span></span>
    <button ref={trigger} type="button" className={styles.trigger} aria-label="Consulate" aria-describedby={`${id}-hint`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
      onClick={event => { if (!open && event.detail === 0) pendingFocus.current = 0; setOpen(current => !current); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const index = event.key === 'ArrowUp' ? CITY_DISPLAY_ORDER.length - 1 : 0;
          if (open) focusOption(index);
          else { pendingFocus.current = index; setOpen(true); }
        } else if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
      }}>{label}<ChevronsUpDown size={12} aria-hidden /></button>
    {open && <div id={`${id}-menu`} className={styles.menu} role="menu" aria-labelledby={`${id}-label`}>
      {CITY_DISPLAY_ORDER.map((city, index) => <button key={city} ref={node => { options.current[index] = node; }} type="button" role="menuitemcheckbox" aria-checked={value.includes(city)} className={styles.option}
        onKeyDown={event => navigate(event, index)} onClick={() => change(CONSULATE_ORDER.filter(candidate => candidate === city ? !value.includes(city) : value.includes(candidate)))}>
        <span className={styles.check} aria-hidden>{value.includes(city) && <Check size={12} strokeWidth={3} />}</span>{cityLabel(city)}
      </button>)}
    </div>}
  </div>;
}
