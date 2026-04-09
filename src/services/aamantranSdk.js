function getAamantranSdkScript() {
  return `(function () {
  var ctx = window.__AAMANTRAN__ || {};
  var apiBase = String(ctx.apiBase || '').replace(/\\/$/, '');
  var eventSlug = String(ctx.eventSlug || '');
  var functions = Array.isArray(ctx.functions) ? ctx.functions : [];
  var rsvpOn = ctx.rsvpEnabled !== false;
  var guestNotesOn = ctx.guestNotesEnabled !== false;

  function qs(root, selector) { return root.querySelector(selector); }
  function qsa(root, selector) { return Array.prototype.slice.call(root.querySelectorAll(selector)); }
  function byField(root, name) { return qs(root, '[data-field="' + name + '"]'); }
  function statusNode(form, kind) { return qs(form, '[data-aamantran="' + kind + '-status"]'); }
  function setStatus(node, msg, isError) {
    if (!node) return;
    node.textContent = msg || '';
    node.style.color = isError ? '#c62828' : '#2e7d32';
  }
  function trim(v) { return String(v == null ? '' : v).trim(); }

  function extractFormValue(form, fieldName) {
    var el = byField(form, fieldName);
    if (!el) return '';
    if (el.type === 'checkbox') return !!el.checked;
    return trim(el.value);
  }

  function normalizeAttending(raw) {
    var v = String(raw || '').toLowerCase();
    if (v === 'yes' || v === 'true' || v === '1' || v === 'attending') return true;
    if (v === 'no' || v === 'false' || v === '0' || v === 'declining') return false;
    return null;
  }

  function initFunctionOptions(form) {
    var host = byField(form, 'functions');
    if (!host) return;
    if (functions.length <= 1) {
      host.style.display = 'none';
      return;
    }
    host.innerHTML = '';
    functions.forEach(function (fn) {
      var id = String(fn.id || '');
      var label = document.createElement('label');
      label.style.display = 'block';
      label.style.marginBottom = '6px';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = id;
      cb.setAttribute('data-aamantran-function', 'true');
      cb.checked = true;
      var text = document.createTextNode(' ' + String(fn.name || 'Function'));
      label.appendChild(cb);
      label.appendChild(text);
      host.appendChild(label);
    });
  }

  function selectedFunctionIds(form) {
    if (functions.length === 1) return [String(functions[0].id)];
    var checkboxes = qsa(form, '[data-aamantran-function="true"]');
    return checkboxes.filter(function (cb) { return cb.checked; }).map(function (cb) { return String(cb.value); });
  }

  function renderWishWall(items) {
    var wall = qs(document, '[data-aamantran="wish-wall"]');
    if (!wall) return;
    wall.innerHTML = '';
    (items || []).forEach(function (wish) {
      var wrap = document.createElement('div');
      wrap.className = 'aamantran-wish';
      var message = document.createElement('p');
      message.className = 'aamantran-wish-message';
      message.textContent = '"' + String(wish.message || '') + '"';
      var author = document.createElement('span');
      author.className = 'aamantran-wish-author';
      author.textContent = '— ' + String(wish.guestName || 'Guest');
      wrap.appendChild(message);
      wrap.appendChild(author);
      wall.appendChild(wrap);
    });
  }

  async function loadWishes() {
    if (!guestNotesOn || !apiBase || !eventSlug) return;
    try {
      var res = await fetch(apiBase + '/api/public/wishes/' + encodeURIComponent(eventSlug));
      if (!res.ok) return;
      var data = await res.json();
      renderWishWall(Array.isArray(data.wishes) ? data.wishes : []);
    } catch (_e) {}
  }

  function bindRsvpForms() {
    if (!rsvpOn) return;
    qsa(document, 'form[data-aamantran="rsvp"]').forEach(function (form) {
      initFunctionOptions(form);
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var status = statusNode(form, 'rsvp');
        var lockKey = 'aamantran:rsvp:' + eventSlug;
        if (window.localStorage.getItem(lockKey) === '1') {
          setStatus(status, 'RSVP already submitted from this browser.', false);
          return;
        }

        var guestName = extractFormValue(form, 'guestName');
        var attendingRaw = extractFormValue(form, 'attending');
        var attending = normalizeAttending(attendingRaw);
        var functionIds = selectedFunctionIds(form);

        if (!guestName || attending === null) {
          setStatus(status, 'Please fill all required RSVP fields.', true);
          return;
        }
        if (!functionIds.length) {
          setStatus(status, 'Please select at least one function.', true);
          return;
        }

        var payload = {
          eventSlug: eventSlug,
          guestName: guestName,
          phone: extractFormValue(form, 'phone') || null,
          email: extractFormValue(form, 'email') || null,
          attending: attending,
          plusCount: Number(extractFormValue(form, 'plusCount') || 0),
          mealPreference: extractFormValue(form, 'mealPreference') || null,
          message: extractFormValue(form, 'message') || null,
          functionIds: functionIds
        };

        try {
          setStatus(status, 'Submitting RSVP...', false);
          var res = await fetch(apiBase + '/api/public/rsvp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            setStatus(status, data.message || 'Failed to submit RSVP.', true);
            return;
          }
          window.localStorage.setItem(lockKey, '1');
          setStatus(status, 'RSVP submitted successfully. Thank you!', false);
          form.reset();
        } catch (_e) {
          setStatus(status, 'Could not submit RSVP right now.', true);
        }
      });
    });
  }

  function bindWishForms() {
    if (!guestNotesOn) return;
    qsa(document, 'form[data-aamantran="wish"]').forEach(function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var status = statusNode(form, 'wish');
        var payload = {
          eventSlug: eventSlug,
          guestName: extractFormValue(form, 'guestName'),
          message: extractFormValue(form, 'message')
        };
        if (!payload.guestName || !payload.message) {
          setStatus(status, 'Name and message are required.', true);
          return;
        }
        try {
          setStatus(status, 'Sharing your wishes...', false);
          var res = await fetch(apiBase + '/api/public/wishes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            setStatus(status, data.message || 'Failed to submit wish.', true);
            return;
          }
          setStatus(status, 'Your wish has been shared.', false);
          form.reset();
          loadWishes();
        } catch (_e) {
          setStatus(status, 'Could not share your wish right now.', true);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bindRsvpForms();
      bindWishForms();
      loadWishes();
    });
  } else {
    bindRsvpForms();
    bindWishForms();
    loadWishes();
  }
})();`;
}

function injectAamantranRuntime(html, context) {
  if (!html) return html;
  const payload = JSON.stringify(context || {});
  const script = `<script>window.__AAMANTRAN__=${payload};</script><script src="/sdk/aamantran-sdk.js"></script>`;
  const closeBody = html.toLowerCase().lastIndexOf('</body>');
  if (closeBody === -1) return `${html}${script}`;
  return `${html.slice(0, closeBody)}${script}${html.slice(closeBody)}`;
}

module.exports = {
  getAamantranSdkScript,
  injectAamantranRuntime,
};
