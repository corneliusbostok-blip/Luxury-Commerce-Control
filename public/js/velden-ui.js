(function () {
  var header = document.querySelector(".site-header");
  var toggle = document.querySelector("[data-menu-toggle]");
  var navWrap = document.querySelector(".nav-wrap");

  function onScroll() {
    if (!header) return;
    if (window.scrollY > 24) header.classList.add("is-scrolled");
    else header.classList.remove("is-scrolled");
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (toggle && navWrap) {
    toggle.addEventListener("click", function () {
      var open = navWrap.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navWrap.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        navWrap.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Keep dashboard link deterministic across overlays/theme tweaks.
  var dashLink = document.querySelector("[data-nav-dashboard]");
  if (dashLink) {
    dashLink.addEventListener("click", function (e) {
      e.preventDefault();
      window.location.assign("/admin");
    });
  }

  function updateCartBadge() {
    var n = window.VeldenCart ? window.VeldenCart.countItems() : 0;
    document.querySelectorAll("[data-cart-count]").forEach(function (el) {
      el.textContent = n > 0 ? String(n) : "";
      el.setAttribute("data-empty", n ? "0" : "1");
    });
  }

  window.addEventListener("velden-cart", updateCartBadge);
  document.addEventListener("DOMContentLoaded", updateCartBadge);

  document.querySelectorAll("[data-reveal]").forEach(function (el) {
    el.classList.add("reveal");
  });

  if ("IntersectionObserver" in window) {
    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("is-visible");
            obs.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      obs.observe(el);
    });
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      el.classList.add("is-visible");
    });
  }
})();
