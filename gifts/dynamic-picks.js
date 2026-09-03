// Shared: on any /gifts/[category].html page, look for an element with
// data-category. If present, call the Supabase RPC to fetch the top items
// aggregated across all public Tenner lists for that category. If the RPC
// returns >= 30 lists worth of data, replace the hardcoded picks with the
// live aggregated items. Otherwise leave the hardcoded fallback in place.
//
// Also mounts a budget filter pill row above the picks. Selecting pills
// rewrites all shop links in the picks-container with an Amazon price
// refinement (rh=p_36:MIN-MAX). Same behavior as the old in-app version.
(function() {
  var SUPABASE_URL = 'https://bbjpvlmkhvggtwyvpzrq.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_jeeTdNoqIJXBtx_1W1TscQ_cnRAcwHx';

  // ── Shop-click tracking (delegated) ─────────────────────────────────
  // One handler catches clicks on ANY <a class="shop"> anchor on the page,
  // whether it was rendered dynamically or lives in the static HTML fallback.
  // Fires a fire-and-forget INSERT into shop_clicks. Never blocks navigation.
  function getUrlParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch(e) { return null; }
  }
  var _clickSb = null;
  function ensureSb() {
    if (_clickSb) return _clickSb;
    if (typeof supabase === 'undefined') return null;
    try { _clickSb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch(e) {}
    return _clickSb;
  }
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a.shop');
    if (!a) return;
    var url = a.getAttribute('href') || '';
    try {
      var sb = ensureSb();
      if (!sb) return;
      var pathCat = window.location.pathname.replace(/^\/gifts\//,'').replace(/\.html$/,'').replace(/[-_]/g,' ');
      var itemGuess = (a.previousElementSibling && a.previousElementSibling.querySelector) ? (a.previousElementSibling.querySelector('.title')||{}).textContent : null;
      var row = {
        user_id: null,
        from_user_id: getUrlParam('from') || null,
        category: pathCat || null,
        query: itemGuess || null,
        item: itemGuess || null,
        url: url,
        source: 'gifts-hub',
        referer: document.referrer || null,
        user_agent: navigator.userAgent || null
      };
      sb.from('shop_clicks').insert(row).then(function(){}, function(){});
    } catch(err) { /* silent */ }
  }, { capture: true });

  // ── Budget filter (multi-select contiguous range) ──────────────────
  var BUCKETS = [
    { key: 'u25',    label: 'Under $25', minCents: 0,     maxCents: 2500 },
    { key: '25-50',  label: '$25–$50',   minCents: 2500,  maxCents: 5000 },
    { key: '50-100', label: '$50–$100',  minCents: 5000,  maxCents: 10000 },
    { key: '100+',   label: '$100+',     minCents: 10000, maxCents: null }
  ];
  var budgetRange = null; // { lowIdx, highIdx } or null (= Any)

  function budgetRh() {
    if (!budgetRange) return '';
    var last = BUCKETS.length - 1;
    if (budgetRange.lowIdx === 0 && budgetRange.highIdx === last) return '';
    var lo = BUCKETS[budgetRange.lowIdx];
    var hi = BUCKETS[budgetRange.highIdx];
    var minStr = lo.minCents > 0 ? String(lo.minCents) : '';
    var maxStr = hi.maxCents != null ? String(hi.maxCents) : '';
    return 'p_36:' + minStr + '-' + maxStr;
  }

  function toggleBucket(idx) {
    var r = budgetRange;
    if (!r) { budgetRange = { lowIdx: idx, highIdx: idx }; }
    else if (idx < r.lowIdx) { r.lowIdx = idx; }
    else if (idx > r.highIdx) { r.highIdx = idx; }
    else if (r.lowIdx === r.highIdx && idx === r.lowIdx) { budgetRange = null; }
    else if (idx === r.lowIdx) { r.lowIdx = idx + 1; }
    else if (idx === r.highIdx) { r.highIdx = idx - 1; }
    renderBudgetPills();
    rewriteShopUrls();
  }

  function clearBudget() { budgetRange = null; renderBudgetPills(); rewriteShopUrls(); }

  function renderBudgetPills() {
    var host = document.getElementById('budget-pills-host');
    if (!host) return;
    var anyActive = !budgetRange;
    var pillStyleBase = 'font-family:inherit;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;font-weight:600;border:1px solid #D3D1C7;background:#FFF;color:#2C2C2A';
    var pillStyleActive = 'font-family:inherit;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;font-weight:600;border:1px solid #2C2C2A;background:#2C2C2A;color:#FFF';
    var html = '<button type="button" style="' + (anyActive ? pillStyleActive : pillStyleBase) + '" onclick="window.__tennerClearBudget()">Any</button>';
    html += BUCKETS.map(function(b, i) {
      var active = budgetRange && i >= budgetRange.lowIdx && i <= budgetRange.highIdx;
      return '<button type="button" style="' + (active ? pillStyleActive : pillStyleBase) + '" onclick="window.__tennerToggleBucket(' + i + ')">' + b.label + '</button>';
    }).join('');
    host.innerHTML = html;
  }

  window.__tennerToggleBucket = toggleBucket;
  window.__tennerClearBudget = clearBudget;

  // Rewrite all shop link hrefs by parsing the base URL and appending the
  // current budget filter. Preserves the item search keywords + affiliate tag.
  function rewriteShopUrls() {
    var container = document.getElementById('picks-container');
    if (!container) return;
    var rh = budgetRh();
    container.querySelectorAll('a.shop').forEach(function(a) {
      var base = a.getAttribute('data-base-href') || a.getAttribute('href');
      if (!a.hasAttribute('data-base-href')) a.setAttribute('data-base-href', base);
      // Strip any existing rh=... param from base
      var url;
      try { url = new URL(base); }
      catch(e) { return; }
      url.searchParams.delete('rh');
      if (rh) url.searchParams.set('rh', rh);
      a.setAttribute('href', url.toString());
    });
  }

  function mountBudgetPills() {
    // Find the picks-container and insert the pill row above it
    var container = document.getElementById('picks-container');
    if (!container) return;
    if (document.getElementById('budget-pills-host')) return;
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-bottom:16px';
    wrapper.innerHTML = '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888780;font-weight:700;margin-bottom:8px;text-align:center">Budget</div>'
      + '<div id="budget-pills-host" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center"></div>';
    container.parentNode.insertBefore(wrapper, container);
    renderBudgetPills();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function amazonUrl(item, suffix) {
    var q = String(item) + (suffix ? (' ' + suffix) : ' gift ideas');
    return 'https://www.amazon.com/s?k=' + encodeURIComponent(q.trim()).replace(/%20/g, '+') + '&tag=tenner09-20';
  }

  function renderPicks(container, items, suffix) {
    container.innerHTML = items.map(function(entry, i) {
      var name = entry.item;
      var count = entry.count;
      return '<div class="pick"><div class="rank">' + (i + 1) + '</div>'
        + '<div class="body">'
        +   '<div class="title">' + escapeHtml(name) + '</div>'
        +   '<div class="desc">Chosen by ' + count + ' Tenner user' + (count === 1 ? '' : 's') + '. Tap Shop to see gift ideas built around this pick.</div>'
        + '</div>'
        + '<a class="shop" href="' + amazonUrl(name, suffix) + '" target="_blank" rel="noopener sponsored nofollow">Shop →</a>'
        + '</div>';
    }).join('');
  }

  async function boot() {
    var container = document.getElementById('picks-container');
    if (!container) return;
    var category = container.getAttribute('data-category');
    var suffix = container.getAttribute('data-suffix') || '';
    mountBudgetPills();
    rewriteShopUrls();
    if (!category || typeof supabase === 'undefined') return;

    var srcTag = document.getElementById('dynamic-source');
    try {
      var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      var res = await sb.rpc('get_top_items_for_category', { cat: category, max_items: 12, min_lists: 30 });
      if (res.error || !res.data) {
        if (srcTag) srcTag.style.display = 'none';
        return;
      }
      var items = res.data.items;
      var totalLists = res.data.total_lists || 0;
      if (Array.isArray(items) && items.length > 0) {
        renderPicks(container, items, suffix);
        rewriteShopUrls();
        if (srcTag) {
          srcTag.textContent = '✨ These picks are live — ranked by ' + totalLists + ' Tenner ' + (totalLists === 1 ? 'list' : 'lists') + ' in this category.';
          srcTag.style.display = 'block';
        }
      } else {
        // Below threshold — keep hardcoded picks, hide loading indicator
        if (srcTag) srcTag.style.display = 'none';
      }
    } catch(e) {
      console.warn('Dynamic picks failed', e);
      if (srcTag) srcTag.style.display = 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
