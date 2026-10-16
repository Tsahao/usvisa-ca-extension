import { useState, type UIEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { isExtension } from './storage';
import panel from './Panel.module.css';
import styles from './Coffee.module.css';

type Currency = 'USD' | 'CAD';
// Public payment destinations only. No portal/account information is attached.
const PAYMENT_LINKS: Record<Currency, string> = {
  USD: 'https://buy.stripe.com/fZu8wIfiZbhs8PU41r8EM00',
  CAD: 'https://buy.stripe.com/4gM5kw2wdado3vA9lL8EM01',
};

export function Coffee({ trackScroll, onError }: { trackScroll: (event: UIEvent<HTMLElement>) => void; onError: (message: string) => void }) {
  const [currency, setCurrency] = useState<Currency>('USD');
  const [amount, setAmount] = useState('5');
  const [opening, setOpening] = useState(false);
  const value = Number(amount);
  const valid = amount !== '' && Number.isInteger(value) && value >= 1 && value <= 99;
  const adjust = (step: number) => setAmount(String(Math.min(99, Math.max(1, (valid ? value : 5) + step))));
  const checkout = async () => {
    const destination = PAYMENT_LINKS[currency];
    if (!valid || !destination || opening) return;
    const url = new URL(destination);
    // Stripe's documented pay-what-you-want prefill uses integer cents.
    url.searchParams.set('prefilled_amount', String(value * 100));
    setOpening(true);
    try {
      if (isExtension) await chrome.tabs.create({ url: url.href });
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch {
      onError('Unable to open Stripe. Please try again.');
    } finally { setOpening(false); }
  };
  return <section className={styles.coffee} aria-label="Buy me a coffee">
    <div className={styles.scroll} onScroll={trackScroll}>
      <h2>Buy me a coffee?</h2>
      <div className={styles.currencies} role="group" aria-label="Currency">
        {(['USD', 'CAD'] as const).map(option => <button key={option} type="button" aria-pressed={currency === option} disabled={!PAYMENT_LINKS[option]} onClick={() => setCurrency(option)}>
          <span className={`${styles.flag} ${option === 'USD' ? styles.us : styles.ca}`} aria-hidden>
            {option === 'USD' ? <img src="assets/coffee/us-flag.png" alt="" /> : <>
              <img className={styles.caBackground} src="assets/coffee/ca-background.svg" alt="" />
              <img className={styles.caLeaf} src="assets/coffee/ca-flag.png" alt="" />
              <span className={styles.caLeft} /><span className={styles.caRight} />
            </>}
          </span>{option}
        </button>)}
      </div>
      <div className={styles.amount}>
        <button type="button" aria-label="Decrease amount" disabled={valid && value === 1} onClick={() => adjust(-1)}><img src="assets/coffee/minus.svg" alt="" /></button>
        <input aria-label={`Amount in ${currency}`} type="text" inputMode="numeric" autoComplete="off" value={amount} onChange={event => {
          const next = event.target.value;
          if (next === '' || (/^\d{1,2}$/.test(next) && Number(next) >= 1)) setAmount(next === '' ? '' : String(Number(next)));
        }} onBlur={() => { if (!valid) setAmount('5'); }} />
        <button type="button" aria-label="Increase amount" disabled={valid && value === 99} onClick={() => adjust(1)}><img src="assets/coffee/plus.svg" alt="" /></button>
      </div>
    </div>
    <button type="button" className={`${panel.runButton} ${styles.checkout}`} aria-label="Continue to Stripe" disabled={!valid || !PAYMENT_LINKS[currency] || opening} onClick={() => void checkout()}><ArrowRight size={28} /></button>
    <p className={panel.workflowFooter}>Payment handled by Stripe</p>
  </section>;
}
