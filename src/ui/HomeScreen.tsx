import type { MouseEvent } from 'react';
import type { Mode } from './model';
import styles from './HomeScreen.module.css';

export function HomeScreen({ choose, openTerms, testMode }: { choose: (mode: Mode) => void; openTerms: () => void; testMode?: boolean }) {
  const terms = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openTerms();
  };
  return (
    <div className={styles.root}>
      <div className={styles.logo}>
        <img className={styles.reflection} src="assets/reflection.svg" alt="" />
        <img className={styles.reflectionBottom} src="assets/reflection-bottom.svg" alt="" />
        <img className={styles.maple} src="assets/maple.svg" alt="" />
      </div>
      <h2 className={styles.title}>US Visa Scheduler</h2>
      <p className={styles.subtitle}>For Consulates In Canada</p>
      <div className={styles.cards}>
        <button
          type="button"
          className={styles.card}
          aria-label="Book or reschedule For Paid Visa Group"
          onClick={() => choose('booking')}
        >
          <span className={styles.icon} aria-hidden="true"><img src="assets/toolbar-booking.svg" width={23} height={23} alt="" /></span>
          <span className={styles.text}><strong>Book or reschedule</strong><small>For Paid Visa Group</small></span>
        </button>
        <button
          type="button"
          className={styles.card}
          aria-label="Get date alerts For Unpaid Visa Group"
          onClick={() => choose('alerts')}
        >
          <span className={styles.icon} aria-hidden="true"><img src="assets/toolbar-alerts.svg" width={23} height={23} alt="" /></span>
          <span className={styles.text}><strong>Get date alerts</strong><small>For Unpaid Visa Group</small></span>
        </button>
      </div>
      <a href="#terms" className={styles.termsLink} style={testMode ? { bottom: 40 } : undefined} onClick={terms}>Terms & Conditions</a>
    </div>
  );
}
