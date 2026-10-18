import { ChevronUp } from 'lucide-react';
import type { Mode } from './model';
import styles from './ModeChoice.module.css';

export function ModeChoice({ choose }: { choose: (mode: Mode) => void }) {
  return <div className={styles.root}>
    <div className={styles.heading}><ChevronUp size={14} aria-hidden /><h2>Select a mode to start</h2></div>
    <div className={styles.tiles}>
      <button type="button" aria-label="Scheduling Visa fee paid" onClick={() => choose('booking')}><span className={styles.icon}><img src="assets/toolbar-booking.svg" width={23} height={23} alt="" /></span><strong>Scheduling</strong><small>Visa fee paid</small></button>
      <button type="button" aria-label="View dates Visa fee unpaid" onClick={() => choose('alerts')}><span className={styles.icon}><img src="assets/toolbar-alerts.svg" width={23} height={23} alt="" /></span><strong>View dates</strong><small>Visa fee unpaid</small></button>
    </div>
  </div>;
}
