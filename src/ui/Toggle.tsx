import panel from './Panel.module.css';
import styles from './Toggle.module.css';

export function Toggle({ label, checked, change, disabled = false }: {
  label: string;
  checked: boolean;
  change: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <label className={panel.row}>
    <span>{label}</span>
    <input className={styles.control} type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => change(event.target.checked)} />
  </label>;
}
