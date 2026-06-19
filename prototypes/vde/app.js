(function () {
  const root = document.documentElement;
  const shell = document.querySelector(".prototype-shell");
  const densityLabel = document.querySelector(".density-chip");
  const densities = ["comfortable", "compact", "ultra"];

  function setScreen(screen) {
    shell.dataset.screen = screen;
    shell.classList.toggle("palette-open", screen === "C");

    if (screen === "E") {
      root.dataset.theme = "light";
    } else if (screen === "A" || screen === "C" || screen === "D" || screen === "F") {
      root.dataset.theme = "dark";
    }

    document.querySelectorAll("[data-screen-target]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.screenTarget === screen);
    });
  }

  function cycleDensity() {
    const current = root.dataset.density || "compact";
    const next = densities[(densities.indexOf(current) + 1) % densities.length];
    root.dataset.density = next;
    densityLabel.textContent = next[0].toUpperCase() + next.slice(1);
  }

  function toggleTheme() {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  }

  function togglePalette(force) {
    const shouldOpen = typeof force === "boolean" ? force : !shell.classList.contains("palette-open");
    shell.classList.toggle("palette-open", shouldOpen);
    if (shouldOpen) {
      document.querySelector(".palette-input input").focus();
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.screenTarget) {
      setScreen(button.dataset.screenTarget);
      return;
    }

    switch (button.dataset.action) {
      case "theme":
        toggleTheme();
        break;
      case "density":
        cycleDensity();
        break;
      case "sidebar":
        shell.classList.toggle("sidebar-collapsed");
        break;
      case "terminal":
        shell.classList.toggle("terminal-collapsed");
        break;
      case "ai":
        shell.classList.toggle("ai-collapsed");
        break;
      case "palette":
        togglePalette();
        break;
      default:
        break;
    }
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const isMacCmd = event.metaKey;

    if (event.key === "Escape") {
      if (shell.dataset.screen === "F") {
        setScreen("A");
      } else {
        togglePalette(false);
      }
      return;
    }

    if (isMacCmd && event.shiftKey && key === "p") {
      event.preventDefault();
      setScreen("C");
    }

    if (isMacCmd && key === "k") {
      event.preventDefault();
      togglePalette(true);
    }

    if (isMacCmd && key === "b") {
      event.preventDefault();
      shell.classList.toggle("sidebar-collapsed");
    }

    if (isMacCmd && key === "i") {
      event.preventDefault();
      shell.classList.toggle("ai-collapsed");
    }

    if (event.ctrlKey && event.key === "`") {
      event.preventDefault();
      shell.classList.toggle("terminal-collapsed");
    }

    if (isMacCmd && key === ".") {
      event.preventDefault();
      cycleDensity();
    }
  });

  document.querySelector(".palette-overlay").addEventListener("click", (event) => {
    if (event.target.classList.contains("palette-overlay")) {
      togglePalette(false);
    }
  });

  setScreen("A");
})();
