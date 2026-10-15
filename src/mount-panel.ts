export function mountPanel(panelUrl: string): boolean {
  if (location.origin !== 'https://ais.usvisa-info.com') return false;
  const id = 'usvisa-ca-extension-preview-panel';
  const existing = document.getElementById(id);
  if (existing instanceof HTMLIFrameElement) {
    // Replace frames injected by an older build: toggling display alone would
    // keep the stale geometry that clipped the shadow into grey corners.
    if (existing.style.width !== '388px') existing.remove();
    else {
      existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
      return true;
    }
  }
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.title = 'US Visa Scheduler for Canada — simulated UI preview';
  frame.src = panelUrl;
  Object.assign(frame.style, {
    position: 'fixed', top: '-8px', right: '-8px', width: '388px',
    maxWidth: 'calc(100vw + 16px)', height: '598px', maxHeight: 'calc(100vh + 16px)',
    border: '0', background: 'transparent', colorScheme: 'light', zIndex: '2147483647',
  });
  const parsedUrl = new URL(panelUrl);
  const expectedOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  window.addEventListener('message', event => {
    if (event.source === frame.contentWindow && event.origin === expectedOrigin && event.data?.type === 'USVISA_HIDE_PANEL') frame.style.display = 'none';
  });
  document.documentElement.append(frame);
  return true;
}
