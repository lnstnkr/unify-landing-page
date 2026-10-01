// Analytics (PostHog) — custom events on top of PostHog's pageviews and autocapture.
// Custom events are prefixed so they're recognisable among other products' events;
// every event also gets site: 'unify-landing-page' (see before_send in index.html).
// Safe when PostHog is blocked: track() then does nothing.
const EVENT_PREFIX = 'unify_landing_';

const track = (event, properties = {}) => {
  try {
    if (window.posthog && typeof window.posthog.capture === 'function') {
      window.posthog.capture(EVENT_PREFIX + event, properties);
    }
  } catch (e) { /* never let analytics break the page */ }
};

(function () {
  // Clicks on elements with data-track="event_name"; data-track-* attributes become properties
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-track]');
    if (!el) return;
    const properties = { label: el.textContent.trim() };
    Object.entries(el.dataset).forEach(([key, value]) => {
      if (key.startsWith('track') && key !== 'track') {
        const name = key.slice(5).replace(/^./, (c) => c.toLowerCase()).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        properties[name] = value;
      }
    });
    track(el.dataset.track, properties);
  });

  // section_viewed: once per section per page view, when at least 40% is visible
  if (!('IntersectionObserver' in window)) return;
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const name = entry.target.dataset.section;
      if (!entry.isIntersecting || seen.has(name)) return;
      seen.add(name);
      observer.unobserve(entry.target);
      track('section_viewed', { section: name });
    });
  }, { threshold: 0.4 });
  // Tall sections can never be 40% visible on small screens; also count them once their top half is on screen
  const tallObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.intersectionRect.height > window.innerHeight * 0.5) {
        const name = entry.target.dataset.section;
        if (seen.has(name)) return;
        seen.add(name);
        observer.unobserve(entry.target);
        tallObserver.unobserve(entry.target);
        track('section_viewed', { section: name });
      }
    });
  }, { threshold: [0, 0.1, 0.2, 0.3] });
  document.querySelectorAll('[data-section]').forEach((section) => {
    observer.observe(section);
    tallObserver.observe(section);
  });
})();

// Mobile navigation toggle
(function () {
  const navbar = document.querySelector('[data-navbar]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const menu = document.querySelector('[data-nav-menu]');
  if (!navbar || !toggle || !menu) return;

  const setOpen = (open) => {
    navbar.toggleAttribute('data-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.visually-hidden').textContent = open ? 'Close menu' : 'Open menu';
  };

  toggle.addEventListener('click', () => {
    setOpen(!navbar.hasAttribute('data-open'));
  });

  // Close after choosing a link
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navbar.hasAttribute('data-open')) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Reset when resizing back to desktop
  window.matchMedia('(min-width: 1024px)').addEventListener('change', (mq) => {
    if (mq.matches) setOpen(false);
  });
})();

// "How it works" stacking cards: scale down cards as the next ones slide over them
(function () {
  const cards = Array.from(document.querySelectorAll('.step-card'));
  if (cards.length < 2) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SCALE_STEP = 0.04; // how much a card shrinks per card stacked on top of it
  let ticking = false;

  const update = () => {
    ticking = false;

    if (reducedMotion.matches || getComputedStyle(cards[0]).position !== 'sticky') {
      cards.forEach((card) => { card.style.transform = ''; });
      return;
    }

    // progress[j]: 0 while card j is a full card-height below its sticky spot, 1 once it's stuck
    const rects = cards.map((card) => card.getBoundingClientRect());
    const progress = cards.map((card, j) => {
      if (j === 0) return 0;
      const stickyTop = parseFloat(getComputedStyle(card).top) || 0;
      const distance = rects[j].top - stickyTop;
      const travel = rects[j - 1].height;
      return Math.min(1, Math.max(0, 1 - distance / travel));
    });

    cards.forEach((card, i) => {
      const covered = progress.slice(i + 1).reduce((sum, p) => sum + p, 0);
      card.style.transform = covered > 0 ? `scale(${1 - covered * SCALE_STEP})` : '';
    });
  };

  const requestUpdate = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  reducedMotion.addEventListener('change', requestUpdate);
  update();
})();

// Custom select menus: enhances <select data-searchable> into a filterable combobox and
// <select data-listbox> into the same menu without search (select-only).
// The native select stays in the form (hidden) and remains the source of truth for the value.
(function () {
  const normalize = (text) =>
    text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

  let uid = 0;

  document.querySelectorAll('select[data-searchable], select[data-listbox]').forEach((select) => {
    const searchable = select.hasAttribute('data-searchable');
    const options = Array.from(select.options)
      .filter((option) => option.value !== '')
      .map((option) => ({ value: option.value, label: option.textContent, key: normalize(option.textContent) }));

    const listId = `combobox-list-${++uid}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'combobox';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = select.className;
    input.id = select.id;
    input.dataset.fieldName = select.name; // the real form field name, e.g. for analytics
    input.required = select.required;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    if (!searchable) {
      // Select-only: no typing, no on-screen keyboard; letters jump to options instead
      input.setAttribute('aria-autocomplete', 'none');
      input.setAttribute('inputmode', 'none');
      input.classList.add('combobox__input--static');
    }

    const list = document.createElement('ul');
    list.className = 'combobox__list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    // Hide the native select but keep it in the form for submission
    select.id = `${select.id}-native`;
    select.className = 'combobox__native';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.required = false;

    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(input, list, select);

    let filtered = options;
    let activeIndex = -1;

    const selectedLabel = () => select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent : '';

    const syncValidity = () => {
      input.setCustomValidity(input.value && !select.value ? 'Please choose an option from the list.' : '');
    };

    const renderList = () => {
      list.replaceChildren();

      if (!filtered.length) {
        const empty = document.createElement('li');
        empty.className = 'combobox__empty';
        empty.textContent = 'No matches';
        list.append(empty);
        return;
      }

      const query = searchable ? normalize(input.value) : '';
      filtered.forEach((option, index) => {
        const item = document.createElement('li');
        item.className = 'combobox__option';
        item.id = `${listId}-${index}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === select.value));
        item.dataset.index = String(index);

        // Bold the matching part of the label
        const at = query ? option.key.indexOf(query) : -1;
        if (at >= 0) {
          const strong = document.createElement('strong');
          strong.textContent = option.label.slice(at, at + query.length);
          item.append(option.label.slice(0, at), strong, option.label.slice(at + query.length));
        } else {
          item.textContent = option.label;
        }

        list.append(item);
      });
    };

    const setActive = (index) => {
      const items = list.querySelectorAll('.combobox__option');
      if (!items.length) return;
      activeIndex = (index + items.length) % items.length;
      items.forEach((item, i) => item.classList.toggle('is-active', i === activeIndex));
      const active = items[activeIndex];
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    };

    const open = () => {
      if (!list.hidden) return;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      renderList();
      const selectedIndex = filtered.findIndex((option) => option.value === select.value);
      if (selectedIndex >= 0) setActive(selectedIndex);
    };

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    };

    const choose = (option) => {
      select.value = option.value;
      input.value = option.label;
      filtered = options;
      syncValidity();
      close();
      select.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const filter = () => {
      const query = normalize(input.value);
      const starts = [];
      const contains = [];
      options.forEach((option) => {
        if (!query || option.key.startsWith(query)) starts.push(option);
        else if (option.key.includes(query)) contains.push(option);
      });
      filtered = [...starts, ...contains];
    };

    input.addEventListener('input', () => {
      // Typing clears the current choice until a new one is picked
      if (select.value) select.value = '';
      filter();
      syncValidity();
      if (list.hidden) open();
      else renderList();
      if (input.value) setActive(0);
    });

    input.addEventListener('click', () => (list.hidden ? open() : close()));

    // Select-only: type-ahead jumps to the first option starting with the typed letters
    let typed = '';
    let typedTimer;
    const typeAhead = (char) => {
      clearTimeout(typedTimer);
      typed += char.toLowerCase();
      typedTimer = setTimeout(() => { typed = ''; }, 700);
      const index = filtered.findIndex((option) => option.key.startsWith(typed));
      if (index < 0) return;
      if (list.hidden) choose(filtered[index]);
      else setActive(index);
    };

    if (!searchable) {
      input.addEventListener('beforeinput', (event) => event.preventDefault());
      input.addEventListener('paste', (event) => event.preventDefault());
    }

    input.addEventListener('keydown', (event) => {
      if (!searchable) {
        if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          typeAhead(event.key);
          return;
        }
        if ((event.key === ' ' || event.key === 'Enter') && list.hidden) {
          event.preventDefault();
          open();
          return;
        }
        if (event.key === ' ' && !list.hidden && activeIndex >= 0) {
          event.preventDefault();
          choose(filtered[activeIndex]);
          return;
        }
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (list.hidden) open();
          else setActive(activeIndex + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          if (list.hidden) open();
          else setActive(activeIndex - 1);
          break;
        case 'Enter':
          if (!list.hidden && activeIndex >= 0 && filtered[activeIndex]) {
            event.preventDefault();
            choose(filtered[activeIndex]);
          }
          break;
        case 'Escape':
          if (!list.hidden) {
            event.preventDefault();
            close();
          }
          break;
        case 'Tab':
          if (!list.hidden && input.value && activeIndex >= 0 && filtered[activeIndex]) {
            choose(filtered[activeIndex]);
          }
          break;
      }
    });

    // mousedown keeps focus in the input while picking
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const item = event.target.closest('.combobox__option');
      if (item) choose(filtered[Number(item.dataset.index)]);
    });
    list.addEventListener('mousemove', (event) => {
      const item = event.target.closest('.combobox__option');
      if (item && Number(item.dataset.index) !== activeIndex) setActive(Number(item.dataset.index));
    });

    input.addEventListener('blur', () => {
      // Accept an exact (case-insensitive) typed match, otherwise restore the last choice
      if (!select.value) {
        const exact = options.find((option) => option.key === normalize(input.value));
        if (exact) choose(exact);
      }
      if (select.value) input.value = selectedLabel();
      filtered = options;
      syncValidity();
      close();
    });

    select.form?.addEventListener('reset', () => {
      setTimeout(() => {
        input.value = selectedLabel();
        filtered = options;
        syncValidity();
      });
    });
  });
})();

// Trial request form — mirrors the Bizzdesign Unify trial webform
(function () {
  const form = document.querySelector('[data-trial-form]');
  const status = document.querySelector('[data-form-status]');
  if (!form || !status) return;

  // --- State: only shown and required for Canada / United States -------------
  const country = form.querySelector('select[name="country"]');
  const stateField = form.querySelector('[data-state-field]');
  const state = form.querySelector('select[name="state"]');

  const toggleState = () => {
    const needsState = ['Canada', 'United States'].includes(country.value);
    stateField.hidden = !needsState;
    state.required = needsState; // still submitted (empty) when hidden, like the original form
    if (!needsState) {
      state.value = '';
      clearError(state);
    }
  };

  // --- Attribution from the landing URL --------------------------------------
  // Cookieless: nothing is stored in the browser, so first and last touch are both
  // taken from the URL of this visit.
  const TRACKING = ['gclid', 'msclkid', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term'];
  const params = new URLSearchParams(window.location.search);

  TRACKING.forEach((key) => {
    const value = params.get(key);
    if (!value) return;
    const lastName = key.startsWith('utm_') ? key : `last_${key}`;
    if (form.elements[lastName]) form.elements[lastName].value = value;
    if (form.elements[`first_${key}`]) form.elements[`first_${key}`].value = value;
  });

  // --- Validation with the same messages as the Bizzdesign form --------------
  const fields = Array.from(form.querySelectorAll('.field__input, .checkbox__input'));

  const labelText = (field) => {
    const label = form.querySelector(`label[for="${field.id}"]`);
    return label ? label.textContent.trim() : field.name;
  };

  const errorFor = (field) => {
    const v = field.validity;
    if (v.valueMissing) {
      return field.type === 'checkbox' ? 'This field is required.' : `${labelText(field)} field is required.`;
    }
    if (v.patternMismatch) return field.dataset.patternError || `${labelText(field)} is not valid.`;
    if (v.typeMismatch) return `The email address ${field.value} is not valid.`;
    if (v.tooShort) return `${labelText(field)} must be at least ${field.minLength} characters.`;
    return field.validationMessage;
  };

  const errorEl = (field) => {
    const container = field.closest('.field, .checkbox');
    let el = container.querySelector(':scope > .field__error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'field__error';
      el.id = `${field.id || field.name}-error`;
      container.append(el);
    }
    return el;
  };

  function clearError(field) {
    field.removeAttribute('aria-invalid');
    const el = field.closest('.field, .checkbox')?.querySelector(':scope > .field__error');
    if (el) el.remove();
    const describedBy = (field.getAttribute('aria-describedby') || '').split(' ').filter((id) => !id.endsWith('-error'));
    if (describedBy.length) field.setAttribute('aria-describedby', describedBy.join(' '));
    else field.removeAttribute('aria-describedby');
  }

  const validateField = (field) => {
    if (field.checkValidity()) {
      clearError(field);
      return true;
    }
    const el = errorEl(field);
    el.textContent = errorFor(field);
    field.setAttribute('aria-invalid', 'true');
    const describedBy = new Set((field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
    describedBy.add(el.id);
    field.setAttribute('aria-describedby', [...describedBy].join(' '));
    return false;
  };

  fields.forEach((field) => {
    const event = field.tagName === 'SELECT' || field.type === 'checkbox' ? 'change' : 'blur';
    field.addEventListener(event, () => validateField(field));
    field.addEventListener('input', () => {
      if (field.getAttribute('aria-invalid') === 'true') validateField(field);
    });
  });

  country.addEventListener('change', toggleState);
  toggleState();

  // trial_form_started: first interaction with any field
  form.addEventListener('focusin', () => track('trial_form_started'), { once: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const invalid = fields.filter((field) => !validateField(field));
    if (invalid.length) {
      // Field names only — never what was typed
      track('trial_form_error', { fields: invalid.map((field) => field.name || field.dataset.fieldName || field.id) });
      status.dataset.state = 'error';
      status.textContent = 'Please correct the highlighted fields.';
      invalid[0].focus();
      return;
    }

    const data = new FormData(form);

    // Where to send the submission. The Bizzdesign Drupal webform can't accept
    // posts from another page (reCAPTCHA, antibot and session tokens), so this
    // needs an approved endpoint. Set it via data-endpoint on the <form>.
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      console.info('Trial request (no endpoint configured)', Object.fromEntries(data));
    } else {
      try {
        const response = await fetch(endpoint, { method: 'POST', body: data });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        track('trial_form_submit_failed', { reason: String(error.message || error) });
        status.dataset.state = 'error';
        status.textContent = 'Something went wrong while sending your request. Please try again.';
        return;
      }
    }

    // No personal data (name, email, company) in analytics
    track('trial_form_submitted', {
      country: data.get('country') || '',
      state: data.get('state') || '',
      storage_location: data.get('unify_trial_hosting_region') || '',
      marketing_opt_in: data.get('opt_in_consent') === '1',
    });

    status.dataset.state = 'success';
    status.textContent = 'Thanks! We’ll get your trial workspace ready and email you shortly.';
    form.reset();
    fields.forEach(clearError);
    toggleState();
  });
})();
