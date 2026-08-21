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

  function buildSlideSection(slide) {
    const section = document.createElement("section");

    if (slide.type === "title") {
      const h1 = document.createElement("h1");
      h1.textContent = slide.heading || "";
      section.appendChild(h1);
      if (slide.subheading) {
        const h3 = document.createElement("h3");
        h3.textContent = slide.subheading;
        section.appendChild(h3);
      }
    } else if (slide.type === "section") {
      const h2 = document.createElement("h2");
      h2.textContent = slide.heading || "";
      section.appendChild(h2);
    } else {
      const h2 = document.createElement("h2");
      h2.textContent = slide.heading || "";
      section.appendChild(h2);

      if (Array.isArray(slide.bullets) && slide.bullets.length) {
        const ul = document.createElement("ul");
        slide.bullets.forEach((b) => {
          const li = document.createElement("li");
          li.textContent = b;
          ul.appendChild(li);
        });
        section.appendChild(ul);
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

  function renderPreview() {
    slidesContainer.innerHTML = "";
    deck.slides.forEach((slide) => {
      slidesContainer.appendChild(buildSlideSection(slide));
    });

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

    deck.slides.forEach((slide) => {
      const pSlide = pptx.addSlide();

      if (slide.type === "title") {
        pSlide.addText(slide.heading || "", {
          x: 0.5,
          y: 2.6,
          w: 12.33,
          h: 1.5,
          align: "center",
          fontSize: 40,
          bold: true,
        });
        if (slide.subheading) {
          pSlide.addText(slide.subheading, {
            x: 0.5,
            y: 4.1,
            w: 12.33,
            h: 0.8,
            align: "center",
            fontSize: 20,
            color: "666666",
          });
        }
      } else if (slide.type === "section") {
        pSlide.background = { color: "4F46E5" };
        pSlide.addText(slide.heading || "", {
          x: 0.5,
          y: 3.0,
          w: 12.33,
          h: 1.5,
          align: "center",
          fontSize: 34,
          bold: true,
          color: "FFFFFF",
        });
      } else {
        pSlide.addText(slide.heading || "", {
          x: 0.5,
          y: 0.4,
          w: 12.33,
          h: 0.9,
          fontSize: 28,
          bold: true,
        });

        if (Array.isArray(slide.bullets) && slide.bullets.length) {
          const bulletItems = slide.bullets
            .filter((b) => b && b.trim())
            .map((b) => ({ text: b, options: { bullet: true, breakLine: true } }));
          pSlide.addText(bulletItems, {
            x: 0.7,
            y: 1.5,
            w: 11.9,
            h: 5.3,
            fontSize: 18,
            valign: "top",
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
