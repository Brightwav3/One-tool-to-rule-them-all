/* Golden trace: a behavioural fingerprint of the UI.
 *
 * Phase A of the decomposition had a free oracle - every commit reassembled
 * into the previous file byte for byte. Controllers, typed errors and an event
 * bus all change bytes by definition, so that oracle is gone. This replaces it.
 *
 * The insight is that a controller refactor does not change what the app does,
 * only how it is wired. So record what it does: which requests it makes, in
 * what order, with what bodies; which toasts it raises; how many render passes
 * it runs; and what the page looks like at the end, by structure and by
 * computed style. Run the same script against ui-monolith-baseline and against
 * the working tree, and diff. An identical trace means the refactor was
 * behaviour-preserving. A diff points at the exact step that changed.
 *
 * Load it into a page and call `await trace()`. It returns a plain object;
 * compare with tests/ui/trace-diff.cjs.
 */
(() => {
  const STYLE_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
    'margin', 'padding', 'color', 'background-color', 'background-image',
    'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'opacity', 'transform', 'transition', 'z-index', 'flex', 'gap', 'overflow',
    'align-items', 'justify-content', 'text-align', 'visibility', 'pointer-events',
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(16);
  }

  /* ---------- instrumentation ----------
     Every wrapper restores the original in stop(), so a trace run leaves the
     page exactly as it found it and two runs in one session cannot stack. */
  function instrument() {
    const t = { requests: [], toasts: [], renders: 0, errors: [] };

    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      /* The 700ms state poll from bootstrap.js is wall-clock noise: how many
         times it has fired by the end of a run depends on machine speed, not on
         behaviour. Record it as a flag, never as an ordered entry. */
      const polled = url === '/api/state' && (!init || !init.method || init.method === 'GET');
      if (polled) { t.polled = true; return realFetch.apply(this, arguments); }
      t.requests.push({ url, method: init?.method || 'GET', body: init?.body ?? null });
      return realFetch.apply(this, arguments);
    };

    const realToast = window.showToast;
    if (typeof realToast === 'function') {
      window.showToast = function (title, ok = true, sub = '') {
        t.toasts.push({ title: String(title), ok: Boolean(ok), sub: String(sub) });
        return realToast.apply(this, arguments);
      };
    }

    const realRender = window.render;
    if (typeof realRender === 'function') {
      window.render = function () { t.renders += 1; return realRender.apply(this, arguments); };
    }

    /* File inputs open a native dialog that nothing dismisses in an automated
       run. The handler still runs; only the dialog is suppressed. */
    const realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') return;
      return realClick.apply(this, arguments);
    };

    const onError = e => t.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
    const onReject = e => t.errors.push(String(e.reason?.message ?? e.reason));
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onReject);

    t.stop = () => {
      window.fetch = realFetch;
      if (typeof realToast === 'function') window.showToast = realToast;
      if (typeof realRender === 'function') window.render = realRender;
      HTMLInputElement.prototype.click = realClick;
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onReject);
    };
    return t;
  }

  /* ---------- the scripted sequence ----------
     Fixed and ordered, so two runs are comparable. Actions that spend real time
     or touch real files are deliberately absent: they would make the two builds
     diverge for reasons that have nothing to do with the refactor. */
  const SCRIPT = [
    ['page', 'convert'],
    ['act', 'toggle-folder-menu'], ['act', 'toggle-folder-menu'],
    ['act', 'check-all'], ['act', 'check-all'],
    ['act', 'history-filter'], ['act', 'history-sort'],
    ['act', 'cycle-scope'],
    ['key', 'k', true],            /* command palette open */
    ['key', 'Escape', false],
    ['click', '#settingsBtn'],
    ['act', 'close-settings'],
    ['page', 'creator'],
    ['act', 'cr-format'], ['act', 'cr-continue'], ['act', 'cr-back'],
    ['page', 'editor'],
    ['act', 'ed-select-all'], ['act', 'ed-page'], ['act', 'ed-revert'],
    ['page', 'convert'],
  ];

  async function step(kind, arg, extra) {
    if (kind === 'page') document.querySelector(`.navbtn[data-page="${arg}"]`)?.click();
    if (kind === 'act') document.querySelector(`[data-act="${arg}"]`)?.click();
    if (kind === 'click') document.querySelector(arg)?.click();
    if (kind === 'key') {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: arg, ctrlKey: Boolean(extra), bubbles: true, cancelable: true,
      }));
    }
    await sleep(150);
  }

  function snapshot() {
    const struct = [], styled = [];
    document.querySelectorAll('body *:not(script)').forEach(el => {
      const id = el.tagName + '.' + [...el.classList].sort().join('.');
      struct.push(id);
      const cs = getComputedStyle(el);
      styled.push(id + '{' + STYLE_PROPS.map(p => cs.getPropertyValue(p)).join('|') + '}');
    });
    return {
      elements: struct.length,
      structure: hash(struct.join('|')),
      computed: hash(styled.join('\n')),
    };
  }

  window.trace = async function trace() {
    const t = instrument();
    const steps = [];
    for (const [kind, arg, extra] of SCRIPT) {
      const before = { req: t.requests.length, toast: t.toasts.length, render: t.renders };
      await step(kind, arg, extra);
      steps.push({
        step: `${kind}:${arg}`,
        requests: t.requests.slice(before.req).map(r => `${r.method} ${r.url} ${r.body ?? ''}`.trim()),
        toasts: t.toasts.slice(before.toast).map(x => `${x.ok ? 'ok' : 'err'} ${x.title}`),
        renders: t.renders - before.render,
        page: typeof page !== 'undefined' ? page : null,
      });
    }
    const final = snapshot();
    t.stop();
    return {
      steps,
      final,
      totals: {
        requests: t.requests.length,
        toasts: t.toasts.length,
        renders: t.renders,
        errors: t.errors.length,
      },
      errors: t.errors,
      polled: Boolean(t.polled),
    };
  };
  return 'trace() installed';
})();
