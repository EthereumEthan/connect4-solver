/*
 * Tab shell. Deliberately tiny and independent of both games: it only toggles
 * [hidden] on the panels, so a Connect 4 game in progress survives a tab switch
 * (the DOM is never torn down) and the Catan modules are untouched.
 *
 * The selected tab is mirrored into the URL hash so a reload keeps your place.
 */
(function () {
  'use strict';

  var tabs = [].slice.call(document.querySelectorAll('.tabbar [role="tab"]'));
  if (!tabs.length) return;

  function panelOf(tab) { return document.getElementById(tab.getAttribute('aria-controls')); }

  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      var p = panelOf(t);
      if (p) p.hidden = !on;
    });
    if (focus) tab.focus();
    var name = tab.id.replace(/^tab-/, '');
    if (location.hash.slice(1) !== name) {
      history.replaceState(null, '', '#' + name);
    }
    /* let a panel lazily build itself the first time it becomes visible */
    document.dispatchEvent(new CustomEvent('tabshown', { detail: { tab: name } }));
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { select(t, false); });
    t.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(t), n = tabs.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); select(tabs[(i + 1) % n], true);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); select(tabs[(i - 1 + n) % n], true);
      } else if (e.key === 'Home') {
        e.preventDefault(); select(tabs[0], true);
      } else if (e.key === 'End') {
        e.preventDefault(); select(tabs[n - 1], true);
      }
    });
  });

  var fromHash = document.getElementById('tab-' + location.hash.slice(1));
  select(tabs.indexOf(fromHash) >= 0 ? fromHash : tabs[0], false);

  window.addEventListener('hashchange', function () {
    var t = document.getElementById('tab-' + location.hash.slice(1));
    if (tabs.indexOf(t) >= 0) select(t, false);
  });
})();
