(function () {
  "use strict";

  const FUNCTION_URL = "/.netlify/functions/generate-slides";
  const LOADING_MESSAGES = [
    "Thinking of a great deck...",
    "Outlining your slides...",
    "Writing bullet points...",
    "Polishing the wording...",
  ];

  const formView = document.getElementById("form-view");
  const loadingView = document.getElementById("loading-view");
  const resultView = document.getElementById("result-view");
  const errorView = document.getElementById("error-view");

  const deckForm = document.getElementById("deck-form");
  const topicInput = document.getElementById("topic");
  const audienceInput = document.getElementById("audience");
  const requirementsInput = document.getElementById("requirements");
  const toneSelect = document.getElementById("tone");
  const slideCountInput = document.getElementById("slideCount");
  const slideCountLabel = document.getElementById("slideCountLabel");
  const formError = document.getElementById("form-error");
  const generateBtn = document.getElementById("generate-btn");
  const loadingText = document.getElementById("loading-text");

  const slidesContainer = document.getElementById("slides-container");
  const editList = document.getElementById("edit-list");
  const backBtn = document.getElementById("back-btn");
  const downloadBtn = document.getElementById("download-btn");

  const errorText = document.getElementById("error-text");
  const errorRetryBtn = document.getElementById("error-retry-btn");

  // ---- Dark/light theme toggle ----
  // The inline script in <head> already applied any saved preference before
  // first paint (to avoid a flash) - this just wires up the button and keeps
  // it in sync with that state and the system preference.

  const themeToggle = document.getElementById("theme-toggle");
  const prefersDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function currentIsDark() {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark") return true;
    if (explicit === "light") return false;
    return prefersDarkQuery.matches;
  }

  function updateToggleButton() {
    const isDark = currentIsDark();
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }

  themeToggle.addEventListener("click", () => {
    const next = currentIsDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("app-theme", next);
    } catch {
      // Storage can be unavailable (private browsing, disabled cookies) -
      // the toggle still works for this page view, it just won't persist.
    }
    updateToggleButton();
  });

  prefersDarkQuery.addEventListener("change", () => {
    if (!document.documentElement.getAttribute("data-theme")) updateToggleButton();
  });

  updateToggleButton();

  let deck = null; // { title, slides: [...] }
  let revealDeck = null;
  let loadingInterval = null;

  function showView(view) {
    [formView, loadingView, resultView, errorView].forEach((v) => {
      v.hidden = v !== view;
    });
  }

  slideCountInput.addEventListener("input", () => {
    slideCountLabel.textContent = slideCountInput.value;
  });

  deckForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.hidden = true;

    const topic = topicInput.value.trim();
    if (!topic) {
      formError.textContent = "Please describe what your presentation is about.";
      formError.hidden = false;
      return;
    }

    const payload = {
      topic,
      audience: audienceInput.value.trim(),
      requirements: requirementsInput.value.trim(),
      tone: toneSelect.value,
      slideCount: Number.parseInt(slideCountInput.value, 10),
    };

    startLoading();

    try {
      const res = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("The server sent back something unexpected. Please try again.");
      }

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong generating your slides.");
      }

      if (!data || !Array.isArray(data.slides) || data.slides.length === 0) {
        throw new Error("The AI response didn't contain any slides. Please try again.");
      }

      deck = data;
      stopLoading();
      // Reveal.js measures its container's real size at init time, so it must
      // already be visible (not [hidden]) before renderResult() initializes it.
      showView(resultView);
      renderResult();
    } catch (err) {
      stopLoading();
      showError(
        err && err.message
          ? err.message
          : "Network error - please check your connection and try again."
      );
    }
  });

  function startLoading() {
    generateBtn.disabled = true;
    showView(loadingView);
    let i = 0;
    loadingText.textContent = LOADING_MESSAGES[0];
    loadingInterval = setInterval(() => {
      i = (i + 1) % LOADING_MESSAGES.length;
      loadingText.textContent = LOADING_MESSAGES[i];
    }, 2200);
  }

  function stopLoading() {
    generateBtn.disabled = false;
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
  }

  function showError(message) {
    errorText.textContent = message;
    showView(errorView);
  }

  errorRetryBtn.addEventListener("click", () => {
    showView(formView);
  });

  backBtn.addEventListener("click", () => {
    deck = null;
    showView(formView);
  });

  // ---- Rendering the reveal.js preview (DOM built via textContent - no innerHTML of AI text) ----

  const DEFAULT_THEME = { primaryColor: "#1F2937", accentColor: "#4F46E5" };

  function headingText(slide) {
    return slide.icon ? `${slide.icon} ${slide.heading || ""}` : slide.heading || "";
  }

  // Mixes a hex color toward white - used for a light card background that
  // stays readable under dark text regardless of how saturated accentColor is,
  // since it's only ever moving *toward* white, never away from it. Returns a
  // hex string (not rgb()) so the same value works as both a CSS color and a
  // PptxGenJS fill color.
  function lightenHex(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const mix = (c) => Math.round(c + (255 - c) * amount);
    const toHex = (c) => c.toString(16).padStart(2, "0");
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
  }

  function buildSlideSection(slide) {
    const section = document.createElement("section");
    const theme = (deck && deck.theme) || DEFAULT_THEME;

    if (slide.type === "title" || slide.type === "section" || slide.type === "quote") {
      // reveal.js's own per-slide background layer, not a plain CSS background -
      // it stays correctly positioned through reveal's scale/transform wrapper.
      section.setAttribute("data-background-color", theme.accentColor);
    }

    if (slide.type === "content") {
      // A full-height edge stripe rather than a positioned overlay div - simple
      // box-model properties transform correctly with reveal's scaling, and
      // this avoids repeating the display/font-size interaction found earlier.
      section.style.borderLeft = `0.1em solid ${theme.accentColor}`;
      section.style.paddingLeft = "0.6em";
    }

    if (slide.type === "title") {
      const h1 = document.createElement("h1");
      h1.textContent = headingText(slide);
      h1.style.color = "#FFFFFF";
      section.appendChild(h1);
      if (slide.subheading) {
        const h3 = document.createElement("h3");
        h3.textContent = slide.subheading;
        h3.style.color = "#FFFFFF";
        section.appendChild(h3);
      }
    } else if (slide.type === "section") {
      const h2 = document.createElement("h2");
      h2.textContent = headingText(slide);
      h2.style.color = "#FFFFFF";
      section.appendChild(h2);
    } else if (slide.type === "stat") {
      const label = document.createElement("div");
      label.textContent = headingText(slide);
      label.style.color = theme.primaryColor;
      label.style.fontSize = "0.6em";
      label.style.fontWeight = "600";
      label.style.textTransform = "uppercase";
      label.style.letterSpacing = "0.08em";
      section.appendChild(label);

      const value = document.createElement("div");
      value.textContent = slide.statValue || "";
      value.style.color = theme.accentColor;
      value.style.fontFamily = "'Poppins', sans-serif";
      value.style.fontWeight = "700";
      value.style.fontSize = "2.4em";
      value.style.lineHeight = "1.1";
      value.style.margin = "0.15em 0";
      section.appendChild(value);

      // Gemini sometimes puts this supporting text under "subheading" despite
      // the prompt naming "statLabel" explicitly - fall back rather than lose it.
      const statLabelText = slide.statLabel || slide.subheading;
      if (statLabelText) {
        const statLabel = document.createElement("div");
        statLabel.textContent = statLabelText;
        statLabel.style.fontSize = "0.75em";
        statLabel.style.maxWidth = "20em";
        statLabel.style.marginLeft = "auto";
        statLabel.style.marginRight = "auto";
        section.appendChild(statLabel);
      }
    } else if (slide.type === "quote") {
      const mark = document.createElement("div");
      mark.textContent = "“";
      mark.style.fontFamily = "'Poppins', sans-serif";
      mark.style.fontSize = "2.5em";
      mark.style.color = "#FFFFFF";
      mark.style.opacity = "0.6";
      mark.style.lineHeight = "0.5";
      section.appendChild(mark);

      const quote = document.createElement("div");
      quote.textContent = slide.quoteText || "";
      quote.style.color = "#FFFFFF";
      quote.style.fontStyle = "italic";
      quote.style.fontSize = "1.15em";
      quote.style.maxWidth = "24em";
      quote.style.marginLeft = "auto";
      quote.style.marginRight = "auto";
      section.appendChild(quote);

      // Same "subheading" fallback as the stat layout above.
      const attributionText = slide.quoteAttribution || slide.subheading;
      if (attributionText) {
        const attribution = document.createElement("div");
        attribution.textContent = `— ${attributionText}`;
        attribution.style.color = "#FFFFFF";
        attribution.style.opacity = "0.85";
        attribution.style.fontSize = "0.7em";
        attribution.style.marginTop = "0.6em";
        section.appendChild(attribution);
      }
    } else {
      const h2 = document.createElement("h2");
      h2.textContent = headingText(slide);
      h2.style.color = theme.primaryColor;
      section.appendChild(h2);

      // A separate fixed-size bar rather than a border on the heading itself -
      // giving the h2 a non-default display type broke reveal.js's own
      // responsive font-size calculation and shrank the heading drastically.
      const accentBar = document.createElement("div");
      accentBar.style.width = "3em";
      accentBar.style.height = "0.08em";
      accentBar.style.background = theme.accentColor;
      accentBar.style.margin = "0.2em 0 0.5em";
      section.appendChild(accentBar);

      if (Array.isArray(slide.bullets) && slide.bullets.length) {
        const bulletsWrap = document.createElement("div");
        bulletsWrap.style.textAlign = "left";
        bulletsWrap.style.maxWidth = "26em";
        bulletsWrap.style.marginLeft = "auto";
        bulletsWrap.style.marginRight = "auto";

        slide.bullets.forEach((b) => {
          const chip = document.createElement("div");
          chip.style.display = "flex";
          chip.style.alignItems = "flex-start";
          chip.style.gap = "0.5em";
          chip.style.background = lightenHex(theme.accentColor, 0.9);
          chip.style.borderRadius = "0.4em";
          chip.style.padding = "0.4em 0.7em";
          chip.style.marginBottom = "0.35em";
          chip.style.fontSize = "0.75em";

          const dot = document.createElement("span");
          dot.textContent = "●";
          dot.style.color = theme.accentColor;
          dot.style.fontSize = "0.6em";
          dot.style.marginTop = "0.4em";
          dot.style.flexShrink = "0";

          const text = document.createElement("span");
          text.textContent = b;

          chip.appendChild(dot);
          chip.appendChild(text);
          bulletsWrap.appendChild(chip);
        });

        section.appendChild(bulletsWrap);
      }
    }

    if (slide.notes) {
      const aside = document.createElement("aside");
      aside.className = "notes";
      aside.textContent = slide.notes;
      section.appendChild(aside);
    }

    return section;
  }

  function applyThemeStyle() {
    const theme = (deck && deck.theme) || DEFAULT_THEME;
    const styleTag = document.getElementById("theme-style");
    // textContent, not innerHTML - even if a color value were ever malformed,
    // this can only produce invalid/ignored CSS, never executable markup.
    styleTag.textContent = `
      .reveal .progress { color: ${theme.accentColor}; }
    `;
  }

  function renderPreview() {
    slidesContainer.innerHTML = "";
    deck.slides.forEach((slide) => {
      slidesContainer.appendChild(buildSlideSection(slide));
    });
    applyThemeStyle();

    if (revealDeck) {
      revealDeck.sync();
      revealDeck.layout();
    } else {
      revealDeck = new Reveal(document.querySelector(".reveal"), {
        embedded: true,
        controls: true,
        progress: true,
        hash: false,
        keyboard: true,
        // Leave width/height at reveal's defaults (960x700 logical canvas) so
        // it auto-scales via CSS transform to fit the actual container size -
        // passing "100%" here disables that scaling and text overflows.
      });
      revealDeck.initialize();
    }
  }

  // ---- Editable slide list ----

  function renderEditList() {
    editList.innerHTML = "";
    const list = document.createElement("div");
    list.className = "edit-list";

    deck.slides.forEach((slide, index) => {
      list.appendChild(buildEditCard(slide, index));
    });

    editList.appendChild(list);
  }

  function buildEditCard(slide, index) {
    const card = document.createElement("div");
    card.className = "edit-slide";

    const label = document.createElement("div");
    label.className = "edit-slide-label";
    const labelText = document.createElement("span");
    labelText.textContent = `Slide ${index + 1} - ${slide.type}`;
    label.appendChild(labelText);
    card.appendChild(label);

    const headingInput = document.createElement("input");
    headingInput.type = "text";
    headingInput.value = slide.heading || "";
    headingInput.placeholder = "Heading";
    headingInput.addEventListener("input", () => {
      slide.heading = headingInput.value;
      renderPreview();
    });
    card.appendChild(headingInput);

    if (slide.type === "title") {
      const subInput = document.createElement("input");
      subInput.type = "text";
      subInput.value = slide.subheading || "";
      subInput.placeholder = "Subheading (optional)";
      subInput.addEventListener("input", () => {
        slide.subheading = subInput.value;
        renderPreview();
      });
      card.appendChild(subInput);
    }

    if (slide.type === "stat") {
      const valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.value = slide.statValue || "";
      valueInput.placeholder = "Stat value (e.g. 87%)";
      valueInput.addEventListener("input", () => {
        slide.statValue = valueInput.value;
        renderPreview();
      });
      card.appendChild(valueInput);

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      // Gemini sometimes returns this under "subheading" instead - see the
      // matching fallback in buildSlideSection/exportPptx.
      labelInput.value = slide.statLabel || slide.subheading || "";
      labelInput.placeholder = "Stat label";
      labelInput.addEventListener("input", () => {
        slide.statLabel = labelInput.value;
        renderPreview();
      });
      card.appendChild(labelInput);
    }

    if (slide.type === "quote") {
      const quoteInput = document.createElement("textarea");
      quoteInput.rows = 2;
      quoteInput.value = slide.quoteText || "";
      quoteInput.placeholder = "Quote text";
      quoteInput.addEventListener("input", () => {
        slide.quoteText = quoteInput.value;
        renderPreview();
      });
      card.appendChild(quoteInput);

      const attributionInput = document.createElement("input");
      attributionInput.type = "text";
      attributionInput.value = slide.quoteAttribution || slide.subheading || "";
      attributionInput.placeholder = "Attribution (optional)";
      attributionInput.addEventListener("input", () => {
        slide.quoteAttribution = attributionInput.value;
        renderPreview();
      });
      card.appendChild(attributionInput);
    }

    if (slide.type === "content") {
      if (!Array.isArray(slide.bullets)) slide.bullets = [];
      const bulletsWrap = document.createElement("div");
      bulletsWrap.className = "bullets-wrap";

      function renderBullets() {
        bulletsWrap.innerHTML = "";
        slide.bullets.forEach((bullet, bIndex) => {
          const row = document.createElement("div");
          row.className = "edit-bullet-row";

          const input = document.createElement("input");
          input.type = "text";
          input.value = bullet;
          input.addEventListener("input", () => {
            slide.bullets[bIndex] = input.value;
            renderPreview();
          });
          row.appendChild(input);

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "remove-bullet-btn";
          removeBtn.textContent = "−";
          removeBtn.setAttribute("aria-label", "Remove bullet");
          removeBtn.addEventListener("click", () => {
            slide.bullets.splice(bIndex, 1);
            renderBullets();
            renderPreview();
          });
          row.appendChild(removeBtn);

          bulletsWrap.appendChild(row);
        });
      }

      renderBullets();
      card.appendChild(bulletsWrap);

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "add-bullet-btn";
      addBtn.textContent = "+ Add bullet";
      addBtn.addEventListener("click", () => {
        slide.bullets.push("");
        renderBullets();
        renderPreview();
      });
      card.appendChild(addBtn);
    }

    return card;
  }

  function renderResult() {
    renderPreview();
    renderEditList();
  }

  // ---- PPTX export ----

  downloadBtn.addEventListener("click", () => {
    if (!deck) return;
    try {
      exportPptx(deck);
    } catch (err) {
      showError("Could not build the .pptx file. Please try again.");
    }
  });

  function exportPptx(deck) {
    const pptx = new window.PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
    pptx.layout = "WIDE";

    const theme = deck.theme || DEFAULT_THEME;
    const primaryHex = theme.primaryColor.replace("#", "");
    const accentHex = theme.accentColor.replace("#", "");

    deck.slides.forEach((slide) => {
      const pSlide = pptx.addSlide();
      const heading = headingText(slide);

      if (slide.type === "title") {
        pSlide.background = { color: accentHex };
        pSlide.addText(heading, {
          x: 0.5,
          y: 2.6,
          w: 12.33,
          h: 1.5,
          align: "center",
          fontSize: 40,
          bold: true,
          color: "FFFFFF",
          fontFace: "Poppins",
        });
        if (slide.subheading) {
          pSlide.addText(slide.subheading, {
            x: 0.5,
            y: 4.1,
            w: 12.33,
            h: 0.8,
            align: "center",
            fontSize: 20,
            color: "FFFFFF",
            fontFace: "Inter",
          });
        }
      } else if (slide.type === "section") {
        pSlide.background = { color: accentHex };
        pSlide.addText(heading, {
          x: 0.5,
          y: 3.0,
          w: 12.33,
          h: 1.5,
          align: "center",
          fontSize: 34,
          bold: true,
          color: "FFFFFF",
          fontFace: "Poppins",
        });
      } else if (slide.type === "stat") {
        pSlide.addText(heading, {
          x: 0.5,
          y: 1.8,
          w: 12.33,
          h: 0.6,
          align: "center",
          fontSize: 16,
          bold: true,
          color: primaryHex,
          fontFace: "Inter",
          charSpacing: 2,
        });
        pSlide.addText(slide.statValue || "", {
          x: 0.5,
          y: 2.5,
          w: 12.33,
          h: 1.8,
          align: "center",
          fontSize: 72,
          bold: true,
          color: accentHex,
          fontFace: "Poppins",
        });
        const statLabelText = slide.statLabel || slide.subheading;
        if (statLabelText) {
          pSlide.addText(statLabelText, {
            x: 2.67,
            y: 4.5,
            w: 8,
            h: 1,
            align: "center",
            fontSize: 18,
            color: "374151",
            fontFace: "Inter",
          });
        }
      } else if (slide.type === "quote") {
        pSlide.background = { color: accentHex };
        pSlide.addText(slide.quoteText || "", {
          x: 1.67,
          y: 2.4,
          w: 10,
          h: 2.2,
          align: "center",
          valign: "middle",
          italic: true,
          fontSize: 28,
          color: "FFFFFF",
          fontFace: "Inter",
        });
        const attributionText = slide.quoteAttribution || slide.subheading;
        if (attributionText) {
          pSlide.addText(`— ${attributionText}`, {
            x: 1.67,
            y: 4.7,
            w: 10,
            h: 0.6,
            align: "center",
            fontSize: 16,
            color: "FFFFFF",
            fontFace: "Inter",
          });
        }
      } else {
        // Full-height edge stripe, matching the reveal.js preview's left border.
        pSlide.addShape(pptx.ShapeType.rect, {
          x: 0,
          y: 0,
          w: 0.12,
          h: 7.5,
          fill: { color: accentHex },
          line: { color: accentHex },
        });
        pSlide.addText(heading, {
          x: 0.6,
          y: 0.4,
          w: 12.23,
          h: 0.9,
          fontSize: 28,
          bold: true,
          color: primaryHex,
          fontFace: "Poppins",
        });
        pSlide.addShape(pptx.ShapeType.rect, {
          x: 0.6,
          y: 1.25,
          w: 2.2,
          h: 0.06,
          fill: { color: accentHex },
          line: { color: accentHex },
        });

        if (Array.isArray(slide.bullets) && slide.bullets.length) {
          const validBullets = slide.bullets.filter((b) => b && b.trim());
          // A single card panel behind the whole list, rather than one shape
          // per bullet - keeps the export simple while still giving the list
          // a visually distinct, structured block instead of bare text.
          pSlide.addShape(pptx.ShapeType.roundRect, {
            x: 0.6,
            y: 1.6,
            w: 11.8,
            h: Math.min(5.2, 0.6 + validBullets.length * 0.75),
            fill: { color: lightenHex(theme.accentColor, 0.92) },
            line: { color: lightenHex(theme.accentColor, 0.92) },
            rectRadius: 0.1,
          });
          const bulletItems = validBullets.map((b) => ({
            text: b,
            // PptxGenJS bullets don't support a marker-only color separate
            // from the text - accepting a plain dark bullet+text here.
            options: { bullet: { characterCode: "25CF" }, breakLine: true },
          }));
          pSlide.addText(bulletItems, {
            x: 0.9,
            y: 1.8,
            w: 11.2,
            h: Math.min(4.8, 0.4 + validBullets.length * 0.75),
            fontSize: 18,
            valign: "top",
            fontFace: "Inter",
          });
        }
      }

      if (slide.notes) {
        pSlide.addNotes(slide.notes);
      }
    });

    const fileName = (deck.title || "presentation").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "presentation";
    pptx.writeFile({ fileName: `${fileName}.pptx` });
  }
})();
