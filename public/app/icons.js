/* Ticket4T local SVG icons. No fonts, network requests or third-party artwork. */
(() => {
  'use strict';

  const paths = Object.freeze({
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    'arrow-left': '<path d="M20 12H4m6-6-6 6 6 6"/>',
    'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    'chevron-down': '<path d="m5 9 7 7 7-7"/>',
    pin: '<path d="M20 10c0 5.5-8 11-8 11S4 15.5 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    origin: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    'circle-dot': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>',
    bus: '<rect x="4" y="3" width="16" height="16" rx="4"/><path d="M4 10h16M9 3v7M7 19v2m10-2v2M7 14h2m6 0h2"/>',
    train: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 10h14M12 3v7M8 14h.01M16 14h.01M8 18l-3 3m11-3 3 3M7 20h10"/>',
    plane: '<path d="m21 3-6 18-3-7-7-3L21 3Zm-9 11 9-11"/>',
    car: '<path d="m5 8 2-4h10l2 4m-16 5 2-5h14l2 5v5H3v-5ZM3 13h18M6 18v3m12-3v3M6 15h2m8 0h2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18M8 14h2m4 0h2m-8 4h2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    swap: '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    shield: '<path d="m12 3-8 3v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
    ticket: '<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 5v3m0 3v2m0 3v3"/>',
    tag: '<path d="M3 3h8l10 10-8 8L3 11V3Z"/><circle cx="7.5" cy="7.5" r="1"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6m3 3a6 6 0 0 1 3 5v2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    leaf: '<path d="M20 4S9 1 5 8c-3 5 2 11 7 9 7-3 8-13 8-13Z"/><path d="M4 21 16 9"/>',
    wallet: '<path d="M20 8V5H6a3 3 0 0 0 0 6h15v9H6a3 3 0 0 1-3-3V8"/><path d="M21 12h-6v5h6m-3-2.5h.01"/>',
    'credit-card': '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
    cash: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 5a4 4 0 0 1-4 4m16-4a4 4 0 0 0 4 4M6 19a4 4 0 0 0-4-4m16 4a4 4 0 0 1 4-4"/>',
    qr: '<path d="M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm12 0h3v3h3v3h-6v-6ZM12 3v3m0 3v3H6m6 3v6m6-9h3M3 12h1m17 0h-1"/>',
    support: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="2" y="11" width="4" height="7" rx="2"/><rect x="18" y="11" width="4" height="7" rx="2"/><path d="M20 18c0 3-4 3-7 3"/>',
    phone: '<path d="m7 3 3 5-3 3a15 15 0 0 0 6 6l3-3 5 3-2 4C9 22 2 15 3 5l4-2Z"/>',
    seat: '<path d="M5 12V6a3 3 0 0 1 6 0v6m-6 5h12a3 3 0 0 0 0-6h-6M5 17v4m12-4v4M3 13v4h4"/>',
    bed: '<path d="M3 6v15m18-9v9M3 17h18M3 12h18v5M5 8h5v4H5V8Zm5 1h7a4 4 0 0 1 4 4"/>',
    cabin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 3v18M3 15h18M6 8h3v4H6V8Zm9 0h3v4h-3V8Z"/>',
    wifi: '<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0M12 20h.01"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8L20 9h-7l1-7Z"/>',
    usb: '<path d="M12 21V4m-3 3 3-4 3 4M12 15l-5-4V8m5 3 5-3V5"/><circle cx="7" cy="7" r="1.5"/><path d="M15.5 2h3v3h-3V2Z"/><circle cx="12" cy="19" r="2"/>',
    bottle: '<path d="M10 3h4m-4 0v4l-3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9l-3-4V3M7 13h10"/>',
    snowflake: '<path d="M12 3v18M4.2 7.5l15.6 9m0-9-15.6 9M9 4l3 3 3-3M9 20l3-3 3 3M3.5 11.5l4-1-1-4m11 11 1-4 4-1m-16 5-1-4-4-1m16-5-1 4 4 1"/>',
    luggage: '<rect x="5" y="7" width="14" height="13" rx="3"/><path d="M9 7V3h6v4M9 11v5m6-5v5M8 20v1m8-1v1"/>',
    accessible: '<circle cx="12" cy="4" r="2"/><path d="M4 8h16M12 6v8m0-3-5 10m5-10 5 10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 14-3l1 7M4 12l1 7a8 8 0 0 0 14-3"/>',
    wheel: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M4 12h6m4 0h6m-8 2v6"/>',
    print: '<path d="M7 8V3h10v5m-10 9H3V9h18v8h-4"/><rect x="7" y="14" width="10" height="7"/><path d="M17 11h.01"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    filter: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 6 9 7 9-7"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
    heart: '<path d="M12 21 3.5 12a5.5 5.5 0 0 1 8.5-7 5.5 5.5 0 0 1 8.5 7L12 21Z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    logout: '<path d="M10 3H4v18h6m4-15 6 6-6 6m-6-6h12"/>',
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    building: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1M10 21v-3h4v3"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 14v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M3 14v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15l-1 5Z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1m-1 6h1m-1 6h1"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="m3 3 18 18M10.6 5.1A13 13 0 0 1 12 5c7 0 10 7 10 7a16 16 0 0 1-3.1 4M6.3 6.3A18 18 0 0 0 2 12s3 7 10 7a12 12 0 0 0 5.7-1.3M10 10a3 3 0 0 0 4 4"/>',
  });
  const aliases = Object.freeze({ discount:'tag', payment:'credit-card', operator:'building', 'air-conditioning':'snowflake', 'water-bottle':'bottle', 'charging-port':'usb', 'sleeper-bed':'bed', headset:'support', receipt:'ticket' });
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function render(name, options = {}) {
    if (typeof options === 'number') options = {size:options};
    if (typeof options === 'string') options = {className:options};
    const requested = String(name || 'info');
    const key = Object.hasOwn(paths, requested) ? requested : Object.hasOwn(aliases, requested) ? aliases[requested] : 'info';
    const size = Number(options?.size);
    const dimension = Number.isFinite(size) && size >= 8 && size <= 128 ? ` width="${size}" height="${size}" style="width:${size}px;height:${size}px"` : '';
    const className = `icon ticket-icon${options?.className ? ` ${escape(options.className)}` : ''}`;
    const accessible = options?.label ? `role="img" aria-label="${escape(options.label)}"` : 'aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" class="${className}" data-icon-name="${escape(key)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${accessible}${dimension}>${paths[key]}</svg>`;
  }

  function decorate(root = document) {
    if (!root?.querySelectorAll) return;
    const elements = [...root.querySelectorAll('[data-icon]')];
    if (root.matches?.('[data-icon]')) elements.unshift(root);
    for (const element of elements) {
      const name = element.getAttribute('data-icon');
      if (element.getAttribute('data-icon-rendered') === name) continue;
      element.innerHTML = render(name, {size:element.dataset.iconSize, className:element.dataset.iconClass, label:element.dataset.iconLabel});
      element.setAttribute('data-icon-rendered', name);
    }
  }

  window.TicketIcons = Object.freeze({render, decorate, names:Object.freeze(Object.keys(paths))});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => decorate(), {once:true});
  else decorate();
})();
