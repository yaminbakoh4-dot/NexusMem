// scroll-reveal (progressive enhancement: only hide .reveal elements if JS + IntersectionObserver run)
if ("IntersectionObserver" in window) {
  document.documentElement.classList.add("js-reveal");

  const revealEls = document.querySelectorAll(".reveal");

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealEls.forEach((el) => revealObserver.observe(el));

  // Safety net: if the observer never fires for some reason (older browsers,
  // unusual embedding contexts), don't leave content permanently invisible.
  setTimeout(() => {
    revealEls.forEach((el) => el.classList.add("is-visible"));
    revealObserver.disconnect();
  }, 2000);
}

// nav scroll-spy: highlight the link for whichever section is in view
const spySections = document.querySelectorAll("main section[id]");
const spyLinks = document.querySelectorAll(".nav-links a[href^='#']");

if (spySections.length && spyLinks.length && "IntersectionObserver" in window) {
  const spyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.getAttribute("id");
        spyLinks.forEach((link) => {
          link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
        });
      });
    },
    { rootMargin: "-45% 0px -50% 0px" }
  );

  spySections.forEach((section) => spyObserver.observe(section));
}

// mobile nav toggle
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

function closeNav() {
  navToggle.setAttribute("aria-expanded", "false");
  navLinks.classList.remove("open");
}

function openNav() {
  navToggle.setAttribute("aria-expanded", "true");
  navLinks.classList.add("open");
}

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const isOpen = navToggle.getAttribute("aria-expanded") === "true";
    isOpen ? closeNav() : openNav();
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeNav);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNav();
  });

  document.addEventListener("click", (e) => {
    const isOpen = navToggle.getAttribute("aria-expanded") === "true";
    if (isOpen && !navLinks.contains(e.target) && !navToggle.contains(e.target)) {
      closeNav();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) closeNav();
  });
}

// copy-to-clipboard buttons
const copyStatus = document.getElementById("copyStatus");

document.querySelectorAll(".copy-btn").forEach((btn) => {
  const label = btn.querySelector(".copy-label");
  btn.addEventListener("click", async () => {
    const text = btn.getAttribute("data-copy") || "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    const original = label.textContent;
    label.textContent = "copied";
    btn.classList.add("copied");
    if (copyStatus) copyStatus.textContent = "Copied to clipboard";
    setTimeout(() => {
      label.textContent = original;
      btn.classList.remove("copied");
    }, 1500);
  });
});
